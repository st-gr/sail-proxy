// The video's time axis and the assembler's pure helpers: the order of cards and clips, the check of the
// narration cues against the recorded section starts, time shifting after idle removal, the VTT, the chapter
// metadata and the catalogue patch.
import { toLabel } from './script.mjs';

// The cards' lengths in seconds; here and not in cards.mjs, so the pure helpers do not load the renderer (puppeteer).
export const DURATION = { intro: 5, section: 3, outro: 8 };
export const CARD = { intro: DURATION.intro, section: DURATION.section };
const round = (n) => Math.round(n * 1000) / 1000;

export function timeline({ clips, outroSeconds, card = CARD }) {
  const pieces = []; let t = 0;
  const push = (p) => { pieces.push({ ...p, start: round(t) }); t += p.seconds; };
  push({ kind: 'intro', file: 'cards/intro.mp4', seconds: card.intro });
  for (const c of clips) {
    push({ kind: 'card', section: c.section, file: `cards/section-${c.section}.mp4`, seconds: card.section });
    push({ kind: 'clip', section: c.section, file: c.file, seconds: c.seconds });
  }
  push({ kind: 'outro', file: 'cards/outro.mp4', seconds: outroSeconds });
  const sections = pieces.filter((p) => p.kind === 'card').map((p) => ({ n: p.section, start: p.start }));
  return { pieces, sections, outroStart: pieces[pieces.length - 1].start, total: round(t) };
}

// Each section's window runs from its card to the next card (the last one to the outro) and needs a cue in it;
// no cue may fall inside the outro card or after the end.
export function checkCues(sections, spoken, outroStart, total) {
  const out = [];
  sections.forEach((s, i) => {
    const next = sections[i + 1]; const end = next ? next.start : outroStart;
    if (!spoken.some((p) => p.at >= s.start && p.at < end)) out.push(`section ${s.n} starts at ${toLabel(s.start)} but has no cue between ${toLabel(s.start)} and ${next ? toLabel(next.start) : 'the outro'}`);
  });
  for (const p of spoken) {
    if (p.at > total) out.push(`cue [${p.label}] is after the end of the video (${toLabel(total)})`);
    else if (p.at >= outroStart) out.push(`cue [${p.label}] falls inside the outro card (from ${toLabel(outroStart)})`);
  }
  return out;
}

// The audio is mixed from the manifest, so it must still match the script's cues (else narrate.js was not re-run).
export function manifestMatches(spoken, segments) {
  if (spoken.length !== segments.length) return [`the script has ${spoken.length} cues but the narration has ${segments.length} segments`];
  return spoken.flatMap((p, i) => (p.at === segments[i].at ? [] : [`cue ${i + 1} is at [${p.label}] in the script but the narration was made for [${toLabel(segments[i].at)}]`]));
}

// Where a time lands once the cuts are gone: minus every cut before it; inside a cut it lands on the cut's start.
export function shiftTime(t, cuts) {
  let removed = 0;
  for (const c of cuts) { if (c.end <= t) removed += c.end - c.start; else if (c.start < t) removed += t - c.start; }
  return round(t - removed);
}

const stamp = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`;
export const vtt = (cues) => ['WEBVTT', '', ...cues.flatMap((c) => [`${stamp(c.start)} --> ${stamp(c.end)}`, c.text, ''])].join('\n');

export function ffmetadata(chapters, total) {
  const lines = [';FFMETADATA1'];
  chapters.forEach((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].t : total;
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.t * 1000)}`, `END=${Math.round(end * 1000)}`, `title=${c.title}`);
  });
  return lines.join('\n') + '\n';
}

export const chaptersText = (chapters) => chapters.map((c) => `${toLabel(c.t)} ${c.title}`).join('\n') + '\n';

export function updateEntry(catalog, id, patch) {
  if (!catalog.some((v) => v.id === id)) throw new Error(`no catalogue entry ${id}`);
  return catalog.map((v) => (v.id === id ? { ...v, ...patch } : v));
}

// One line per cast: its first frame and its end on the assembled timeline (the clip's start plus the recorded offset).
// The hold() steps as ranges of the assembled timeline that tightening leaves alone. The logged time is scaled by
// the clip's video length over its wall-clock length (the picture runs long in heavy sections) and padded.
export function holdRanges(timing, tl, clips, pad = 0.5) {
  return timing.filter((m) => m.event.startsWith('hold ')).map((m) => {
    const piece = tl.pieces.find((p) => p.kind === 'clip' && p.section === m.section);
    const clip = clips.find((c) => c.section === m.section);
    const ratio = clip?.measured ? clip.seconds / clip.measured : 1;
    const start = piece.start + (m.ms_since_clip_start / 1000) * ratio;
    return { start: round(start - pad), end: round(start + (Number(m.event.slice(5)) / 1000) * ratio + pad) };
  });
}

export function castMarks(timing, tl) {
  const at = (m) => round(tl.pieces.find((p) => p.kind === 'clip' && p.section === m.section).start + m.ms_since_clip_start / 1000);
  const ends = new Map(timing.filter((m) => m.event.startsWith('cast-end ')).map((m) => [`${m.section} ${m.event.slice(9)}`, m]));
  return timing.filter((m) => m.event.startsWith('cast ')).map((m) => {
    const name = m.event.slice(5); const e = ends.get(`${m.section} ${name}`);
    return { name, start: at(m), end: e ? at(e) : null };
  });
}
