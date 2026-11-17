/**
 * Thinking round trip. A model writes placeholders into its thinking; the client is shown the real
 * values, and the upstream must get back, on the next turn, exactly the text it signed.
 *
 * Before (0.12.1 too): a placeholder whole in one stream frame was restored, one split across
 * frames was not, and a restored value shorter than 12 characters went back upstream in plain text
 * inside the thinking block (2026-11-17, found in the 0.13.0 rehearsal).
 *
 * Now: thinking is always restored for the client, and the signature carries a restore record
 * (placeholders and positions, never a value) that the gateway strips and applies on the way back.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }),
  createSafePreview: () => '',
  createHeadersPreview: () => '',
}));

const mockConfig: any = { api_config: {} };
jest.mock('../src/services/configService', () => {
  const svc: Record<string, any> = {
    getConfig: () => mockConfig,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
  };
  const proxy = new Proxy(svc, { get: (t, k: string) => (k in t ? t[k] : (k === '__esModule' ? true : () => undefined)) });
  return { __esModule: true, default: proxy, ...svc };
});

import pseudonymizationRules = require('../src/plugins/pseudonymization/index');
import { ReplacementMap } from '../src/pluginSupport/pseudonymization/replacementMap';
import {
  RECORD_MARK, applyRecord, restoreThinkingBlocks, splitSignature, unmaskThinkingBlocks, unmaskWithRecord,
} from '../src/pluginSupport/pseudonymization/thinkingRoundTrip';
import { ThinkingStream } from '../src/plugins/pseudonymization/thinkingStream';
import { EMAIL, TEXT, configFor, mockRes } from './forcedRouteHarness';

const PLACEHOLDER = /MASKED_EMAIL_[0-9a-f]+/;
const SIGNATURE = 'EqQBCkgIBhABGAIiQL9hb3V0cHV0K3NpZ25hdHVyZS9vZitDbGF1ZGU9PQ==';
const SHORT = 'jr@ex.org'; // under the 12 characters the request-wide propagation starts at
const silent = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const handler = (strategy: string) => (pseudonymizationRules as any[]).find((r) => r.strategy === strategy).handler;

/** A map holding `values`, as a request that mentioned them would have. */
function mapOf(...values: string[]): ReplacementMap {
  const map = new ReplacementMap();
  for (const value of values) map.getPlaceholder('profile-email', value);
  return map;
}

/**
 * The plugin's before handler on `body`; returns the request and its response double. `exact` is
 * what the controller hands over: the signatures restoreThinkingBlocks rebuilt exactly.
 */
async function masked(body: any, exact?: Set<string>) {
  const req: any = { __endpoint: 'aws-bedrock', debugRequestId: 'gateway-test', headers: {}, body, __thinkingExact: exact };
  const res: any = mockRes();
  expect(await handler('before')({ req, res, utils: { logger: silent } })).toEqual({ stop: false });
  return { req, res };
}
const invokeBody = (messages: any[]) => ({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 64, messages });
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const written = (res: any): any[] => res.writes.join('').split('\n\n').filter(Boolean).map((b: string) => JSON.parse(b.slice(b.indexOf('data: ') + 6)));
const thinkingDelta = (thinking: string, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
const signatureDelta = (signature: string, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } });

beforeEach(() => {
  mockConfig.api_config = configFor(['aws-bedrock']);
});

