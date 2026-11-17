#!/usr/bin/env node
// node teaser.js --song <path to "Far Away - MK2.mp3"> [--version full|short|both] [--size 1080p|1440p]: renders the
// teaser from teaser/shots.mjs into out/teaser/teaser-<version>.mp4, or teaser-<version>_1440p.mp4 (and a poster).
// The song stays where it is.
import { buildTeaser } from './teaser/assemble.mjs';
import { SHOTS } from './teaser/shots.mjs';
import { SIZES } from './teaser/render.mjs';

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const which = arg('--version') ?? 'both';
if (!['full', 'short', 'both'].includes(which)) { console.error('--version is full, short or both'); process.exit(2); }
const size = arg('--size') ?? '1080p';
if (!SIZES[size]) { console.error(`--size is ${Object.keys(SIZES).join(' or ')}`); process.exit(2); }
try {
  for (const version of which === 'both' ? ['full', 'short'] : [which]) {
    const r = await buildTeaser({ song: arg('--song'), version, shots: SHOTS, size, log: console.log });
    console.log(`teaser ${version}: ${r.file} (${r.seconds.toFixed(2)} s)`);
  }
} catch (e) { console.error(e.message); process.exit(1); }
