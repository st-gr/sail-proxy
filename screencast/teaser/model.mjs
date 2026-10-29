// The teaser's shot list as data: each shot names its song-time stretch, its source (a recorded tutorial clip, an
// image, or a rendered card), its effect and the versions it is in. validate() lists what would render wrong
// (a window past its clip, the tutorials' caption bar in frame, gaps or overlaps); timelineFor() places a
// version's shots on output frames.
import { EDITS, END_HOLD, FPS, span } from './beats.mjs';

export const EFFECTS = ['cut', 'push-in', 'pull-out', 'flash', 'slide-left', 'slide-up', 'glitch', 'wipe'];
// Where the tutorial clips carry their burnt-in caption ("Step n of N" and the text), in 1920×1080 clip pixels.
export const CAPTION_BAR = { x: 0, y: 930, w: 1250, h: 150 };
const EPS = 1e-6;

const meets = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function sourceProblems(s, { clipSeconds, exists }) {
  const src = s.source ?? {};
  if (src.clip) {
    const len = clipSeconds(src.clip);
    if (len == null) return [`${s.id}: no clip ${src.clip}`];
    const out = [];
    if (src.start < 0 || src.start + (s.to - s.from) > len + EPS) out.push(`${s.id}: the window ${src.start}–${src.start + s.to - s.from} s runs past ${src.clip} (${len.toFixed(1)} s)`);
    if (!src.crop || meets(src.crop, CAPTION_BAR)) out.push(`${s.id}: the crop shows the tutorials' caption bar (keep clear of x ${CAPTION_BAR.x}–${CAPTION_BAR.x + CAPTION_BAR.w}, y ${CAPTION_BAR.y}–1080)`);
    return out;
  }
  if (src.image) return exists(src.image) ? [] : [`${s.id}: no image ${src.image}`];
  if (src.card) return [];
  return [`${s.id}: a source needs clip, image or card`];
}

function coverageProblems(shots, version) {
  const out = []; const mine = shots.filter((s) => s.versions.includes(version)).sort((a, b) => a.from - b.from);
  for (const s of mine) { try { span(s.from, s.to, version); } catch (e) { out.push(`${s.id} (${version}): ${e.message}`); } }
  for (const e of EDITS[version]) {
    let cursor = e.from;
    for (const s of mine.filter((x) => x.from >= e.from - EPS && x.to <= e.to + EPS)) {
      if (s.from > cursor + EPS) out.push(`${version}: gap ${cursor}–${s.from} s before ${s.id}`);
      else if (s.from < cursor - EPS) out.push(`${version}: ${s.id} overlaps the shot before it (${s.from} < ${cursor} s)`);
      cursor = Math.max(cursor, s.to);
    }
    if (cursor < e.to - EPS) out.push(`${version}: gap ${cursor}–${e.to} s at the end of the ${e.from}–${e.to} s stretch`);
  }
  return out;
}

export function validate(shots, env) {
  const out = [];
  for (const s of shots) {
    if (!(s.to > s.from)) out.push(`${s.id}: ends before it starts`);
    if (!EFFECTS.includes(s.effect)) out.push(`${s.id}: unknown effect ${s.effect} (${EFFECTS.join(', ')})`);
    out.push(...sourceProblems(s, env));
  }
  for (const v of Object.keys(EDITS)) out.push(...coverageProblems(shots, v));
  return out;
}

// The last shot, when it is the end screen, is held END_HOLD seconds past the music.
export function timelineFor(shots, version) {
  const t = shots.filter((s) => s.versions.includes(version)).sort((a, b) => a.from - b.from).map((s) => ({ ...s, ...span(s.from, s.to, version) }));
  const last = t.at(-1);
  if (last?.source.card === 'end') last.frames += END_HOLD * FPS;
  return t;
}
