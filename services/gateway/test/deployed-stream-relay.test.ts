/**
 * Relaying a deployment's own SSE stream to the client (real streaming for `--deployed` models).
 * Upstream input is the raw stream captured live from the gpt-5.4 deployment on 2026-11-08
 * (test/fixtures/deployed-stream), fed in small pieces as the network delivers it.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

import { relayDeployedStream } from '../src/controllers/deployedStreamRelay';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'deployed-stream', `${name}.sse`), 'utf8');

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), { headers: {}, writes: [] as string[], headersSent: false, writableEnded: false, writable: true });
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (s: string) => { r.headersSent = true; r.writes.push(String(s)); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

/** An upstream that delivers `text` in pieces of `size` characters, one per tick. */
function upstreamOf(text: string, size = 37) {
  const s = new PassThrough();
  (async () => {
    for (let i = 0; i < text.length; i += size) {
      s.write(text.slice(i, i + size));
      await new Promise((r) => setImmediate(r));
    }
    s.end();
  })();
  return s;
}

const frames = (res: any) => res.writes.join('').split('\n\n').filter((b: string) => b.startsWith('data: ')).map((b: string) => b.slice(6));
const json = (res: any) => frames(res).filter((f: string) => f !== '[DONE]').map((f: string) => JSON.parse(f));

describe('relayDeployedStream', () => {
  it('relays the deployment\'s chunks with their text, drops prompt-filter frames, ends with one [DONE]', async () => {
    const res = mockRes();
    const result = await relayDeployedStream({ upstream: upstreamOf(fixture('gpt54-text')), res, transform: async (c) => c, clientWantsUsage: false });
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    const text = json(res).map((c: any) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Please contact MASKED_EMAIL_3f2a9c1b and MASKED_PERSON_77d0e4aa today.');
    expect(json(res).every((c: any) => Array.isArray(c.choices) && c.choices.length > 0)).toBe(true);
    expect(frames(res).filter((f: string) => f === '[DONE]')).toHaveLength(1);
    expect(frames(res).at(-1)).toBe('[DONE]');
    expect(json(res).at(-1).choices[0].finish_reason).toBe('stop');
    expect(result.usage).toMatchObject({ prompt_tokens: 39, completion_tokens: 30, total_tokens: 69 });
    expect(res.writableEnded).toBe(true);
  });

  it('forwards the usage frame only when the client asked for it', async () => {
    const res = mockRes();
    await relayDeployedStream({ upstream: upstreamOf(fixture('gpt54-text')), res, transform: async (c) => c, clientWantsUsage: true });
    const usage = json(res).filter((c: any) => c.usage);
    expect(usage).toHaveLength(1);
    expect(usage[0].choices).toEqual([]);
  });

  it('keeps the deployment\'s internal fields (routing, latency, obfuscation) out of what the client gets', async () => {
    const res = mockRes();
    await relayDeployedStream({ upstream: upstreamOf(fixture('gpt54-text')), res, transform: async (c) => c, clientWantsUsage: true });
    const text = res.writes.join('');
    for (const field of ['routing', 'serving_pipereplica', 'latency_checkpoint', 'obfuscation']) expect(text).not.toContain(`"${field}"`);
  });

  it('runs every choice chunk through the transform (the after-plugins), in order', async () => {
    const res = mockRes();
    const seen: string[] = [];
    await relayDeployedStream({
      upstream: upstreamOf(fixture('gpt54-text')), res, clientWantsUsage: false,
      transform: async (c) => { seen.push(c.choices[0].delta?.content ?? '<finish>'); return { ...c, choices: [{ ...c.choices[0], delta: { ...c.choices[0].delta, content: (c.choices[0].delta?.content ?? '').toUpperCase() } }] }; },
    });
    expect(seen.join('')).toContain('Please contact');
    expect(json(res).map((c: any) => c.choices[0].delta.content).join('')).toBe('PLEASE CONTACT MASKED_EMAIL_3F2A9C1B AND MASKED_PERSON_77D0E4AA TODAY.');
  });

  it('relays tool-call deltas as they come', async () => {
    const res = mockRes();
    await relayDeployedStream({ upstream: upstreamOf(fixture('gpt54-tools')), res, transform: async (c) => c, clientWantsUsage: false });
    const calls = json(res).flatMap((c: any) => c.choices[0].delta?.tool_calls ?? []);
    expect(calls[0].function.name).toBe('send_email');
    expect(JSON.parse(calls.map((t: any) => t.function.arguments ?? '').join(''))).toEqual({ to: 'MASKED_EMAIL_3f2a9c1b', subject: 'Invoice' });
    expect(json(res).at(-1).choices[0].finish_reason).toBe('tool_calls');
  });

  it('streams: the first chunk reaches the client before the upstream has finished', async () => {
    const res = mockRes();
    const upstream = new PassThrough();
    const relay = relayDeployedStream({ upstream, res, transform: async (c) => c, clientWantsUsage: false });
    upstream.write('data: {"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
    for (let i = 0; i < 20 && json(res).length === 0; i++) await new Promise((r) => setImmediate(r));
    expect(json(res).map((c: any) => c.choices[0].delta.content)).toEqual(['Hel']);
    upstream.end('data: {"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    await relay;
    expect(frames(res).at(-1)).toBe('[DONE]');
  });

  it('an upstream that breaks off mid-stream ends the client stream with an error frame', async () => {
    const res = mockRes();
    const upstream = new PassThrough();
    const relay = relayDeployedStream({ upstream, res, transform: async (c) => c, clientWantsUsage: false });
    upstream.write('data: {"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
    await new Promise((r) => setImmediate(r));
    upstream.destroy(new Error('socket hang up'));
    const result = await relay;
    expect(result.error?.message).toBe('socket hang up');
    expect(frames(res).some((f: string) => f !== '[DONE]' && JSON.parse(f).error)).toBe(true);
    expect(res.writableEnded).toBe(true);
  });

  it('a stream without [DONE] still ends with one', async () => {
    const res = mockRes();
    await relayDeployedStream({
      upstream: upstreamOf('data: {"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n'),
      res, transform: async (c) => c, clientWantsUsage: false,
    });
    expect(frames(res).filter((f: string) => f === '[DONE]')).toHaveLength(1);
  });
});