describe('the restore record', () => {
  it('unmasking records where each placeholder stood; applying the record gives the masked text back', () => {
    const map = mapOf(EMAIL, SHORT);
    const [a, b] = [map.forward.get(EMAIL)!, map.forward.get(SHORT)!];
    const original = `Mail ${a} first, then ${b}, then ${a} again.`;
    const { text, replacements } = unmaskWithRecord(original, map);
    expect(text).toBe(`Mail ${EMAIL} first, then ${SHORT}, then ${EMAIL} again.`);
    expect(replacements).toHaveLength(3);

    const { signature, record, marked } = splitSignature(SIGNATURE + unmaskThinkingBlocksSuffix(original, map));
    expect(marked).toBe(true);
    expect(signature).toBe(SIGNATURE);
    expect(applyRecord(text, record!)).toBe(original);
  });

  it('holds placeholders and positions, never a value', () => {
    const map = mapOf(EMAIL);
    const suffix = unmaskThinkingBlocksSuffix(`Mail ${map.forward.get(EMAIL)} now.`, map);
    expect(suffix.startsWith(RECORD_MARK)).toBe(true);
    const decoded = Buffer.from(suffix.slice(RECORD_MARK.length), 'base64url').toString('utf8');
    expect(decoded).toContain(map.forward.get(EMAIL));
    expect(decoded).not.toContain(EMAIL);
    expect(decoded).not.toContain('example.org');
  });

  it('a text the client changed is refused (the hash of the rebuilt text differs)', () => {
    const map = mapOf(EMAIL);
    const original = `Mail ${map.forward.get(EMAIL)} now.`;
    const { text } = unmaskWithRecord(original, map);
    const { record } = splitSignature(SIGNATURE + unmaskThinkingBlocksSuffix(original, map));
    expect(applyRecord(text.replace('now', 'later'), record!)).toBeNull();
    expect(applyRecord(text.slice(0, 8), record!)).toBeNull();
  });

  it('a signature without a mark is untouched; a mark with an unreadable record is still stripped', () => {
    expect(splitSignature(SIGNATURE)).toEqual({ signature: SIGNATURE, record: null, marked: false });
    expect(splitSignature(`${SIGNATURE}${RECORD_MARK}not-a-record.`)).toEqual({ signature: SIGNATURE, record: null, marked: true });
    expect(splitSignature(`${SIGNATURE}${RECORD_MARK}cut-off`)).toEqual({ signature: SIGNATURE, record: null, marked: true });
  });

  it('the record is closed: a signature that continues after it is put together again', () => {
    // An upstream that sends the signature in two events: the record sits on the first, and a
    // client that concatenates them holds first + record + second.
    const map = mapOf(EMAIL);
    const original = `Mail ${map.forward.get(EMAIL)} now.`;
    const suffix = unmaskThinkingBlocksSuffix(original, map);
    const { signature, record } = splitSignature(`${SIGNATURE.slice(0, 20)}${suffix}${SIGNATURE.slice(20)}`);
    expect(signature).toBe(SIGNATURE);
    expect(applyRecord(`Mail ${EMAIL} now.`, record!)).toBe(original);
  });

  it('a stream cut at any point gives the same text and record as the whole text', () => {
    const map = mapOf(EMAIL, SHORT);
    const [a, b] = [map.forward.get(EMAIL)!, map.forward.get(SHORT)!];
    const original = `Plan: write ${a}, cc ${b}. PM me the M in MASKED, then ${a}.`;
    const whole = unmaskWithRecord(original, map);
    for (let cut = 1; cut < original.length; cut++) {
      const stream = new ThinkingStream(map);
      const text = stream.append(original.slice(0, cut)) + stream.append(original.slice(cut)) + stream.flush();
      expect(text).toBe(whole.text);
      const { record } = splitSignature(SIGNATURE + stream.seal());
      expect(applyRecord(text, record!)).toBe(original);
    }
  });

  it('a block without a placeholder gets a record too: it says the text is the model\'s, unchanged', () => {
    // Without it the next request could not tell this block from one an older gateway restored,
    // and would mask known values in text the model wrote and signed.
    const stream = new ThinkingStream(mapOf(EMAIL));
    const text = stream.append('Nothing to restore here.') + stream.flush();
    expect(text).toBe('Nothing to restore here.');
    const { record } = splitSignature(SIGNATURE + stream.seal());
    expect(record!.r).toEqual([]);
    expect(applyRecord(text, record!)).toBe(text);
  });

  it('a surrogate pair cut by a delta does not spoil the record', () => {
    const map = mapOf(EMAIL);
    const original = `Mail ${map.forward.get(EMAIL)} \u{1F600} done.`;
    const cut = original.indexOf('\u{1F600}') + 1; // between the two halves of the pair
    const stream = new ThinkingStream(map);
    const text = stream.append(original.slice(0, cut)) + stream.append(original.slice(cut)) + stream.flush();
    expect(applyRecord(text, splitSignature(SIGNATURE + stream.seal()).record!)).toBe(original);
  });

  it('a delta after the block was sealed does not throw; the text is still restored', () => {
    const map = mapOf(EMAIL);
    const stream = new ThinkingStream(map);
    stream.append(`Plan for ${map.forward.get(EMAIL)}. `);
    stream.flush();
    stream.seal();
    expect(stream.append(`Also ${map.forward.get(EMAIL)} later.`) + stream.flush()).toBe(`Also ${EMAIL} later.`);
  });
});

