#!/usr/bin/env node
// Records the casts of a video: node cast.js <video> <name>|--all. Definitions come from
// videos/<video>/casts.mjs; the scrubbed cast goes to videos/<video>/casts/<name>.cast (committed), the raw
// output to out/<video>/casts/<name>.raw.log (mode 600, gitignored) for the operator's eyes only.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordCast, serialize, castText, blankEvents } from './lib/cast.mjs';
import { loadMap } from './check.js';

const here = dirname(fileURLToPath(import.meta.url));
const [video, which] = process.argv.slice(2);
if (!video || !which) { console.error('usage: node cast.js <video> <name>|--all'); process.exit(2); }
const defPath = join(here, 'videos', video, 'casts.mjs');
if (!existsSync(defPath)) { console.error(`no ${defPath.replace(here + '/', '')}`); process.exit(2); }
const { casts } = await import(pathToFileURL(defPath));
const names = which === '--all' ? Object.keys(casts) : [which];
const mapPath = join(here, 'redact.local.json');
let map = {};
try { if (existsSync(mapPath)) { map = loadMap(readFileSync(mapPath, 'utf8')); delete map._comment; } } catch (e) { console.error(e.message); process.exit(2); }
if (!Object.keys(map).length) { console.error('redact.local.json is missing or empty: run stack/with-service-key.mjs first'); process.exit(2); }
let failed = 0;
// The raw output, unscrubbed: mode 600 under the gitignored out/, for the operator's eyes only.
const writeRaw = (name, raw) => {
  const rawDir = join(here, 'out', video, 'casts'); mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  const rawPath = join(rawDir, `${name}.raw.log`);
  writeFileSync(rawPath, castText(raw), { mode: 0o600 }); chmodSync(rawPath, 0o600);
};
for (const name of names) {
  try {
    const def = casts[name];
    if (!def) throw new Error('not defined');
    const r = await recordCast({ title: `${video}/${name}`, ...def }, { map, log: (l) => console.log(`  ${l}`) });
    writeRaw(name, r.raw);
    if (r.misses.length) throw new Error(`redaction miss: ${r.misses.join(', ')} (raw output kept in out/${video}/casts/${name}.raw.log)`);
    const dir = join(here, 'videos', video, 'casts'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.cast`), serialize(r.header, blankEvents(r.events, def.blank)));
    console.log(`cast ${video}/${name}: ${r.events.length} events, ${r.events[r.events.length - 1][0].toFixed(1)} s`);
  } catch (e) {
    failed++;
    if (e.raw) writeRaw(name, e.raw);
    console.error(`FAILED ${name}: ${e.message}${e.raw ? ` (output so far in out/${video}/casts/${name}.raw.log)` : ''}`);
  }
}
if (failed) process.exit(1);
