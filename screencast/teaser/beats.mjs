// The music of the teaser: "Far Away" by MK2 at 96 BPM (beat 0.625 s, bar 2.5 s, crashes every 8 bars from 0 s),
// and the two edits of it. Shot times are song seconds; they are mapped to output frames from absolute times, so
// rounding never adds up over a run of short shots.
export const BPM = 96;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const FPS = 30;
export const SONG_SECONDS = 105.625;
// The end screen stays this long after the music has faded: time to read it, scan the code, and for YouTube's end screen.
export const END_HOLD = 4;

// The short version keeps the opening, the second half of the last build through the drop, and the last crash.
export const EDITS = {
  full: [{ from: 0, to: SONG_SECONDS }],
  short: [{ from: 0, to: 10 }, { from: 50, to: 80 }, { from: 100, to: SONG_SECONDS }]
};

export const at = (bar, beat = 0) => bar * BAR + beat * BEAT;
export const frameOf = (seconds) => Math.round(seconds * FPS);

// The edit segment holding the stretch [from, to], with the output time its start maps to.
function segmentOf(from, to, version) {
  const edits = EDITS[version];
  if (!edits) throw new Error(`no ${version} version: full or short`);
  let offset = 0;
  for (const e of edits) {
    if (from >= e.from && to <= e.to) return { e, offset };
    offset += e.to - e.from;
  }
  return null;
}

export function toOutput(songSeconds, version) {
  const s = segmentOf(songSeconds, songSeconds, version);
  if (!s) throw new Error(`song time ${songSeconds} is cut from the ${version} version`);
  return s.offset + songSeconds - s.e.from;
}

export function span(from, to, version) {
  const s = segmentOf(from, to, version);
  if (!s) throw new Error(`${from}–${to} s is not one stretch of the ${version} version: a shot across a cut, or one that is cut out`);
  const start = frameOf(s.offset + from - s.e.from);
  return { startFrame: start, frames: frameOf(s.offset + to - s.e.from) - start };
}
