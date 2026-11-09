// Shortens the idle stretches of a narrated video (ter's demo/narration/tighten.js, ported): where the narrator
// is silent and the picture does not change for 1.5 s or more, only 0.4 s at each edge is kept. Speech, motion
// and the cards (protected ranges) are never cut. Change is judged in 8 × 8 blocks of a 480 × 270 grey frame
// at 5 per second: typing counts as change, a blinking cursor does not.
import { spawnSync } from 'node:child_process';
import { H264 } from './encoder.mjs';

export const OPTS = { minIdle: 1.5, keep: 0.4 };
// A script's front matter may keep more of each edge (`tighten_keep: 0.65`), e.g. to let a result be read; it must
// stay under half the shortest stretch that is cut, or a stretch would grow instead of shrink.
export function tightenOptions(meta = {}) {
  if (meta.tighten_keep == null || meta.tighten_keep === '') return { ...OPTS };
  const keep = Number(meta.tighten_keep);
  if (!(keep > 0 && keep < OPTS.minIdle / 2)) throw new Error(`tighten_keep must be a number of seconds between 0 and ${OPTS.minIdle / 2}, got ${meta.tighten_keep}`);
  return { ...OPTS, keep };
}
const DETECT = { noise: '-40dB', min: 0.5 };
export const STILL = { fps: 5, threshold: 8, min: 0.5, width: 480, height: 270, block: 8 };
const round = (n) => Math.round(n * 1000) / 1000;

export function cuts(silences, freezes, { minIdle, keep }, protect = []) {
  const out = [];
  for (const s of silences) for (const f of freezes) {
    let ranges = [{ start: Math.max(s.start, f.start), end: Math.min(s.end, f.end) }];
    for (const p of protect) ranges = ranges.flatMap((r) => (r.end <= p.start || r.start >= p.end ? [r] : [{ start: r.start, end: Math.min(r.end, p.start) }, { start: Math.max(r.start, p.end), end: r.end }].filter((x) => x.end > x.start)));
    for (const r of ranges) if (r.end - r.start >= minIdle) out.push({ start: round(r.start + keep), end: round(r.end - keep) });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function keeps(cutList, duration) {
  const out = []; let at = 0;
  for (const c of cutList) { if (c.start > at) out.push({ start: at, end: c.start }); at = Math.max(at, c.end); }
  if (at < duration) out.push({ start: at, end: duration });
  return out;
}

export function silencesOf(log, duration) {
  const silences = []; let s = null;
  for (const line of log.split('\n')) {
    let m;
    if ((m = /silence_start: ([\d.]+)/.exec(line))) s = Number(m[1]);
    else if ((m = /silence_end: ([\d.]+)/.exec(line)) && s != null) { silences.push({ start: s, end: Number(m[1]) }); s = null; }
  }
  if (s != null) silences.push({ start: s, end: duration });
  return silences;
}

// diffs[k]: the largest block change between frame k and k+1; runs at or under the threshold are still.
export function stills(diffs, { fps, threshold, min }) {
  const out = []; let from = null;
  const close = (k) => { if (from != null && (k - from) / fps >= min) out.push({ start: round(from / fps), end: round(k / fps) }); from = null; };
  diffs.forEach((d, k) => { if (d <= threshold) { if (from == null) from = k; } else close(k); });
  close(diffs.length);
  return out;
}

function blockDiffs(clip) {
  const { fps, width: W, height: H, block: B } = STILL;
  const raw = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', clip, '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 }).stdout;
  const size = W * H; const n = Math.floor(raw.length / size); const diffs = [];
  for (let k = 1; k < n; k++) {
    const a = (k - 1) * size; const b = k * size; let max = 0;
    for (let by = 0; by + B <= H; by += B) for (let bx = 0; bx + B <= W; bx += B) {
      let sum = 0;
      for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) sum += Math.abs(raw[b + y * W + x] - raw[a + y * W + x]);
      if (sum > max) max = sum;
    }
    diffs.push(max / (B * B));
  }
  return diffs;
}

const seconds = (clip) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip], { encoding: 'utf8' }).stdout);

export function tightenClip(clip, out, protect = [], opts = OPTS) {
  const duration = seconds(clip);
  const log = spawnSync('ffmpeg', ['-hide_banner', '-i', clip, '-af', `silencedetect=noise=${DETECT.noise}:d=${DETECT.min}`, '-vn', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stderr;
  const cut = cuts(silencesOf(log, duration), stills(blockDiffs(clip), STILL), opts, protect);
  if (!cut.length) return { duration, removed: 0, cuts: cut };
  const keep = keeps(cut, duration);
  const parts = keep.map((k, i) => `[0:v]trim=${k.start}:${k.end},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=${k.start}:${k.end},asetpts=PTS-STARTPTS[a${i}];`).join('');
  const filter = `${parts}${keep.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${keep.length}:v=1:a=1[v][a]`;
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', clip, '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-c:v', H264, '-b:v', '12M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', out], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg failed while tightening ${clip}`);
  return { duration, removed: cut.reduce((n, c) => n + c.end - c.start, 0), cuts: cut };
}
