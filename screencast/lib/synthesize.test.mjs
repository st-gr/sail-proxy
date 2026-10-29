import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { endpoint, speak, speakLive, firstWordHeard, spokeAsWritten, estimateCost, instructionsFor, respell, spokenChunks, wavFromPcm, wordsMissing } from './synthesize.mjs';

test('endpoint prefers OpenAI with gpt-realtime-2.1, switches to GPT-Live, falls back to the gateway relay, else none', () => {
  const o = endpoint({ OPENAI_API_KEY: 'k' });
  assert.equal(o.name, 'OpenAI'); assert.equal(o.model, 'gpt-realtime-2.1'); assert.equal(o.protocol, 'realtime');
  assert.equal(o.url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1'); assert.equal(o.headers.Authorization, 'Bearer k');
  const l = endpoint({ OPENAI_API_KEY: 'k', NARRATION_MODEL: 'gpt-live-1' });
  assert.equal(l.model, 'gpt-live-1'); assert.equal(l.protocol, 'live'); assert.equal(l.url, 'wss://api.openai.com/v1/live/sessions');
  const g = endpoint({ SAIL_PROXY_BASE: 'https://sail.example.com/', SAIL_PROXY_KEY: 'g' });
  assert.equal(g.name, 'gateway'); assert.equal(g.protocol, 'realtime'); assert.equal(g.url, 'wss://sail.example.com/gateway/openai/v1/realtime?model=gpt-realtime');
  assert.equal(endpoint({}), null);
});

test('the cost estimate uses the list price of the model', () => {
  assert.equal(estimateCost({ textIn: 1_000_000, audioOut: 1_000_000 }, 'gpt-realtime-2.1-mini'), 20.6);
  assert.equal(estimateCost({ textIn: 0, audioOut: 500_000 }, 'gpt-realtime'), 32);
  assert.equal(estimateCost({ textIn: 0, audioOut: 1_000_000 }, 'gpt-realtime-2.1'), 64);
  assert.equal(estimateCost({ textIn: 0, audioOut: 0, seconds: 120 }, 'gpt-live-1'), 0.1);
});

test('pronunciation lines become part of the instructions; "none" does not', () => {
  assert.ok(instructionsFor('Kyma: KEE-ma\nsail-proxy: sail proxy').endsWith('Pronounce: Kyma: KEE-ma; sail-proxy: sail proxy.'));
  assert.ok(!instructionsFor('none').includes('Pronounce'));
});

test('"word = respelling" lines respell whole words in the spoken text only, hyphenated names too', () => {
  const p = 'Kyma: KEE-mah\nKyma = Keema\nkubectl = kyooba-cee-tee-el';
  assert.equal(respell('The Kyma setup: setup-kyma, then kubectl. Kymatic stays.', p), 'The Keema setup: setup-Keema, then kyooba-cee-tee-el. Kymatic stays.');
  assert.equal(respell('Kyma', 'none'), 'Kyma');
  assert.ok(!instructionsFor(p).includes('Keema'));
});

test('spokenChunks cuts at sentence ends only, wavFromPcm writes a 44-byte header, wordsMissing counts', () => {
  assert.deepEqual(spokenChunks('One two. Three four five. Six.', 3), ['One two.', 'Three four five.', 'Six.']);
  assert.deepEqual(spokenChunks('Version 1.5 works. Ok.', 10), ['Version 1.5 works. Ok.']);
  const wav = wavFromPcm(Buffer.alloc(48000), 24000);
  assert.equal(wav.length, 48044); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wordsMissing('the gateway answers', 'the gateway, answers!'), 0);
  assert.equal(wordsMissing('the gateway answers', 'the answers'), 1);
});

function fakeSocket() {
  const ws = new EventEmitter(); ws.sent = [];
  ws.send = (m) => ws.sent.push(JSON.parse(m));
  ws.frame = (o) => ws.emit('message', typeof o === 'string' ? o : JSON.stringify(o));
  return ws;
}
const delta = (bytes) => ({ type: 'response.output_audio.delta', delta: Buffer.from(bytes).toString('base64') });
const done = (response) => ({ type: 'response.done', response });

test('speak resolves with the concatenated audio, the transcript and the usage', async () => {
  const ws = fakeSocket(); const p = speak(ws, 'Hello there.');
  assert.equal(ws.sent[0].item.content[0].text, 'Read aloud: Hello there.'); assert.equal(ws.sent[1].type, 'response.create');
  ws.frame(delta([1, 2])); ws.frame({ type: 'response.output_audio_transcript.delta', delta: 'Hello ' }); ws.frame(delta([3, 4])); ws.frame({ type: 'response.output_audio_transcript.delta', delta: 'there.' });
  ws.frame(done({ status: 'completed', usage: { input_tokens: 7, output_token_details: { audio_tokens: 9 } } }));
  const r = await p;
  assert.deepEqual([...r.pcm], [1, 2, 3, 4]); assert.equal(r.transcript, 'Hello there.'); assert.deepEqual(r.usage, { textIn: 7, audioOut: 9 });
  assert.equal(ws.listenerCount('message'), 0); assert.equal(ws.listenerCount('close'), 0);
});

