// One teaser shot → one silent 1920×1080 30 fps MP4 of exactly its frame count: the source (a tutorial clip from
// its start second, a still image, a rendered card) is cropped, scaled and put through its effect.
import { spawnSync } from 'node:child_process';
import { FPS } from './beats.mjs';
import { H264 } from '../lib/encoder.mjs';

const NAVY = '0x0B1F33';
const W = 1920; const H = 1080;

// A filter_complex fragment from [v] to [o]; frames is the shot's length.
export function effectFilter(effect, frames) {
  const d = (frames / FPS).toFixed(3);
  // Scaled up a little more each frame at twice the size, kept even so the centre crop sits on whole pixels, then
  // brought down: the picture grows smoothly around a fixed centre. zoompan rounded its window's size and position
  // apart, so the opening logo shook by a pixel from frame to frame.
  // A looped still keeps delivering frames past the shot's end (t > d): the factor stays within 1 to 1.12, or a
  // pull-out would ask crop for more picture than the frame has.
  const even = (side, z) => `2*trunc(${2 * side}*clip(${z},1,1.12)/2)`;
  const zoom = (z) => `scale=w='${even(W, z)}':h='${even(H, z)}':eval=frame:flags=lanczos,`
    + `crop=${2 * W}:${2 * H}:exact=1:x='(${even(W, z)}-${2 * W})/2':y='(${even(H, z)}-${2 * H})/2',scale=${W}:${H}:flags=lanczos`;
  const bg = `color=c=${NAVY}:s=${W}x${H}:r=${FPS}:d=${d}[bg]`;
  switch (effect) {
    case 'cut': return '[v]null[o]';
    case 'push-in': return `[v]${zoom(`1+0.12*t/${d}`)}[o]`;
    case 'pull-out': return `[v]${zoom(`1.12-0.12*t/${d}`)}[o]`;
    case 'flash': return '[v]fade=t=in:st=0:d=0.15:color=white[o]';
    case 'slide-left': return `${bg};[bg][v]overlay=x='max(0,${W}*(1-t/0.267))':y=0:shortest=1[o]`;
    case 'slide-up': return `${bg};[bg][v]overlay=x=0:y='max(0,${H}*(1-t/0.267))':shortest=1[o]`;
    case 'glitch': return `[v]split[a][b];[a]rgbashift=rh=-18:bh=18:gv=6[g];[b][g]overlay=enable='lt(n,4)'[o]`;
    case 'wipe': return `color=c=${NAVY}:s=${W}x${H}:r=${FPS}:d=${d}[box];[v][box]overlay=x='${W}*min(1,t/(${d}*0.7))':y=0:shortest=1[o]`;
    default: throw new Error(`unknown effect ${effect}`);
  }
}

// The ffmpeg arguments for one timeline entry (Task 2's timelineFor) from its input file to outFile.
export function shotArgs(entry, { inputPath, outFile = 'out.mp4' }) {
  const src = entry.source; const seconds = (entry.frames / FPS + 0.5).toFixed(3);
  const input = src.clip ? ['-ss', String(src.start), '-t', seconds, '-i', inputPath] : ['-loop', '1', '-i', inputPath];
  const c = src.crop;
  const frame = src.clip
    ? `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${W}:${H}:flags=lanczos`
    : `${c ? `crop=${c.w}:${c.h}:${c.x}:${c.y},` : ''}scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${NAVY}`;
  const fc = `[0:v]${frame},fps=${FPS},setsar=1,format=yuv420p[v];${effectFilter(entry.effect, entry.frames)}`;
  return ['-loglevel', 'error', '-y', ...input, '-filter_complex', fc, '-map', '[o]', '-frames:v', String(entry.frames), '-r', String(FPS), '-an',
    '-c:v', H264, '-b:v', '16M', '-pix_fmt', 'yuv420p', outFile];
}

export const probeFrames = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());

export function renderShot(entry, inputPath, outFile) {
  const r = spawnSync('ffmpeg', shotArgs(entry, { inputPath, outFile }), { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`shot ${entry.id}: ffmpeg failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  const n = probeFrames(outFile);
  if (n !== entry.frames) throw new Error(`shot ${entry.id}: ${n} frames rendered, ${entry.frames} planned`);
  return outFile;
}
