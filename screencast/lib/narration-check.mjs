#!/usr/bin/env node
// Validates videos/*/script.md (spec 8.4): front matter complete, sections numbered and ascending, every
// section has a cue at or after its start, cues ascend and fit the target, 140 words a minute within the
// 40 % to 110 % band, the recap 20 to 70 words, every listed cast exists, and the step file agrees on
// casts and sections. node lib/narration-check.mjs [video]; exit 1 on any problem.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript, section, wordCount } from './script.mjs';

export const WPM = 140;
export const BAND = [0.4, 1.1];
export const RECAP_WORDS = [20, 70];
const REQUIRED = ['video', 'title', 'subtitle', 'kicker', 'target_seconds', 'voice', 'next'];
const SECTIONS = ['Spoken script', 'On-screen cues', 'Recap and next', 'Pronunciation'];

export function problemsOf(name, text, { casts = new Set(), steps = '' } = {}) {
  let s;
  try { s = parseScript(text); } catch (e) { return [`${name}: ${e.message}`]; }
  const { meta, body, spoken, recap } = s; const out = [];
  for (const k of REQUIRED) if (!meta[k]) out.push(`${name}: front matter lacks "${k}"`);
  if (meta.video && meta.video !== name) out.push(`${name}: video "${meta.video}" does not match the folder`);
  const target = Number(meta.target_seconds);
  if (!Number.isInteger(target) || target < 60 || target > 900) out.push(`${name}: target_seconds must be an integer from 60 to 900`);
  for (const sec of SECTIONS) if (section(body, sec) === undefined) out.push(`${name}: missing section "## ${sec}"`);
  if (!meta.sections.length) out.push(`${name}: no sections`);
  meta.sections.forEach((x, i) => {
    if (x.n !== i + 1) out.push(`${name}: section ${x.n} out of order (expected ${i + 1})`);
    if (i && x.start < meta.sections[i - 1].start) out.push(`${name}: section ${x.n} starts before section ${x.n - 1}`);
    const next = meta.sections[i + 1];
    if (!spoken.some((p) => p.at >= x.start && (!next || p.at < next.start))) out.push(`${name}: section ${x.n} (${x.label}) has no cue at or after its start`);
  });
  if (!spoken.length) out.push(`${name}: the spoken script has no [MM:SS] cue tags`);
  spoken.forEach((p, i) => {
    if (i && p.at < spoken[i - 1].at) out.push(`${name}: cues must ascend, [${p.label}] follows [${spoken[i - 1].label}]`);
    if (Number.isInteger(target) && p.at > target) out.push(`${name}: cue [${p.label}] is after the end of the ${target} s video`);
  });
  if (Number.isInteger(target)) {
    const words = spoken.reduce((n, p) => n + wordCount(p.text), 0); const want = (target * WPM) / 60;
    if (words < want * BAND[0] || words > want * BAND[1]) out.push(`${name}: ${words} spoken words, expected ${Math.round(want * BAND[0])} to ${Math.round(want * BAND[1])} for ${target} s`);
  }
  const rw = wordCount(recap);
  if (rw < RECAP_WORDS[0] || rw > RECAP_WORDS[1]) out.push(`${name}: the recap has ${rw} words, expected ${RECAP_WORDS[0]} to ${RECAP_WORDS[1]}`);
  for (const c of meta.casts) if (!casts.has(c)) out.push(`${name}: cast "${c}" has no videos/${name}/casts/${c}.cast`);
  if (steps) {
    for (const m of steps.matchAll(/\bcast\(\s*'([^']+)'\s*\)/g)) if (!meta.casts.includes(m[1])) out.push(`${name}: steps.js plays cast "${m[1]}" which is not in casts:`);
    // Distinct numbers: a section may be recorded from a second steps file (<name>.steps.js) as well.
    const n = new Set([...steps.matchAll(/\bsection\(\s*(\d+)\s*\)/g)].map((m) => m[1])).size;
    if (n !== meta.sections.length) out.push(`${name}: steps.js has ${n} section() calls, the script ${meta.sections.length} sections`);
  }
  return out;
}

export function checkAll(root, only) {
  const dir = join(root, 'videos');
  const names = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /^\d\d-/.test(f) && existsSync(join(dir, f, 'script.md'))).filter((f) => !only || f === only).sort();
  const problems = [];
  for (const name of names) {
    const castDir = join(dir, name, 'casts');
    const casts = new Set(existsSync(castDir) ? readdirSync(castDir).filter((f) => f.endsWith('.cast')).map((f) => f.slice(0, -5)) : []);
    // steps.js and any <name>.steps.js recorded with --steps (record.js), read as one.
    const steps = readdirSync(join(dir, name)).filter((f) => f === 'steps.js' || f.endsWith('.steps.js')).sort()
      .map((f) => readFileSync(join(dir, name, f), 'utf8')).join('\n');
    problems.push(...problemsOf(name, readFileSync(join(dir, name, 'script.md'), 'utf8'), { casts, steps }));
  }
  return { names, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { names, problems } = checkAll(join(dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2]);
  for (const p of problems) console.error(`FAIL ${p}`);
  console.log(problems.length ? `${problems.length} problem(s) in ${names.length} script(s)` : `${names.length} narration script(s) valid`);
  process.exit(problems.length ? 1 : 0);
}
