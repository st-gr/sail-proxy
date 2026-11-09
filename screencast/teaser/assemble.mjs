// Builds one version of the teaser: validate the shot list, render the still layers and every shot, concatenate
// them, put each shot's text on top for its window, lay the (edited) song under it, and take a poster from the
// end screen. Everything lands in out/teaser/; the song is read from where the caller says and never copied.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT, probeSeconds } from '../lib/record.mjs';
import { EDITS, END_HOLD, FPS, SONG_SECONDS, frameOf, toOutput } from './beats.mjs';
import { validate, timelineFor } from './model.mjs';
import { renderLayers } from './layers.mjs';
import { renderShot } from './render.mjs';
import { H264 } from '../lib/encoder.mjs';

const REPO = join(ROOT, '..');

export function checkSong(seconds) {
  if (!(Math.abs(seconds - SONG_SECONDS) <= 0.1)) throw new Error(`the song is ${Number(seconds).toFixed(1)} s, expected ${SONG_SECONDS.toFixed(1)} s (Far Away – MK2)`);
}

// The audio filter from input [i:a] to [a]: the whole song, or the short version's stretches with 20 ms crossfades.
export function musicFilter(i, version) {
  const edits = EDITS[version];
  if (edits.length === 1) return `[${i}:a]anull[a]`;
  // Every inner edge gets half the crossfade on both sides, so each 20 ms fade is centred on its join and the
  // music after it stays on the picture's beat (without the pad every join would pull the rest 20 ms early).
  const pad = (x) => Math.round(x * 1000) / 1000;
  const parts = edits.map((e, k) => `[${i}:a]atrim=start=${k ? pad(e.from - 0.01) : e.from}:end=${k < edits.length - 1 ? pad(e.to + 0.01) : e.to},asetpts=PTS-STARTPTS[m${k}]`);
  let chain = '[m0]';
  for (let k = 1; k < edits.length; k++) { const out = k === edits.length - 1 ? '[a]' : `[x${k}]`; parts.push(`${chain}[m${k}]acrossfade=d=0.02${out}`); chain = out; }
  return parts.join(';');
}

// Each shot's text: from its own song time (or the shot's start) to the shot's end, in output seconds on frames.
export function textWindows(timeline, version) {
  return timeline.filter((s) => s.text).map((s) => ({ id: s.id, text: s.text, start: frameOf(toOutput(s.text.at ?? s.from, version)) / FPS, end: (s.startFrame + s.frames) / FPS }));
}

const layerOf = (src) => (src.card === 'tagline' ? { kind: 'tagline', input: { shown: src.shown } } : { kind: src.card });
const textLayer = (t) => (t.style === 'punch' ? { kind: 'word', input: { text: t.lines.join(' ') } } : { kind: 'text', input: { lines: t.lines, style: t.style } });
export const layerKey = (l) => `${l.kind}-${createHash('sha1').update(JSON.stringify(l.input ?? {})).digest('hex').slice(0, 12)}`;

function ff(args, what) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${what}: ffmpeg failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
}

export async function buildTeaser({ song, version, shots, log = () => {} }) {
  if (!song || !existsSync(song)) throw new Error(`no song at ${song}: pass --song <path to Far Away - MK2.mp3>`);
  checkSong(probeSeconds(song));
  const lengths = new Map();
  // '<video>/section-<n>' or '<video>/<named step file>/section-<n>' (a clip recorded with record.js --steps).
  const clipFile = (clip) => { const parts = clip.split('/'); const s = parts.pop(); return join(ROOT, 'out', ...parts, 'clips', `${s}.mp4`); };
  const clipSeconds = (clip) => { if (!lengths.has(clip)) lengths.set(clip, existsSync(clipFile(clip)) ? probeSeconds(clipFile(clip)) : null); return lengths.get(clip); };
  const problems = validate(shots, { clipSeconds, exists: (p) => existsSync(join(REPO, p)) });
  if (problems.length) throw new Error(`the shot list does not render:\n  ${problems.join('\n  ')}`);

  const out = join(ROOT, 'out', 'teaser'); const work = join(out, version);
  rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
  const timeline = timelineFor(shots, version);
  const windows = textWindows(timeline, version);
  const layers = new Map();
  for (const s of timeline) if (s.source.card) { const l = layerOf(s.source); layers.set(layerKey(l), l); }
  for (const w of windows) { const l = textLayer(w.text); layers.set(layerKey(l), l); }
  await renderLayers([...layers].map(([name, l]) => ({ name, ...l })), join(out, 'layers'));
  const png = (l) => join(out, 'layers', `${layerKey(l)}.png`);
  log(`${version}: ${timeline.length} shots, ${windows.length} texts, ${layers.size} layers`);

  const files = timeline.map((s, i) => {
    const input = s.source.clip ? clipFile(s.source.clip) : s.source.image ? join(REPO, s.source.image) : png(layerOf(s.source));
    return renderShot(s, input, join(work, `shot-${String(i).padStart(3, '0')}.mp4`));
  });
  const list = join(work, 'concat.txt');
  writeFileSync(list, files.map((f) => `file '${f}'`).join('\n') + '\n');
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', join(work, 'picture.mp4')], 'concat');

  const total = (timeline.at(-1).startFrame + timeline.at(-1).frames) / FPS;
  // Each text layer is read only for its own window and shifted there, so the pass decodes no idle layers; the
  // enable window stays, because overlay shows a late input's first frame from the start otherwise.
  const inputs = ['-i', join(work, 'picture.mp4'), '-i', song, ...windows.flatMap((w) => ['-loop', '1', '-framerate', String(FPS), '-t', (w.end - w.start).toFixed(3), '-i', png(textLayer(w.text))])];
  let chain = '[0:v]'; const parts = [];
  windows.forEach((w, k) => {
    const i = k + 2; const o = k === windows.length - 1 ? '[v]' : `[t${k}]`;
    parts.push(`[${i}:v]format=rgba,fade=t=in:st=0:d=0.12:alpha=1,setpts=PTS+${w.start}/TB[p${k}]`, `${chain}[p${k}]overlay=eof_action=pass:enable='between(t,${w.start},${w.end - 1 / FPS})'${o}`);
    chain = o;
  });
  if (!windows.length) parts.push('[0:v]null[v]');
  const musicEnd = timeline.at(-1).source.card === 'end' ? total - END_HOLD : total;
  parts.push(musicFilter(1, version), '[a]apad,afade=t=out:st=' + (musicEnd - 1.5).toFixed(3) + ':d=1.5[am]');
  const file = join(out, `teaser-${version}.mp4`);
  ff([...inputs, '-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[am]', '-t', total.toFixed(3), '-r', String(FPS),
    '-c:v', H264, '-b:v', '14M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', file], 'final');
  ff(['-sseof', '-2', '-i', file, '-frames:v', '1', '-q:v', '2', join(out, `teaser-${version}.jpg`)], 'poster');
  return { file, seconds: probeSeconds(file) };
}