/** The suffix a non-streaming unmask appends for `original`. */
function unmaskThinkingBlocksSuffix(original: string, map: ReplacementMap): string {
  const body = { content: [{ type: 'thinking', thinking: original, signature: SIGNATURE }] };
  unmaskThinkingBlocks(body, map);
  return body.content[0].signature.slice(SIGNATURE.length);
}

describe('a streamed answer', () => {
  it.each([
    ['whole in one frame', (ph: string) => [`The user wants mail to ${ph} today.`]],
    ['split after MASKED', (ph: string) => [`The user wants mail to ${ph.slice(0, 6)}`, `${ph.slice(6)} today.`]],
    ['split inside the id', (ph: string) => [`The user wants mail to ${ph.slice(0, -3)}`, `${ph.slice(-3)} today.`]],
    ['the placeholder ends the thinking', (ph: string) => ['The user wants mail to ', ph]],
  ])('thinking, placeholder %s: the client reads the value, the signature carries the record', async (_name, deltas) => {
    const { req, res } = await masked(invokeBody([{ role: 'user', content: [{ type: 'text', text: TEXT }] }]));
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    const parts = deltas(placeholder);
    res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
    for (const part of parts) res.write(frame(thinkingDelta(part)));
    res.write(frame(signatureDelta(SIGNATURE)));
    res.write(frame({ type: 'content_block_stop', index: 0 }));
    res.write(frame({ type: 'message_stop' }));
    res.end();

    const events = written(res);
    const types = events.map((e) => e.delta?.type || e.type);
    const thinking = events.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join('');
    expect(thinking).toBe(parts.join('').replace(placeholder, EMAIL));
    expect(thinking).not.toMatch(/MASKED_/);
    // All of the thinking is out before the signature: a client may close the block on it.
    expect(types.lastIndexOf('thinking_delta')).toBeLessThan(types.indexOf('signature_delta'));
    const signatures = events.filter((e) => e.delta?.type === 'signature_delta');
    expect(signatures).toHaveLength(1);
    const { signature, record } = splitSignature(signatures[0].delta.signature);
    expect(signature).toBe(SIGNATURE);
    expect(applyRecord(thinking, record!)).toBe(parts.join(''));
  });

  it('thinking without a placeholder: the text passes unchanged, the record says so', async () => {
    const { res } = await masked(invokeBody([{ role: 'user', content: [{ type: 'text', text: TEXT }] }]));
    const frames = [frame(thinkingDelta('Just a plan, no names.')), frame(signatureDelta(SIGNATURE)), frame({ type: 'content_block_stop', index: 0 })];
    for (const f of frames) res.write(f);
    res.end();
    const events = written(res);
    expect(events.find((e) => e.delta?.type === 'thinking_delta').delta.thinking).toBe('Just a plan, no names.');
    const { signature, record } = splitSignature(events.find((e) => e.delta?.type === 'signature_delta').delta.signature);
    expect(signature).toBe(SIGNATURE);
    expect(applyRecord('Just a plan, no names.', record!)).toBe('Just a plan, no names.');
  });

  it.each([
    ['in the same frame', (ph: string) => [`Ask MASKED_PERSON_99999999 then mail ${ph} today.`]],
    ['cut by the frame', (ph: string) => ['Ask MASKED_PERSON_9999', `9999 then mail ${ph} today.`]],
  ])('a placeholder the model invented, %s: it stays in the thinking as written and the record still fits', async (_name, deltas) => {
    // The answer text withholds an invented placeholder ("[name withheld]"); thinking must not, or
    // the client holds a text the record does not describe and the upstream gets a changed one.
    const { req, res } = await masked(invokeBody([{ role: 'user', content: [{ type: 'text', text: TEXT }] }]));
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    const parts = deltas(placeholder);
    for (const part of parts) res.write(frame(thinkingDelta(part)));
    res.write(frame(signatureDelta(SIGNATURE)));
    res.write(frame({ type: 'content_block_stop', index: 0 }));
    res.write(frame({ type: 'message_stop' }));
    res.end();
    const events = written(res);
    const thinking = events.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join('');
    expect(thinking).toBe(`Ask MASKED_PERSON_99999999 then mail ${EMAIL} today.`);
    const { record } = splitSignature(events.find((e) => e.delta?.type === 'signature_delta').delta.signature);
    expect(applyRecord(thinking, record!)).toBe(parts.join(''));
  });

  it('frames with an event name: synthetic frames carry one too', async () => {
    const { req, res } = await masked(invokeBody([{ role: 'user', content: [{ type: 'text', text: TEXT }] }]));
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    const named = (event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    res.write(named(thinkingDelta(`Mail ${placeholder.slice(0, 8)}`)));
    res.write(named(thinkingDelta(placeholder.slice(8))));
    res.write(named(signatureDelta(SIGNATURE)));
    res.write(named({ type: 'content_block_stop', index: 0 }));
    res.end();
    const blocks = res.writes.join('').split('\n\n').filter(Boolean);
    expect(blocks.every((b: string) => /^event: [a-z_]+\ndata: \{/.test(b))).toBe(true);
    const events = blocks.map((b: string) => JSON.parse(b.slice(b.indexOf('data: ') + 6)));
    expect(events.filter((e: any) => e.delta?.type === 'thinking_delta').map((e: any) => e.delta.thinking).join('')).toBe(`Mail ${EMAIL}`);
  });

  it('thinking without a signature: restored for the client, nothing invented', async () => {
    const { req, res } = await masked(invokeBody([{ role: 'user', content: [{ type: 'text', text: TEXT }] }]));
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    res.write(frame(thinkingDelta(`Mail ${placeholder.slice(0, 9)}`)));
    res.write(frame(thinkingDelta(placeholder.slice(9))));
    res.write(frame({ type: 'content_block_stop', index: 0 }));
    res.end();
    const events = written(res);
    expect(events.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join('')).toBe(`Mail ${EMAIL}`);
    expect(events.some((e) => e.delta?.type === 'signature_delta')).toBe(false);
  });

  it('two thinking blocks keep their own records', async () => {
    const { req, res } = await masked(invokeBody([{ role: 'user', content: [{ type: 'text', text: TEXT }] }]));
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    for (const index of [0, 2]) {
      res.write(frame(thinkingDelta(`${'x'.repeat(index)}Mail ${placeholder}.`, index)));
      res.write(frame(signatureDelta(`${SIGNATURE}${index}`, index)));
      res.write(frame({ type: 'content_block_stop', index }));
    }
    res.end();
    const events = written(res);
    for (const index of [0, 2]) {
      const mine = events.filter((e) => e.index === index);
      const thinking = mine.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join('');
      const { signature, record } = splitSignature(mine.find((e) => e.delta?.type === 'signature_delta').delta.signature);
      expect(signature).toBe(`${SIGNATURE}${index}`);
      expect(applyRecord(thinking, record!)).toBe(`${'x'.repeat(index)}Mail ${placeholder}.`);
    }
  });

  it('a Converse stream (reasoningContent): the same', async () => {
    const { req, res } = await masked({ messages: [{ role: 'user', content: [{ text: TEXT }] }] });
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    const delta = (d: any) => frame({ contentBlockDelta: { contentBlockIndex: 0, delta: d } });
    res.write(delta({ reasoningContent: { text: `Mail ${placeholder.slice(0, 10)}` } }));
    res.write(delta({ reasoningContent: { text: `${placeholder.slice(10)} now.` } }));
    res.write(delta({ reasoningContent: { signature: SIGNATURE } }));
    res.write(frame({ contentBlockStop: { contentBlockIndex: 0 } }));
    res.write(frame({ messageStop: { stopReason: 'end_turn' } }));
    res.end();
    const reasoning = written(res).map((e) => e.contentBlockDelta?.delta?.reasoningContent).filter(Boolean);
    const text = reasoning.map((r) => r.text ?? '').join('');
    expect(text).toBe(`Mail ${EMAIL} now.`);
    const signatures = reasoning.filter((r) => typeof r.signature === 'string');
    expect(signatures).toHaveLength(1);
    const { signature, record } = splitSignature(signatures[0].signature);
    expect(signature).toBe(SIGNATURE);
    expect(applyRecord(text, record!)).toBe(`Mail ${placeholder} now.`);
  });
});

describe('an answer in one piece', () => {
  it('Anthropic message: thinking restored, signature marked, once', async () => {
    const { req, res } = await masked(invokeBody([{ role: 'user', content: [{ type: 'text', text: TEXT }] }]));
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    const upstream = {
      type: 'message', role: 'assistant',
      content: [{ type: 'thinking', thinking: `Mail ${placeholder} now.`, signature: SIGNATURE }, { type: 'text', text: `Sent to ${placeholder}.` }],
    };
    const out = await handler('after')({ req, res, upstreamResponse: upstream, utils: { logger: silent } });
    expect(out.content[0].thinking).toBe(`Mail ${EMAIL} now.`);
    expect(out.content[1].text).toBe(`Sent to ${EMAIL}.`);
    const { signature, record } = splitSignature(out.content[0].signature);
    expect(signature).toBe(SIGNATURE);
    expect(applyRecord(out.content[0].thinking, record!)).toBe(`Mail ${placeholder} now.`);

    // res.json runs afterwards on the same body: nothing is marked twice.
    res.json(out);
    expect(res.body.content[0].signature).toBe(out.content[0].signature);
  });

  it('a placeholder the model invented stays in the thinking as written; the answer text withholds it', async () => {
    const { req, res } = await masked(invokeBody([{ role: 'user', content: [{ type: 'text', text: TEXT }] }]));
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    const original = `Ask MASKED_PERSON_99999999 then mail ${placeholder} today.`;
    const upstream = { type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: original, signature: SIGNATURE }, { type: 'text', text: 'Ask MASKED_PERSON_99999999.' }] };
    res.json(await handler('after')({ req, res, upstreamResponse: upstream, utils: { logger: silent } }));
    const block = res.body.content[0];
    expect(block.thinking).toBe(`Ask MASKED_PERSON_99999999 then mail ${EMAIL} today.`);
    expect(applyRecord(block.thinking, splitSignature(block.signature).record!)).toBe(original);
    expect(res.body.content[1].text).not.toContain('MASKED_PERSON_99999999');
  });

  it('a cache hit sent through res.json alone: the same', async () => {
    const { req, res } = await masked(invokeBody([{ role: 'user', content: [{ type: 'text', text: TEXT }] }]));
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    const cached = { type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: `Mail ${placeholder} now.`, signature: SIGNATURE }] };
    res.json(cached);
    expect(res.body.content[0].thinking).toBe(`Mail ${EMAIL} now.`);
    expect(applyRecord(res.body.content[0].thinking, splitSignature(res.body.content[0].signature).record!)).toBe(`Mail ${placeholder} now.`);
    // The stored object is not changed in place.
    expect(cached.content[0].signature).toBe(SIGNATURE);
  });

  it('Converse output (reasoningContent.reasoningText): the same', async () => {
    const { req, res } = await masked({ messages: [{ role: 'user', content: [{ text: TEXT }] }] });
    const placeholder = JSON.stringify(req.body).match(PLACEHOLDER)![0];
    const upstream = { output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: `Mail ${placeholder} now.`, signature: SIGNATURE } } }, { text: 'ok' }] } } };
    const out = await handler('after')({ req, res, upstreamResponse: upstream, utils: { logger: silent } });
    const reasoning = out.output.message.content[0].reasoningContent.reasoningText;
    expect(reasoning.text).toBe(`Mail ${EMAIL} now.`);
    expect(applyRecord(reasoning.text, splitSignature(reasoning.signature).record!)).toBe(`Mail ${placeholder} now.`);
  });
});

