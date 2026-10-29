// Records a video's browser segments: one clip per section with page.screencast(), the overlays injected into
// every document, the redaction checked after every step, the timing log written and the clips transcoded to
// 1080p30 H.264. A dry run executes the step file without recording and reports every miss.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.mjs';
import { overlaySource, redactionMisses, pageText } from './redact.mjs';
import { castSeconds } from './cast.mjs';
import { createSteps } from './steps.mjs';
import { HALO } from './overlays/halo.mjs';
import { TOOLTIP } from './overlays/tooltip.mjs';
import { CAPTION } from './overlays/caption.mjs';
import { BLUR } from './overlays/blur.mjs';
import { H264 } from './encoder.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');
export const CAST_PORT = 4020;
export const ENCODE = ['-r', '30', '-vf', 'scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', H264, '-b:v', '12M', '-pix_fmt', 'yuv420p', '-an'];

// Runs a script once the document has a body (evaluateOnNewDocument fires before <body> exists).
export const atLoad = (src) => `(() => { const run = () => { ${src} }; if (document.body) run(); else document.addEventListener('DOMContentLoaded', run); })();`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.cast': 'application/x-asciicast', '.map': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.png': 'image/png' };
const within = (dir, file) => file.startsWith(dir + '/') && existsSync(file) && statSync(file).isFile();

// Serves the playback pages, the player bundle and the video's casts and clips on the loopback interface.
export function startCastServer(video, port = CAST_PORT) {
  const player = join(ROOT, 'node_modules', 'asciinema-player', 'dist', 'bundle');
  const casts = join(ROOT, 'videos', video, 'casts');
  const clips = join(ROOT, 'videos', video, 'clips');
  const fonts = join(ROOT, '..', 'docs', 'node_modules', '@sap-theming', 'theming-base-content', 'content', 'Base', 'baseLib', 'baseTheme', 'fonts');
  const cards = join(here, 'cards');
  const teaser = join(ROOT, 'teaser');
  const assets = join(ROOT, '..', 'docs', 'assets');
  const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    let file = null;
    if (p === '/cast.html') file = join(here, 'cast-page.html');
    else if (p === '/clip.html') file = join(here, 'clip-page.html');
    else if (p.startsWith(`/clips/${video}/`)) { const f = resolvePath(clips, '.' + p.slice(`/clips/${video}`.length)); if (within(clips, f)) file = f; }
    else if (p.startsWith('/player/')) { const f = resolvePath(player, '.' + p.slice(7)); if (within(player, f)) file = f; }
    else if (p.startsWith(`/casts/${video}/`)) { const f = resolvePath(casts, '.' + p.slice(`/casts/${video}`.length)); if (within(casts, f)) file = f; }
    else if (p.startsWith('/fonts/')) { const f = resolvePath(fonts, '.' + p.slice(6)); if (within(fonts, f)) file = f; }
    else if (p.startsWith('/cards/')) { const f = resolvePath(cards, '.' + p.slice(6)); if (within(cards, f)) file = f; }
    else if (p.startsWith('/teaser/')) { const f = resolvePath(teaser, '.' + p.slice(7)); if (within(teaser, f)) file = f; }
    else if (p.startsWith('/assets/')) { const f = resolvePath(assets, '.' + p.slice(7)); if (within(assets, f)) file = f; }
    if (!file) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', (e) => fail(new Error(e.code === 'EADDRINUSE' ? `cast server: port ${port} is already in use` : `cast server: ${e.message}`)));
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

// The redaction misses of the page text; a page read that fails twice is a miss, never a clean page. The retry
// waits a moment, so a navigation that detached the frame has settled.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function pageMisses(read, map, retryMs = 250) {
  let text;
  try { text = await read(); } catch { await sleep(retryMs); try { text = await read(); } catch { return ['page text unreadable']; } }
  return redactionMisses(text, map);
}

