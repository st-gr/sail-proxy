// Speaks a script over an OpenAI voice WebSocket: OpenAI directly when OPENAI_API_KEY is set (NARRATION_MODEL,
// default gpt-realtime-2.1 over the realtime protocol; a gpt-live-* model switches to the GPT-Live protocol), else
// the gateway's realtime relay behind the TLS ingress (SAIL_PROXY_BASE, SAIL_PROXY_KEY). Keys are read from the
// environment and never written. One WAV per cued paragraph and one for the recap, plus manifest.json with
// the audio seconds, the tokens or session seconds used and the estimated cost at the model's list price.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

export const RATE = 24000;
const GAP_MS = 150;
// USD per million tokens, OpenAI's list prices as read on 2026-10-14 (2.1 and GPT-Live on 2026-10-20); the gateway
// relays the same realtime models. GPT-Live bills the session per minute instead.
export const PRICES = {
  'gpt-live-1': { perMinute: 0.05 },
  'gpt-realtime-2.1': { textIn: 4, audioOut: 64 },
  'gpt-realtime-2.1-mini': { textIn: 0.6, audioOut: 20 },
  'gpt-realtime-mini': { textIn: 0.6, audioOut: 20 },
  'gpt-realtime': { textIn: 4, audioOut: 64 }
};
// GPT-Live is full duplex: it speaks injected text only while input audio flows, and its output stream never
// ends, it turns to digital silence. Silence is fed in, and a turn ends on silenceMs of quiet output.
const LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
const QUIET = 300; // peak sample value below which output counts as silence
const MIC_MS = 100;
const LIVE_DEFAULTS = { silenceMs: 1500, padMs: 100, waitMs: 30000 };
// Both models sometimes get the first word of a chunk wrong although their own transcript has it right: GPT-Live
// swallowed it ("Cockpit is at" for "The cockpit is at"), gpt-realtime-2.1 added one ("To deploy-kyma applies").
// On OpenAI each chunk is checked by ear (gpt-4o-transcribe) and re-spoken; the gateway relay has no transcription.
// gpt-realtime-2.1 once opened a chunk with "Okay, I'll read that aloud exactly as written:", which the ear check
// dropped as filler, so the model's own transcript must start with the first word too.
const RETRIES = 2;
const BASE_INSTRUCTIONS = 'You are the narrator of a short software screencast. Read the text you are given aloud, word for word, in a calm, clear voice at an unhurried pace. Add nothing, leave nothing out, and say nothing else: never acknowledge, introduce or comment on the text.';

export function endpoint(env) {
  if (env.OPENAI_API_KEY) {
    const model = env.NARRATION_MODEL || 'gpt-realtime-2.1';
    const headers = { Authorization: `Bearer ${env.OPENAI_API_KEY}` };
    if (model.startsWith('gpt-live')) return { name: 'OpenAI', model, protocol: 'live', url: LIVE_URL, headers };
    return { name: 'OpenAI', model, protocol: 'realtime', url: `wss://api.openai.com/v1/realtime?model=${model}`, headers };
  }
  if (env.SAIL_PROXY_BASE && env.SAIL_PROXY_KEY) {
    const base = env.SAIL_PROXY_BASE.replace(/^http/, 'ws').replace(/\/$/, '');
    return { name: 'gateway', model: 'gpt-realtime', protocol: 'realtime', url: `${base}/gateway/openai/v1/realtime?model=gpt-realtime`, headers: { Authorization: `Bearer ${env.SAIL_PROXY_KEY}` } };
  }
  return null;
}

export function estimateCost(usage, model) {
  const p = PRICES[model] ?? PRICES['gpt-realtime'];
  if (p.perMinute) return Math.round(((usage.seconds ?? 0) / 60) * p.perMinute * 1000) / 1000;
  return Math.round(((usage.textIn * p.textIn + usage.audioOut * p.audioOut) / 1e6) * 1000) / 1000;
}

export function instructionsFor(pronunciation) {
  const lines = (pronunciation ?? '').split('\n').map((l) => l.trim()).filter((l) => l && l !== 'none' && l.includes(':'));
  return lines.length ? `${BASE_INSTRUCTIONS} Pronounce: ${lines.join('; ')}.` : BASE_INSTRUCTIONS;
}

// "Kyma = Keema" lines: the model reads the respelling, the script, subtitles and cards keep the word.
// Instructions alone are not enough; the model ignored them on the first word of a segment.
export function respell(text, pronunciation) {
  const pairs = (pronunciation ?? '').split('\n').map((l) => l.match(/^\s*([\w.-]+)\s*=\s*(.+?)\s*$/)).filter(Boolean);
  return pairs.reduce((t, [, word, say]) => t.replace(new RegExp(`(?<![\\w])${word.replace(/[.]/g, '\\.')}(?![\\w])`, 'gi'), say), text);
}