describe('the next request', () => {
  /** Turn 2 of a tool loop: the client returns the thinking and signature it was given. */
  const turnTwo = (thinking: string, signature: string | undefined, user = TEXT) => invokeBody([
    { role: 'user', content: [{ type: 'text', text: user }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking, ...(signature === undefined ? {} : { signature }) }, { type: 'tool_use', id: 't1', name: 'send', input: { to: EMAIL } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] },
  ]);
  const thinkingOf = (body: any) => body.messages[1].content[0];

  /** What the client holds after a first answer whose thinking was `original`. */
  function clientCopy(original: string, map: ReplacementMap) {
    const body = { content: [{ type: 'thinking', thinking: original, signature: SIGNATURE }] };
    unmaskThinkingBlocks(body, map);
    return body.content[0];
  }

  it('the marked signature: the upstream gets the signature and the thinking it sent, byte for byte', async () => {
    const map = mapOf(EMAIL);
    const original = `The user wants mail to ${map.forward.get(EMAIL)} today. PM.`;
    const held = clientCopy(original, map);
    expect(held.thinking).toContain(EMAIL);

    const body = turnTwo(held.thinking, held.signature);
    const summary = restoreThinkingBlocks(body);
    expect(summary).toMatchObject({ restored: 1, unreadable: 0 });
    await masked(body, summary.exact);
    expect(thinkingOf(body)).toEqual({ type: 'thinking', thinking: original, signature: SIGNATURE });
    expect(JSON.stringify(body)).not.toContain(EMAIL);
    expect(JSON.stringify(body)).not.toContain(RECORD_MARK);
  });

  it('with masking off on the later turn the mark is still stripped and the text restored', () => {
    const map = mapOf(EMAIL);
    const original = `Mail ${map.forward.get(EMAIL)} now.`;
    const held = clientCopy(original, map);
    const body = turnTwo(held.thinking, held.signature);
    restoreThinkingBlocks(body);
    expect(thinkingOf(body)).toEqual({ type: 'thinking', thinking: original, signature: SIGNATURE });
  });

  it('Converse reasoning in the request: the same', () => {
    const map = mapOf(EMAIL);
    const original = `Mail ${map.forward.get(EMAIL)} now.`;
    const held = clientCopy(original, map);
    const body = { messages: [{ role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: held.thinking, signature: held.signature } } }] }] };
    restoreThinkingBlocks(body);
    expect(body.messages[0].content[0].reasoningContent.reasoningText).toEqual({ text: original, signature: SIGNATURE });
  });

  it('thinking the client changed: the mark is stripped and the known values are masked again', async () => {
    const map = mapOf(EMAIL);
    const held = clientCopy(`Mail ${map.forward.get(EMAIL)} now.`, map);
    const body = turnTwo(`${held.thinking} (edited)`, held.signature);
    expect(restoreThinkingBlocks(body)).toMatchObject({ restored: 0, unreadable: 1 });
    await masked(body);
    expect(thinkingOf(body).signature).toBe(SIGNATURE);
    expect(thinkingOf(body).thinking).toMatch(PLACEHOLDER);
    expect(JSON.stringify(body)).not.toContain(EMAIL);
  });

  it('a short value in returned thinking without a record is masked again (it went upstream in plain text)', async () => {
    const body = turnTwo(`Hello ${SHORT}, welcome.`, SIGNATURE, `Please email ${SHORT} about the invoice.`);
    restoreThinkingBlocks(body);
    await masked(body);
    expect(body.messages[0].content[0].text).not.toContain(SHORT);
    expect(thinkingOf(body).thinking).not.toContain(SHORT);
    expect(thinkingOf(body).thinking).toMatch(/^Hello MASKED_EMAIL_[0-9a-f]+, welcome\.$/);
    expect(thinkingOf(body).signature).toBe(SIGNATURE);
  });

  it('a block the gateway passed unchanged stays unchanged, though its text holds a value the request masks', async () => {
    // The model wrote the plain value itself (it had seen it unmasked); the block was signed with it.
    const map = mapOf(EMAIL);
    const original = `The docs example uses ${SHORT} as a sample address.`;
    const held = clientCopy(original, map);
    expect(held.thinking).toBe(original);
    const body = turnTwo(held.thinking, held.signature, `Please email ${SHORT} about the invoice.`);
    await masked(body, restoreThinkingBlocks(body).exact);
    expect(thinkingOf(body)).toEqual({ type: 'thinking', thinking: original, signature: SIGNATURE });
  });

  it('without a record, a value is masked also where it touches a word character', async () => {
    const body = turnTwo(`Saved as backup_${SHORT} and x${SHORT}; plain ${SHORT}.`, SIGNATURE, `Please email ${SHORT} about the invoice.`);
    await masked(body, restoreThinkingBlocks(body).exact);
    expect(thinkingOf(body).thinking).not.toContain(SHORT);
    expect(thinkingOf(body).thinking.match(/MASKED_EMAIL_[0-9a-f]+/g)).toHaveLength(3);
  });

  it('a restored block is not touched again, even where its text holds a known value by itself', async () => {
    // The model wrote the plain word that is also a masked value elsewhere in the request.
    const map = mapOf(EMAIL);
    const original = `Mail ${map.forward.get(EMAIL)}; the literal text ${SHORT} stays as the model wrote it.`;
    const held = clientCopy(original, map);
    const body = turnTwo(held.thinking, held.signature, `Please email ${EMAIL} and ${SHORT}.`);
    await masked(body, restoreThinkingBlocks(body).exact);
    expect(thinkingOf(body).thinking).toBe(original);
  });

  it('thinking without a signature is masked like any text', async () => {
    const other = 'max.muster@example.net';
    const body = turnTwo(`Also tell ${other}.`, undefined);
    restoreThinkingBlocks(body);
    await masked(body);
    expect(thinkingOf(body).thinking).not.toContain(other);
    expect(thinkingOf(body).thinking).toMatch(PLACEHOLDER);
  });

  it('the signature itself is never rewritten by the request-wide propagation', async () => {
    // A signature that happens to contain a masked value of 12+ characters.
    const body = turnTwo('Plain plan.', `AAAA+${EMAIL}/BBBB`);
    restoreThinkingBlocks(body);
    await masked(body);
    expect(thinkingOf(body).signature).toBe(`AAAA+${EMAIL}/BBBB`);
  });
});