export function transcode(input, mp4, extra = [], before = []) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...before, '-i', input, ...ENCODE, ...extra, mp4], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${input}`);
}
// A section whose page never repaints leaves page.screencast with no frames: an empty or unreadable webm.
export const needsStill = (bytes, readable = true) => bytes < 1024 || !readable;
const readable = (file) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim() !== '';
export const probeSeconds = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout);

// name: a named step file (videos/<video>/<name>.steps.js) records into out/<video>/<name>/, its count starting at
// firstSection, and leaves the video's own clips alone.
export async function recordVideo({ video, steps, meta, map, dryRun = false, base = 'http://127.0.0.1:4010', name, firstSection = 1 }) {
  const out = name ? join(ROOT, 'out', video, name) : join(ROOT, 'out', video); const clipsDir = join(out, 'clips');
  if (!dryRun) { rmSync(clipsDir, { recursive: true, force: true }); mkdirSync(clipsDir, { recursive: true }); }
  const server = await startCastServer(video);
  let opened;
  // SAIL_DOCS_BROWSER_PROFILE: a profile directory the recorder keeps (see stack/browser-login.mjs), for sign-ins on other sites.
  try { opened = await openBrowser({ width: 1920, height: 1080, scale: 1, userDataDir: process.env.SAIL_DOCS_BROWSER_PROFILE }); } catch (e) { server.close(); throw e; }
  const { browser, page } = opened;
  for (const src of [overlaySource(map), HALO, TOOLTIP, CAPTION, BLUR]) await page.evaluateOnNewDocument(atLoad(src));
  const timing = []; const clips = []; let rec = null; let clipStart = 0; let current = 0;
  const castSecondsOf = (name) => { const f = join(ROOT, 'videos', video, 'casts', `${name}.cast`); return existsSync(f) ? castSeconds(readFileSync(f, 'utf8')) : null; };
  const castUrl = (name) => `http://127.0.0.1:${CAST_PORT}/cast.html?src=${encodeURIComponent(`/casts/${video}/${name}.cast`)}&title=${encodeURIComponent(name)}`;
  const clipFile = (name) => join(ROOT, 'videos', video, 'clips', `${name}.webm`);
  const clipSecondsOf = (name) => (existsSync(clipFile(name)) ? probeSeconds(clipFile(name)) : null);
  const clipUrl = (name, title) => `http://127.0.0.1:${CAST_PORT}/clip.html?src=${encodeURIComponent(`/clips/${video}/${name}.webm`)}&title=${encodeURIComponent(title)}`;
  const check = async () => {
    const misses = await pageMisses(() => page.evaluate(`(${pageText})(document)`), map);
    if (misses.length) throw new Error(`redaction miss in section ${current}: ${misses.join(', ')}`);
  };
  const stopClip = async () => {
    if (!rec) return;
    // the frames since the last step are checked too, but the clip is stopped whatever the check finds
    const miss = await check().then(() => null, (e) => e);
    await rec.stop(); rec = null;
    if (miss) throw miss;
    const clip = clips[clips.length - 1];
    clip.measured = (Date.now() - clipStart) / 1000;
    const bytes = existsSync(clip.webm) ? statSync(clip.webm).size : 0;
    if (needsStill(bytes, bytes > 0 && readable(clip.webm))) { clip.still = join(clipsDir, `section-${clip.section}.png`); await page.screenshot({ path: clip.still }); }
  };
  const on = async (e) => {
    if (e.event === 'section') {
      await stopClip(); current = e.n;
      const clip = { section: e.n };
      if (!dryRun) { clip.webm = join(clipsDir, `section-${e.n}.webm`); clipStart = Date.now(); rec = await page.screencast({ path: clip.webm, fps: 30 }); }
      clips.push(clip);
      timing.push({ video, section: e.n, event: `section ${e.n}`, ms_since_clip_start: 0 });
      return;
    }
    if (e.event === 'end') { await stopClip(); return; }
    if (['mark', 'caption', 'cast', 'cast-end', 'hold'].includes(e.event)) timing.push({ video, section: current, event: e.event === 'mark' ? e.label : `${e.event} ${e.text ?? e.name ?? e.ms}`, ms_since_clip_start: Date.now() - clipStart });
    if (e.event !== 'cast' && e.event !== 'cast-end') await check();
  };
  const { api, misses } = createSteps({ page, base, video, total: meta.sections.length, firstSection, castSeconds: castSecondsOf, castUrl, clipSeconds: clipSecondsOf, clipUrl, dryRun, on });
  let failure = null;
  try { await steps(api); await stopClip(); } catch (e) { failure = e; await stopClip().catch(() => {}); } finally { await browser.close(); server.close(); }
  if (failure) { if (!dryRun) rmSync(clipsDir, { recursive: true, force: true }); throw failure; }
  if (dryRun) return { misses: misses(), sections: clips.length };
  for (const c of clips) {
    c.mp4 = c.webm.replace(/\.webm$/, '.mp4');
    if (c.still) { console.log(`section ${c.section}: no repaint, still used`); transcode(c.still, c.mp4, ['-t', c.measured.toFixed(3)], ['-loop', '1']); }
    else transcode(c.webm, c.mp4);
    c.seconds = probeSeconds(c.mp4); rmSync(c.webm, { force: true }); if (c.still) rmSync(c.still, { force: true });
  }
  writeFileSync(join(out, 'timing.json'), JSON.stringify(timing, null, 2) + '\n');
  // `measured` is the wall-clock length of the section; a video length well above it means the timing log
  // (wall clock) and the picture drift apart within the clip, so cue from the picture, not from timing.json.
  writeFileSync(join(out, 'clips.json'), JSON.stringify(clips.map((c) => ({ section: c.section, file: `clips/section-${c.section}.mp4`, seconds: c.seconds, measured: Number(c.measured.toFixed(3)) })), null, 2) + '\n');
  for (const c of clips) if (c.seconds > c.measured * 1.03) console.warn(`section ${c.section}: video ${c.seconds.toFixed(1)} s for ${c.measured.toFixed(1)} s of wall clock; the timing log drifts from the picture`);
  return { misses: misses(), sections: clips.length, clips };
}