test('speak rejects on an early close, a failed or silent response, an error event and a malformed frame', async () => {
  let ws = fakeSocket(); let p = speak(ws, 'x'); ws.frame(delta([1])); ws.emit('close');
  await assert.rejects(p, /connection closed/); assert.equal(ws.listenerCount('message'), 0);
  ws = fakeSocket(); p = speak(ws, 'x'); ws.frame(delta([1])); ws.frame(done({ status: 'failed', status_details: { error: { message: 'quota' } } }));
  await assert.rejects(p, /failed: quota/);
  ws = fakeSocket(); p = speak(ws, 'x'); ws.frame(done({ status: 'completed' }));
  await assert.rejects(p, /no audio/);
  ws = fakeSocket(); p = speak(ws, 'x'); ws.frame({ type: 'error', error: { message: 'bad model' } });
  await assert.rejects(p, /bad model/);
  ws = fakeSocket(); p = speak(ws, 'x'); assert.doesNotThrow(() => ws.frame('not json'));
  await assert.rejects(p, /not JSON/);
});

const pcm16 = (samples) => { const b = Buffer.alloc(samples.length * 2); samples.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };
const liveAudio = (samples) => ({ type: 'session.output_audio.delta', delta: pcm16(samples).toString('base64') });
const quiet = (n) => new Array(n).fill(0);
const OPTS = { silenceMs: 10, padMs: 1, waitMs: 20 }; // 240 quiet samples end a turn, 24 samples of padding, 480 samples to start

test('speakLive injects the text, ends the turn on output silence and trims it to the speech', async () => {
  const ws = fakeSocket(); const p = speakLive(ws, 'Hello there.', OPTS);
  assert.equal(ws.sent[0].type, 'session.commentary.append'); assert.equal(ws.sent[0].content, 'Hello there.'); assert.equal(ws.sent[0].delegation_id, null);
  ws.frame(liveAudio(quiet(100))); ws.frame(liveAudio([900, -900, 900]));
  ws.frame({ type: 'session.output_transcript.delta', delta: 'Hello there.' });
  ws.frame(liveAudio(quiet(239)));
  let settled = false; p.then(() => { settled = true; }); await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'one sample short of the silence still waits');
  ws.frame(liveAudio(quiet(1)));
  const r = await p;
  assert.equal(r.pcm.length, (24 + 3 + 24) * 2); assert.equal(r.pcm.readInt16LE(24 * 2), 900);
  assert.equal(r.transcript, 'Hello there.'); assert.deepEqual(r.usage, { textIn: 0, audioOut: 0 });
  assert.equal(ws.listenerCount('message'), 0); assert.equal(ws.listenerCount('close'), 0);
});

test('speakLive rejects on an error event, an early close and no speech in time', async () => {
  let ws = fakeSocket(); let p = speakLive(ws, 'x', OPTS); ws.frame({ type: 'error', error: { code: 'context_injection_incomplete', message: 'closed early' } });
  await assert.rejects(p, /closed early/); assert.equal(ws.listenerCount('message'), 0);
  ws = fakeSocket(); p = speakLive(ws, 'x', OPTS); ws.emit('close');
  await assert.rejects(p, /connection closed/);
  ws = fakeSocket(); p = speakLive(ws, 'x', OPTS); ws.frame(liveAudio(quiet(480)));
  await assert.rejects(p, /no speech/);
});

test('firstWordHeard compares the first word of the text with the first word heard, ignoring case and punctuation', () => {
  assert.equal(firstWordHeard('The cockpit is at slash admin.', 'the cockpit is at /admin'), true);
  assert.equal(firstWordHeard('The cockpit is at slash admin.', 'Cockpit is at /admin.'), false);
  assert.equal(firstWordHeard('deploy-Keema applies the manifests.', 'Deploy Kyma applies the manifests.'), true);
  assert.equal(firstWordHeard('deploy-Keema applies the manifests.', 'To deploy Kyma applies the manifests.'), false);
  assert.equal(firstWordHeard('When the rollout is done.', ''), false);
});

test('spokeAsWritten also needs the first word in the model\'s own transcript, where a preamble shows that the ear check can drop', () => {
  const text = 'You need a Docker runtime.';
  assert.equal(spokeAsWritten(text, 'You need a Docker runtime.', 'You need a Docker runtime.'), true);
  assert.equal(spokeAsWritten(text, 'You need a Docker runtime.', 'Okay, I\'ll read that aloud exactly as written: You need a Docker runtime.'), false);
  assert.equal(spokeAsWritten(text, 'Cockpit runtime.', 'You need a Docker runtime.'), false);
  assert.equal(spokeAsWritten(text, 'You need a Docker runtime.', ''), true);
});
