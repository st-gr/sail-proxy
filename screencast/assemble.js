#!/usr/bin/env node
// node assemble.js <video> [--timeline] [--no-tighten]
import { assemble } from './lib/assemble.mjs';

const argv = process.argv.slice(2);
const video = argv.find((a) => !a.startsWith('--'));
if (!video) { console.error('usage: node assemble.js <video> [--timeline] [--no-tighten]'); process.exit(2); }
try { await assemble({ video, timelineOnly: argv.includes('--timeline'), tighten: !argv.includes('--no-tighten') }); }
catch (e) { console.error(`FAILED ${video}: ${e.message}`); process.exit(1); }
