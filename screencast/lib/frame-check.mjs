// Frame check: samples a finished video with ffmpeg, reads every frame with tesseract and fails if a real
// value of the redaction maps (redact.local.json, redact.extra.local.json) is on screen. Reports the mock the
// frame should have shown and the timestamp, never the real value.
// Usage: node screencast/lib/frame-check.mjs <video> [--every 0.5] [--map <real→mock json>]…
// Exit 0 clean, 1 a real value was read, 2 setup error (no ffmpeg, no tesseract, no map, unreadable video).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shorter real values match too much OCR noise (a 3-letter user name is in every other word).
const MIN_LENGTH = 4;
// From this length a value is compared with OCR's usual confusions folded (O/0, l/1/I/|) and spaces removed.
const FOLD_LENGTH = 8;

export function fold(s) {
  return s.toLowerCase().replace(/o/g, '0').replace(/[li|!]/g, '1').replace(/\s+/g, '');
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The mocks whose real value occurs in OCR text: folded for long values, as a whole word for short ones. */
export function findLeaks(text, map) {
  const folded = fold(text);
  const mocks = [];
  for (const [real, mock] of Object.entries(map)) {
    if (!real || real.length < MIN_LENGTH || real.startsWith('_comment')) continue;
    const hit = real.length >= FOLD_LENGTH
      ? folded.includes(fold(real))
      : new RegExp(`(?<![A-Za-z0-9])${escape(real)}(?![A-Za-z0-9])`, 'i').test(text);
    if (hit) mocks.push(mock);
  }
  return mocks;
}

/** Merges map files (later files win). A parse error names the file, never quotes it. */
export function loadMaps(paths) {
  const map = {};
  for (const p of paths) {
    let m;
    try { m = JSON.parse(readFileSync(p, 'utf8')); } catch { throw new Error(`${p} is not valid JSON`); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`${p} is not a JSON object`);
    Object.assign(map, m);
  }
  return map;
}

export function missingTools() {
  return ['ffmpeg', 'tesseract'].filter((t) => spawnSync(t, [t === 'ffmpeg' ? '-version' : '--version']).error);
}

/** Writes one PNG per `every` seconds (scaled 2× for OCR) and returns [{ file, t }], t of the frame in seconds. */
export function sampleFrames(video, every, dir) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `fps=1/${every},scale=iw*2:ih*2`, join(dir, 'f%06d.png')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg could not sample ${video}: ${(r.stderr || '').trim().split('\n').pop()}`);
  return readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f)).sort()
    .map((f) => ({ file: join(dir, f), t: Math.round((Number(f.slice(1, -4)) - 1) * every * 100) / 100 }));
}

function ocr(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('tesseract', [file, 'stdout', '--psm', '11'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tesseract failed on a frame (exit ${code})`))));
  });
}

/** [{ mock, times }] for every mock whose real value was read on a frame. */
export async function checkVideo(video, map, { every = 0.5 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'frame-check-'));
  try {
    const frames = sampleFrames(video, every, dir);
    if (!frames.length) throw new Error(`no frames sampled from ${video}`);
    const found = new Map();
    let next = 0;
    const worker = async () => {
      while (next < frames.length) {
        const { file, t } = frames[next++];
        for (const mock of findLeaks(await ocr(file), map)) found.set(mock, [...(found.get(mock) || []), t]);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.floor(cpus().length / 2)) }, worker));
    return { frames: frames.length, leaks: [...found].map(([mock, times]) => ({ mock, times: times.sort((a, b) => a - b) })) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const video = args.find((a, i) => !a.startsWith('--') && !['--every', '--map'].includes(args[i - 1]));
  const ei = args.indexOf('--every');
  const every = ei >= 0 ? Number(args[ei + 1]) : 0.5;
  const maps = args.flatMap((a, i) => (args[i - 1] === '--map' ? [a] : []));
  if (!video || !existsSync(video) || !(every > 0)) { console.error('usage: frame-check.mjs <video> [--every 0.5] [--map <json>]…'); process.exit(2); }
  const missing = missingTools();
  if (missing.length) { console.error(`frame check cannot run: ${missing.join(' and ')} not on the PATH (brew install ${missing.join(' ')})`); process.exit(2); }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const paths = maps.length ? maps : ['redact.local.json', 'redact.extra.local.json'].map((f) => join(root, f)).filter(existsSync);
  if (!paths.length) { console.error('frame check cannot run: no redaction map (redact.local.json / redact.extra.local.json)'); process.exit(2); }
  let map;
  try { map = loadMaps(paths); } catch (e) { console.error(e.message); process.exit(2); }
  try {
    const { frames, leaks } = await checkVideo(video, map, { every });
    for (const l of leaks) console.error(`${video}: real value that should show "${l.mock}" at ${l.times.map((t) => `${t}s`).join(', ')}`);
    if (leaks.length) process.exit(1);
    console.log(`frame check passed: ${frames} frames of ${video}, ${Object.keys(map).length} map entries`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
