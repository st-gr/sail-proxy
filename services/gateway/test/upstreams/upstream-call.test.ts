/**
 * The call to a connection's upstream and its failures (spec 2026-10-23 §5.4): one retry only on a
 * connection reset before any response, the upstream status passed through, the body normalised to
 * the client's shape, and every credential value redacted before it reaches the client, a log or a
 * payload log (OpenAI echoes a wrong key in its 401 message).
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const logged: string[] = [];
const record = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, (_k, v) => (v instanceof Error ? v.message : v)))).join(' ')); };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ debug: record, info: record, warn: record, error: record, trace: record }) }));
const saved: any[] = [];
jest.mock('../../src/utils/payloadLogger', () => ({ savePayload: (id: string, label: string, data: unknown) => { saved.push([id, label, data]); } }));
jest.mock('../../src/services/configService', () => ({ __esModule: true, default: { getTimeout: () => 5000 }, getTimeout: () => 5000 }));

import { startFakeProviderServer, FakeProviderServer } from '../fakeProviderServer';
import { callUpstream, redact, sendUpstreamError } from '../../src/upstreams/upstreamCall';
import type { ProviderAdapter } from '../../src/upstreams/types';

let fake: FakeProviderServer;
beforeAll(async () => { fake = await startFakeProviderServer(); });
afterAll(async () => { await fake.close(); });
beforeEach(() => { fake.requests.length = 0; logged.length = 0; saved.length = 0; });

const adapter = { secrets: () => ['sk-test-123'] } as unknown as ProviderAdapter;
const req = (path = '/v1/chat/completions') => ({ url: `${fake.url}${path}`, headers: { Authorization: 'Bearer sk-test-123' }, body: { model: 'gpt-4o-mini' } });

describe('callUpstream', () => {
  it('retries once on a reset before any response, never on a 500', async () => {
    fake.script([{ kind: 'reset' }, { kind: 'json', body: { ok: 1 } }]);
    const ok = await callUpstream(req(), { stream: false });
    expect(ok.status).toBe(200);
    expect(fake.requests).toHaveLength(2);

    fake.requests.length = 0;
    fake.script([{ kind: 'status', status: 500 }]);
    await expect(callUpstream(req(), { stream: false })).rejects.toMatchObject({ response: { status: 500 } });
    expect(fake.requests).toHaveLength(1);
  });

  it('a stream response comes back as a stream', async () => {
    fake.script([{ kind: 'sse', frames: ['{"a":1}', '[DONE]'] }]);
    const r = await callUpstream(req(), { stream: true });
    let text = '';
    for await (const chunk of r.data) text += chunk.toString();
    expect(text).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
  });
});

describe('redact', () => {
  it('replaces every secret, longest first, and ignores empty ones', () => {
    expect(redact('key sk-test-123 and sk-test-123 again', ['', 'sk-test', 'sk-test-123'])).toBe('key [REDACTED] and [REDACTED] again');
  });
});

describe('sendUpstreamError', () => {
  const run = async (behaviour: any) => {
    fake.script([behaviour]);
    const app = express();
    app.post('/', async (r: any, res) => {
      r.debugRequestId = 'dbg-1';
      try { await callUpstream(req(), { stream: false }); res.json({}); } catch (e) { await sendUpstreamError(r, res, e, adapter, 'openai'); }
    });
    return request(app).post('/');
  };

  it('status passed through, key redacted from body, log and payload log', async () => {
    const r = await run({ kind: 'status', status: 401, body: { error: { message: 'Incorrect API key provided: sk-test-123', type: 'invalid_request_error', code: 'invalid_api_key' } } });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toContain('[REDACTED]');
    expect(JSON.stringify(r.body)).not.toContain('sk-test-123');
    expect(r.body.error.code).toBe('invalid_api_key');
    expect(logged.join('\n')).not.toContain('sk-test-123');
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain('sk-test-123');
  });

  it('a stream error body is drained and redacted too', async () => {
    fake.script([{ kind: 'status', status: 429, body: { error: { message: 'Rate limit for sk-test-123' } } }]);
    const app = express();
    app.post('/', async (r: any, res) => {
      try { await callUpstream(req(), { stream: true }); res.json({}); } catch (e) { await sendUpstreamError(r, res, e, adapter, 'openai'); }
    });
    const r = await request(app).post('/');
    expect(r.status).toBe(429);
    expect(JSON.stringify(r.body)).not.toContain('sk-test-123');
  });

  it('a transport failure is 502, a timeout 504, in the anthropic shape when asked', async () => {
    const app = express();
    app.post('/', async (r: any, res) => {
      const error = r.query.t ? Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }) : Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      await sendUpstreamError(r, res, error, adapter, 'anthropic');
    });
    const refused = await request(app).post('/');
    expect(refused.status).toBe(502);
    expect(refused.body.type).toBe('error');
    expect((await request(app).post('/?t=1')).status).toBe(504);
  });
});