// Whole sentences only: a sentence ends at . ! or ? followed by a space, so "1.5" and "Look:" never split.
export function spokenChunks(script, maxWords) {
  const sentences = script.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const chunks = []; let current = []; let count = 0;
  for (const s of sentences) {
    const n = s.split(' ').length;
    if (current.length && count + n > maxWords) { chunks.push(current.join(' ')); current = []; count = 0; }
    current.push(s); count += n;
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

export function wavFromPcm(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
// How many intended words the transcript lacks (a multiset difference; extra spoken words are not counted).
export function wordsMissing(intended, spoken) {
  const have = new Map();
  for (const w of norm(spoken)) have.set(w, (have.get(w) ?? 0) + 1);
  let missing = 0;
  for (const w of norm(intended)) { const n = have.get(w) ?? 0; if (n) have.set(w, n - 1); else missing++; }
  return missing;
}

export function firstWordHeard(text, heard) {
  const [want] = norm(text); const [got] = norm(heard);
  return Boolean(want) && want === got;
}

// An empty model transcript (a relay that sends none) leaves the decision to the ear.
export function spokeAsWritten(text, heard, transcript) {
  return firstWordHeard(text, heard) && (!transcript || firstWordHeard(text, transcript));
}

async function transcribe(ep, pcm) {
  const form = new FormData(); form.append('model', 'gpt-4o-transcribe'); form.append('response_format', 'text');
  form.append('file', new Blob([wavFromPcm(pcm, RATE)], { type: 'audio/wav' }), 'chunk.wav');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: ep.headers, body: form });
  if (!r.ok) throw new Error(`the transcription check failed (HTTP ${r.status})`);
  return (await r.text()).trim();
}

// Speaks a chunk until it is heard and transcribed starting with its first word, at most RETRIES more times; keeps the last take.
async function sayChecked(say, ws, ep, text, log) {
  for (let attempt = 0; ; attempt++) {
    const r = await say(ws, text);
    const heard = await transcribe(ep, r.pcm);
    if (spokeAsWritten(text, heard, r.transcript)) return r;
    const said = firstWordHeard(text, heard) ? r.transcript : heard;
    if (attempt === RETRIES) { log(`  first word still not heard after ${RETRIES} retries: "${said.slice(0, 40)}"`); return r; }
    log(`  first word not heard ("${said.slice(0, 40)}"), speaking the chunk again`);
  }
}

export function speak(ws, text) {
  return new Promise((resolve, reject) => {
    const audio = []; let transcript = '';
    const settle = (fn, v) => { ws.off('message', onMessage); ws.off('close', onClose); fn(v); };
    const onClose = () => settle(reject, new Error('the connection closed before the response was complete'));
    const onMessage = (data) => {
      let e;
      try { e = JSON.parse(data); } catch { return settle(reject, new Error('the server sent a frame that is not JSON')); }
      if (e.type === 'response.output_audio.delta') audio.push(Buffer.from(e.delta, 'base64'));
      else if (e.type === 'response.output_audio_transcript.delta') transcript += e.delta;
      else if (e.type === 'error') settle(reject, new Error(e.error?.message ?? JSON.stringify(e.error)));
      else if (e.type === 'response.done') {
        const status = e.response?.status;
        if (status && status !== 'completed') return settle(reject, new Error(`the response ${status}${e.response?.status_details?.error?.message ? `: ${e.response.status_details.error.message}` : ''}`));
        if (!audio.length) return settle(reject, new Error('the response carried no audio'));
        const u = e.response?.usage ?? {};
        settle(resolve, { pcm: Buffer.concat(audio), transcript, usage: { textIn: u.input_tokens ?? 0, audioOut: u.output_token_details?.audio_tokens ?? 0 } });
      }
    };
    ws.on('message', onMessage);
    ws.once('close', onClose);
    ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Read aloud: ${text}` }] } }));
    ws.send(JSON.stringify({ type: 'response.create' }));
  });
}

// One injected text, one spoken turn: resolves once the speech is followed by silenceMs of quiet output, with
// the audio trimmed to the speech plus padMs on each side.
export function speakLive(ws, text, opts = {}) {
  const { silenceMs, padMs, waitMs } = { ...LIVE_DEFAULTS, ...opts };
  const quietLimit = Math.round(RATE * silenceMs / 1000); const waitLimit = Math.round(RATE * waitMs / 1000);
  return new Promise((resolve, reject) => {
    const audio = []; let transcript = ''; let samples = 0; let first = -1; let last = -1;
    const settle = (fn, v) => { ws.off('message', onMessage); ws.off('close', onClose); fn(v); };
    const onClose = () => settle(reject, new Error('the connection closed before the speech was complete'));
    const onMessage = (data) => {
      let e;
      try { e = JSON.parse(data); } catch { return settle(reject, new Error('the server sent a frame that is not JSON')); }
      if (e.type === 'session.output_transcript.delta') transcript += e.delta;
      else if (e.type === 'error') settle(reject, new Error(e.error?.message ?? JSON.stringify(e.error)));
      else if (e.type === 'session.output_audio.delta') {
        const pcm = Buffer.from(e.delta, 'base64'); audio.push(pcm);
        for (let i = 0; i + 1 < pcm.length; i += 2, samples++) if (Math.abs(pcm.readInt16LE(i)) > QUIET) { if (first < 0) first = samples; last = samples; }
        if (first < 0 && samples >= waitLimit) settle(reject, new Error(`no speech within ${waitMs} ms`));
        else if (first >= 0 && samples - 1 - last >= quietLimit) {
          const pad = Math.round(RATE * padMs / 1000);
          const all = Buffer.concat(audio);
          settle(resolve, { pcm: all.subarray(Math.max(0, first - pad) * 2, Math.min(samples, last + 1 + pad) * 2), transcript, usage: { textIn: 0, audioOut: 0 } });
        }
      }
    };
    ws.on('message', onMessage);
    ws.once('close', onClose);
    ws.send(JSON.stringify({ type: 'session.commentary.append', delegation_id: null, content: text }));
  });
}

function connectLive(ep, voice, instructions) {
  const ws = new WebSocket(ep.url, { headers: ep.headers });
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_q, r) => reject(new Error(`${ep.name} refused the connection (HTTP ${r.statusCode})`)));
    ws.on('error', reject);
    ws.on('message', (data) => {
      let e; try { e = JSON.parse(data); } catch { return; }
      if (e.type === 'session.usage.updated') ws.liveSeconds = e.usage?.seconds ?? ws.liveSeconds; // cumulative
      else if (e.type === 'error' && !ws.mic) reject(new Error(e.error?.message ?? JSON.stringify(e.error)));
      else if (e.type === 'session.started') {
        const silence = JSON.stringify({ type: 'session.input_audio.append', audio: Buffer.alloc(RATE * 2 * MIC_MS / 1000).toString('base64') });
        ws.mic = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(silence); }, MIC_MS);
        resolve(ws);
      } else if (e.type === 'session.closed') ws.emit('live-closed');
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.start', session: { model: ep.model, instructions, audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice } } } })));
  });
}

// Ends the session and waits up to 15 s for session.closed, so the last cumulative usage update is in.
function closeLive(ws) {
  clearInterval(ws.mic);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); ws.close(); resolve(ws.liveSeconds ?? 0); };
    const t = setTimeout(done, 15000);
    ws.once('live-closed', done);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.close' })); else done();
  });
}

function connect(ep, voice, instructions) {
  const ws = new WebSocket(ep.url, { headers: ep.headers });
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_q, r) => reject(new Error(`${ep.name} refused the connection (HTTP ${r.statusCode})`)));
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'], instructions, audio: { output: { format: { type: 'audio/pcm', rate: RATE }, voice } } } }));
      resolve(ws);
    });
  });
}

async function speakText(ws, text, maxWords, label, log, say) {
  const parts = []; const gap = Buffer.alloc(Math.round(RATE * 2 * GAP_MS / 1000)); let missing = 0; const usage = { textIn: 0, audioOut: 0 };
  for (const [i, chunk] of spokenChunks(text, maxWords).entries()) {
    const r = await say(ws, chunk);
    const m = wordsMissing(chunk, r.transcript); missing += m;
    if (m) log(`  ${label}, chunk ${i + 1}: ${m} intended word(s) not in the transcript`);
    usage.textIn += r.usage.textIn; usage.audioOut += r.usage.audioOut;
    parts.push(r.pcm, gap);
  }
  return { pcm: Buffer.concat(parts), missing, usage };
}

export async function synthesize({ script, outDir, ep, voice, maxWords = 60, log = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const live = ep.protocol === 'live';
  const ws = await (live ? connectLive : connect)(ep, voice, instructionsFor(script.pronunciation));
  const plain = live ? (w, t) => speakLive(w, t) : speak;
  const say = ep.name === 'OpenAI' ? (w, t) => sayChecked(plain, w, ep, t, log) : plain;
  const manifest = { model: ep.model, endpoint: ep.name, voice, segments: [], recap: null, usage: { textIn: 0, audioOut: 0 }, cost: 0, missing: 0 };
  const save = (name, pcm) => { writeFileSync(join(outDir, name), wavFromPcm(pcm, RATE)); return Math.round((pcm.length / (RATE * 2)) * 100) / 100; };
  const add = (r) => { manifest.usage.textIn += r.usage.textIn; manifest.usage.audioOut += r.usage.audioOut; manifest.missing += r.missing; };
  try {
    for (const [i, seg] of script.spoken.entries()) {
      const r = await speakText(ws, respell(seg.text, script.pronunciation), maxWords, `segment ${i + 1}`, log, say); add(r);
      const file = `seg-${String(i + 1).padStart(2, '0')}.wav`;
      manifest.segments.push({ at: seg.at, label: seg.label, file, seconds: save(file, r.pcm) });
    }
    const r = await speakText(ws, respell(script.recap, script.pronunciation), maxWords, 'recap', log, say); add(r);
    manifest.recap = { file: 'recap.wav', seconds: save('recap.wav', r.pcm) };
  } finally {
    if (live) manifest.usage.seconds = await closeLive(ws); else ws.close();
  }
  manifest.cost = estimateCost(manifest.usage, ep.model);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
