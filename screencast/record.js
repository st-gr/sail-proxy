#!/usr/bin/env node
// node record.js <video> [--dry-run] [--base <url>] [--steps <name> --first-section <n>]: runs videos/<video>/steps.js
// (or <name>.steps.js, recorded into out/<video>/<name>/ with its count starting at section n) in the recording browser.
// Needs the demo stack, the proxy (:4010) and, for the site segments, the docs preview (:4173).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, recordVideo } from './lib/record.mjs';
import { parseScript } from './lib/script.mjs';
import { loadMap } from './check.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:4010';
const opt = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const name = opt('--steps'); const firstSection = Number(opt('--first-section') ?? 1);
const video = argv.find((a) => !a.startsWith('--') && ![base, name, opt('--first-section')].includes(a));
if (!video) { console.error('usage: node record.js <video> [--dry-run] [--base <url>]'); process.exit(2); }
const dir = join(ROOT, 'videos', video);
const stepsFile = name ? `${name}.steps.js` : 'steps.js';
for (const f of [stepsFile, 'script.md']) if (!existsSync(join(dir, f))) { console.error(`no videos/${video}/${f}`); process.exit(2); }
let map;
try { map = loadMap(readFileSync(join(ROOT, 'redact.local.json'), 'utf8')); delete map._comment; } catch (e) { console.error(`redact.local.json: ${e.message}; run stack/with-service-key.mjs first`); process.exit(2); }
const { default: steps } = await import(pathToFileURL(join(dir, stepsFile)));
const { meta } = parseScript(readFileSync(join(dir, 'script.md'), 'utf8'));
try {
  const r = await recordVideo({ video, steps, meta, map, dryRun, base, name, firstSection });
  if (dryRun) {
    for (const m of r.misses) console.error(`MISS ${m}`);
    if (r.misses.length) { console.error(`dry-run ${video}: ${r.misses.length} miss(es)`); process.exit(1); }
    console.log(`dry-run ${video}: ok, ${r.sections} sections`);
  } else console.log(`recorded ${video}: ${r.clips.map((c) => `section ${c.section} ${c.seconds.toFixed(1)} s`).join(', ')}`);
} catch (e) { console.error(`FAILED ${video}: ${e.message}`); process.exit(1); }
