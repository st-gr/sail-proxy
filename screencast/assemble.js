#!/usr/bin/env node
// node assemble.js <video> [--timeline] [--no-tighten] [--size 1440p]
import { assemble } from './lib/assemble.mjs';

const argv = process.argv.slice(2);
const size = argv.includes('--size') ? argv[argv.indexOf('--size') + 1] : '1080p';
const video = argv.find((a) => !a.startsWith('--') && a !== size);
if (!video) { console.error('usage: node assemble.js <video> [--timeline] [--no-tighten]'); process.exit(2); }
try { await assemble({ video, timelineOnly: argv.includes('--timeline'), tighten: !argv.includes('--no-tighten'), size }); }
catch (e) { console.error(`FAILED ${video}: ${e.message}`); process.exit(1); }
