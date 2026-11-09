#!/usr/bin/env node
// node narrate.js <video> [--voice=marin] [--max-words=60]: speaks videos/<video>/script.md into
// out/<video>/audio/. OPENAI_API_KEY (OpenAI, gpt-realtime-2.1, or NARRATION_MODEL=gpt-live-1) or SAIL_PROXY_BASE + SAIL_PROXY_KEY
// (the gateway relay) must be in the environment; nothing is read from a file.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/record.mjs';
import { parseScript } from './lib/script.mjs';
import { endpoint, synthesize } from './lib/synthesize.mjs';

const argv = process.argv.slice(2);
const video = argv.find((a) => !a.startsWith('--'));
const flag = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
if (!video) { console.error('usage: node narrate.js <video> [--voice=marin] [--max-words=60]'); process.exit(2); }
const scriptPath = join(ROOT, 'videos', video, 'script.md');
if (!existsSync(scriptPath)) { console.error(`no videos/${video}/script.md`); process.exit(2); }
const ep = endpoint(process.env);
if (!ep) { console.error('set OPENAI_API_KEY (OpenAI) or SAIL_PROXY_BASE and SAIL_PROXY_KEY (gateway relay) in the environment'); process.exit(2); }
const script = parseScript(readFileSync(scriptPath, 'utf8'));
const voice = flag('voice', script.meta.voice || 'marin');
try {
  const m = await synthesize({ script, outDir: join(ROOT, 'out', video, 'audio'), ep, voice, maxWords: Number(flag('max-words', 60)), log: console.log });
  const spoken = m.segments.reduce((n, s) => n + s.seconds, 0);
  console.log(`${video}: ${m.segments.length} segments, ${spoken.toFixed(1)} s spoken in a ${script.meta.target_seconds} s video, recap ${m.recap.seconds.toFixed(1)} s${m.missing ? `, ${m.missing} word(s) differ` : ''}`);
  const used = m.usage.seconds === undefined ? `${m.usage.audioOut} audio tokens, ${m.usage.textIn} text tokens` : `${m.usage.seconds} session seconds`;
  console.log(`${used}: about ${m.cost.toFixed(3)} USD on ${m.model} (${m.endpoint})`);
} catch (e) { console.error(`FAILED ${video}: ${e.message}`); process.exit(1); }
