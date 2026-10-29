#!/usr/bin/env node
// node cards.js <video>: renders the video's cards into out/<video>/cards/. The outro's length includes the
// recap when out/<video>/audio/manifest.json exists, so run it after narrate.js (and again if the recap changes).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/record.mjs';
import { renderCards } from './lib/cards.mjs';
import { parseScript } from './lib/script.mjs';

const video = process.argv[2];
if (!video) { console.error('usage: node cards.js <video>'); process.exit(2); }
const scriptPath = join(ROOT, 'videos', video, 'script.md');
if (!existsSync(scriptPath)) { console.error(`no videos/${video}/script.md`); process.exit(2); }
const { meta } = parseScript(readFileSync(scriptPath, 'utf8'));
const { version } = JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8'));
const manifestPath = join(ROOT, 'out', video, 'audio', 'manifest.json');
const recapSeconds = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).recap.seconds : 0;
if (!recapSeconds) console.log('no narration yet: the outro card is 8 s; run cards.js again after narrate.js');
try {
  const cards = await renderCards({ video, meta, version, recapSeconds, log: console.log });
  console.log(`${cards.length} cards for ${video}`);
} catch (e) { console.error(`FAILED ${video}: ${e.message}`); process.exit(1); }
