// cards + clips → one video: concat (silent), mix the narration on its cues, tighten the idle stretches,
// write chapters into the file, the VTT and the YouTube chapter lines, a poster frame, and update the
// catalogue entry. --timeline stops after printing the recorded section starts (the author aligns the cues).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, ENCODE, probeSeconds } from './record.mjs';
import { DURATION } from './timeline.mjs';
import { parseScript, toLabel } from './script.mjs';
import { timeline, castMarks, holdRanges, checkCues, manifestMatches, shiftTime, vtt, ffmetadata, chaptersText, updateEntry } from './timeline.mjs';
import { mix } from './mix.mjs';
import { tightenClip, tightenOptions } from './tighten.mjs';

function ff(args) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.slice(-1)[0]}`);
}

export async function assemble({ video, timelineOnly = false, tighten = true, log = console.log }) {
  const out = join(ROOT, 'out', video); const dir = join(ROOT, 'videos', video);
  const script = parseScript(readFileSync(join(dir, 'script.md'), 'utf8'));
  const clipsPath = join(out, 'clips.json');
  if (!existsSync(clipsPath)) throw new Error(`no out/${video}/clips.json: run record.js first`);
  const clips = JSON.parse(readFileSync(clipsPath, 'utf8'));
  const manifestPath = join(out, 'audio', 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const outroSeconds = Math.round((DURATION.outro + (manifest?.recap.seconds ?? 0)) * 10) / 10;
  const tl = timeline({ clips, outroSeconds });
  writeFileSync(join(out, 'timeline.json'), JSON.stringify(tl, null, 2) + '\n');
  log(`${video}: ${toLabel(tl.total)} in all`);
  for (const s of tl.sections) { const planned = script.meta.sections.find((x) => x.n === s.n); log(`  section ${s.n}: card at ${toLabel(s.start)} (script says ${planned?.label ?? '?'}) ${planned?.title ?? ''}`); }
  const timingPath = join(out, 'timing.json');
  if (existsSync(timingPath)) for (const c of castMarks(JSON.parse(readFileSync(timingPath, 'utf8')), tl)) log(`  cast ${c.name} ${toLabel(c.start)}\u2013${c.end == null ? '?' : toLabel(c.end)}`);
  log(`  outro at ${toLabel(tl.outroStart)}`);
  if (timelineOnly) return tl;
  if (!manifest) throw new Error(`no out/${video}/audio/manifest.json: run narrate.js first`);
  const problems = checkCues(tl.sections, script.spoken, tl.outroStart, tl.total);
  if (problems.length) throw new Error(`the cues do not match the recording:\n  ${problems.join('\n  ')}\nmove the [MM:SS] tags in script.md to the times above, then narrate again`);
  const stale = manifestMatches(script.spoken, manifest.segments);
  if (stale.length) throw new Error(`the narration does not match script.md:\n  ${stale.join('\n  ')}\nrun narrate.js again`);
  for (const p of tl.pieces) if (!existsSync(join(out, p.file))) throw new Error(`missing ${p.file}: run cards.js (after narrate.js) and record.js`);
  const outroLen = probeSeconds(join(out, 'cards', 'outro.mp4'));
  if (Math.abs(outroLen - outroSeconds) > 0.6) throw new Error(`the outro card is ${outroLen.toFixed(1)} s but the recap needs ${outroSeconds.toFixed(1)} s: run cards.js again`);
  const list = join(out, 'concat.txt');
  writeFileSync(list, tl.pieces.map((p) => `file '${join(out, p.file)}'`).join('\n') + '\n');
  ff(['-f', 'concat', '-safe', '0', '-i', list, ...ENCODE, join(out, 'video.mp4')]);
  const mixed = join(out, 'mixed.mp4');
  const p = mix({ audioDir: join(out, 'audio'), manifest, videoFile: join(out, 'video.mp4'), videoSeconds: probeSeconds(join(out, 'video.mp4')), recapAt: tl.outroStart, outFile: mixed, trackFile: join(out, 'track.wav') });
  const late = p.shifts.map((s, i) => [i + 1, s]).filter(([, s]) => s > 0.3);
  if (late.length) log(`  segments that started late: ${late.map(([i, s]) => `#${i} by ${s.toFixed(1)} s`).join(', ')}`);
  let cutList = []; let final = mixed;
  if (tighten) {
    const holds = existsSync(timingPath) ? holdRanges(JSON.parse(readFileSync(timingPath, 'utf8')), tl, clips) : [];
    const protect = [...tl.pieces.filter((x) => x.kind !== 'clip').map((x) => ({ start: x.start, end: x.start + x.seconds })), ...holds];
    const r = tightenClip(mixed, join(out, 'tight.mp4'), protect, tightenOptions(script.meta));
    cutList = r.cuts; if (r.cuts.length) final = join(out, 'tight.mp4');
    log(`  ${r.cuts.length} idle stretches shortened, ${r.removed.toFixed(1)} s removed`);
  }
  const titles = Object.fromEntries(script.meta.sections.map((s) => [s.n, s.title]));
  const chapters = [{ t: 0, title: 'Introduction' }, ...tl.sections.map((s) => ({ t: shiftTime(s.start, cutList), title: titles[s.n] }))];
  const total = probeSeconds(final);
  writeFileSync(join(out, 'chapters.ffmeta'), ffmetadata(chapters, total));
  ff(['-i', final, '-i', join(out, 'chapters.ffmeta'), '-map_metadata', '1', '-c', 'copy', '-movflags', '+faststart', join(out, `${video}.mp4`)]);
  const cues = manifest.segments.map((s, i) => ({ start: shiftTime(p.starts[i], cutList), end: shiftTime(p.starts[i] + p.segmentSeconds[i], cutList), text: script.spoken[i].text }));
  cues.push({ start: shiftTime(p.recapStart, cutList), end: shiftTime(p.recapStart + p.recapSeconds, cutList), text: script.recap });
  writeFileSync(join(out, `${video}.vtt`), vtt(cues));
  writeFileSync(join(out, 'chapters.txt'), chaptersText(chapters));
  ff(['-ss', '2.5', '-i', join(out, `${video}.mp4`), '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '3', join(out, 'poster.jpg')]);
  const catalogPath = join(ROOT, 'videos', 'catalog.json');
  if (existsSync(catalogPath)) writeFileSync(catalogPath, JSON.stringify(updateEntry(JSON.parse(readFileSync(catalogPath, 'utf8')), video, { duration: Math.round(total), chapters }), null, 2) + '\n');
  else log('  no videos/catalog.json yet: the catalogue entry was not updated');
  log(`  ${video}.mp4 ${toLabel(total)}, ${chapters.length} chapters, ${cues.length} subtitle cues`);
  return { total, chapters, cuts: cutList };
}
