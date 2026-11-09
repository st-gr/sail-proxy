// Lays the narration over the silent video (ter's demo/narration/mix.js, ported to ESM): each segment starts
// at its cue, one that would run into the segment before waits, the recap starts a second into the outro card
// (or after the last segment), and the last frame is held when the recap runs past the end.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { wavFromPcm, RATE } from './synthesize.mjs';
import { H264 } from './encoder.mjs';

const GAP = 0.35;
const RECAP_LEAD = 1;
const TAIL = 1.5;
const LEAD_KEEP = 0.05;
const TAIL_KEEP = 0.1;
const QUIET = 400; // 16-bit amplitude under which a sample counts as silence
const round = (n) => Math.round(n * 100) / 100;

export function plan(segments, recapSeconds, videoSeconds, recapAt) {
  const starts = []; const shifts = []; let end = -Infinity;
  for (const s of segments) {
    const start = Math.max(s.at, end + GAP);
    starts.push(round(start)); shifts.push(round(start - s.at)); end = start + s.seconds;
  }
  const recapStart = round(Math.max(recapAt + RECAP_LEAD, end + RECAP_LEAD));
  const total = round(Math.max(videoSeconds, recapStart + recapSeconds + TAIL));
  return { starts, shifts, recapStart, total, freeze: round(total - videoSeconds) };
}

// 16-bit mono PCM of `seconds` of silence with each piece copied in at its start second.
export function buildTrack(pieces, rate, seconds) {
  const track = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (const { start, pcm } of pieces) {
    const at = Math.round(start * rate) * 2;
    pcm.copy(track, at, 0, Math.max(0, Math.min(pcm.length, track.length - at)));
  }
  return track;
}

// Speech starts the moment its cue says only if the file does not open with silence: cut both ends back to a short margin.
export function trimSilence(pcm, rate) {
  const n = pcm.length / 2; let first = 0; let last = n - 1;
  while (first < n && Math.abs(pcm.readInt16LE(first * 2)) < QUIET) first++;
  if (first === n) return pcm;
  while (last > first && Math.abs(pcm.readInt16LE(last * 2)) < QUIET) last--;
  const from = Math.max(0, first - Math.round(LEAD_KEEP * rate)); const to = Math.min(n, last + 1 + Math.round(TAIL_KEEP * rate));
  return pcm.subarray(from * 2, to * 2);
}

const pcmOf = (path) => trimSilence(readFileSync(path).subarray(44), RATE);
const seconds = (pcm) => pcm.length / (RATE * 2);

export function mix({ audioDir, manifest, videoFile, videoSeconds, recapAt, outFile, trackFile }) {
  const spoken = manifest.segments.map((s) => pcmOf(join(audioDir, s.file)));
  const recap = pcmOf(join(audioDir, manifest.recap.file));
  const p = plan(manifest.segments.map((s, i) => ({ at: s.at, seconds: seconds(spoken[i]) })), seconds(recap), videoSeconds, recapAt);
  const pieces = spoken.map((pcm, i) => ({ start: p.starts[i], pcm }));
  pieces.push({ start: p.recapStart, pcm: recap });
  writeFileSync(trackFile, wavFromPcm(buildTrack(pieces, RATE, p.total), RATE));
  const pad = p.freeze > 0 ? ['-vf', `tpad=stop_mode=clone:stop_duration=${p.freeze}`] : [];
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', videoFile, '-i', trackFile, ...pad, '-map', '0:v', '-map', '1:a', '-c:v', H264, '-b:v', '12M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', String(p.total), outFile], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('ffmpeg failed while mixing');
  return { ...p, segmentSeconds: spoken.map(seconds), recapSeconds: seconds(recap) };
}
