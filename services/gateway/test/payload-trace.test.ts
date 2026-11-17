/**
 * The light payload trace: one per request while capture is on. Masked text may travel in the
 * clear; an unmasked prompt travels only sealed and its answer is never captured.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'events';

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => mockLogger,
}));

const mockConfig: any = { api_config: { observability: {} } };
jest.mock('../src/services/configService', () => {
  const actual: any = jest.requireActual('../src/services/configService');
  return {
    __esModule: true,
    ...actual,
    default: { getConfig: () => mockConfig },
    getCachedConfig: () => mockConfig,
    getTrustForwardedFor: () => false,
  };
});

import { openSealed } from '@libs/trace-seal';
import { buildPayloadTrace, emitPayloadTrace } from '../src/services/payloadTrace';
import { beginStreamContentCapture } from '../src/services/siemUsageEvent';
import { getStreamCapture, installStreamCapture } from '../src/services/siemStreamCapture';
import securityEventEmitter from '../src/services/securityEventEmitter';

const ENV_KEY = randomBytes(32).toString('hex');
const CANARY = 'Jane Roe';
const CTX = { model: 'gpt-4o', statusCode: 200, durationMs: 42, inputTokens: 11, outputTokens: 7 };

const ENV_NAMES = ['VALKEY_URL', 'ADMIN_SERVICE_URL', 'UNIFIED_TOKEN_SYSTEM_ENABLED', 'GATEWAY_STANDALONE', 'METADATA_ENCRYPTION_KEY'];
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_NAMES) savedEnv[k] = process.env[k];
  process.env.VALKEY_URL = 'redis://localhost:6379';
  process.env.ADMIN_SERVICE_URL = 'http://localhost:4004';
  process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
  delete process.env.GATEWAY_STANDALONE;
  process.env.METADATA_ENCRYPTION_KEY = ENV_KEY;
  mockConfig.api_config.observability = { payload_capture: { enabled: true } };
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  securityEventEmitter.setValkeyClient(undefined);
});

function req(extra: any = {}): any {
  return {
    headers: {},
    originalUrl: '/openai/v1/chat/completions?x=1',
    debugRequestId: 'req-1',
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: `Write to ${CANARY}` }] },
    ...extra,
  };
}

describe('buildPayloadTrace', () => {
  it('a masked request carries the masked prompt and answer, no sealed prompt, no restored name', () => {
    const r = req({
      __pseudonymization: { maskedInputs: ['Write to MASKED_PERSON_1a2b'], config: { method: 'pseudonymization' } },
      __siemMaskedResponse: 'Dear MASKED_PERSON_1a2b, hello',
    });
    const m = buildPayloadTrace(r, CTX, process.env)!;
    expect(m).toMatchObject({
      v: 1, requestId: 'req-1', endpoint: '/openai/v1/chat/completions', model: 'gpt-4o', statusCode: 200,
      durationMs: 42, inputTokens: 11, outputTokens: 7, masked: true, truncated: false, raw: false,
      prompt: 'Write to MASKED_PERSON_1a2b', answer: 'Dear MASKED_PERSON_1a2b, hello',
    });
    expect(m.sealedPrompt).toBeUndefined();
    expect(m.omitted).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain(CANARY);
    expect(typeof m.capturedAt).toBe('string');
  });

  it('a request that was not masked keeps its prompt sealed and no answer', () => {
    const r = req({ __siemMaskedResponse: `reply to ${CANARY}` });
    const m = buildPayloadTrace(r, CTX, process.env)!;
    expect(m.masked).toBe(false);
    expect(m.omitted).toBe('not-captured');
    expect(m.prompt).toBeUndefined();
    expect(m.answer).toBeUndefined();
    const opened = openSealed(m.sealedPrompt!, process.env);
    expect(opened).toEqual({ ok: true, text: `Write to ${CANARY}` });
    expect(JSON.stringify(m)).not.toContain(CANARY);
  });

  it('an anonymized request keeps its masked prompt and no answer', () => {
    const r = req({ __pseudonymization: { maskedInputs: ['Write to MASKED_PERSON_1a2b'], config: { method: 'anonymization' } } });
    const m = buildPayloadTrace(r, CTX, process.env)!;
    expect(m.masked).toBe(true);
    expect(m.prompt).toBe('Write to MASKED_PERSON_1a2b');
    expect(m.answer).toBeUndefined();
    expect(m.omitted).toBe('not-captured');
  });

  it('a streamed answer the client hung up on is stream-incomplete', () => {
    const r = req({
      __pseudonymization: { maskedInputs: ['Write to MASKED_PERSON_1a2b'], config: { method: 'pseudonymization' } },
      __siemStreamIncomplete: true,
    });
    const m = buildPayloadTrace(r, CTX, process.env)!;
    expect(m.omitted).toBe('stream-incomplete');
    expect(m.answer).toBeUndefined();
  });

  it('a masked prompt is cut at the byte cap and says so', () => {
    const r = req({ __pseudonymization: { maskedInputs: ['a'.repeat(20000)], config: { method: 'pseudonymization' } } });
    const m = buildPayloadTrace(r, CTX, process.env)!;
    expect(Buffer.byteLength(m.prompt!)).toBe(8192);
    expect(m.truncated).toBe(true);
  });

  it('sets raw from the raw session id', () => {
    expect(buildPayloadTrace(req({ __rawCaptureSessionId: 'sess-1' }), CTX, process.env)!.raw).toBe(true);
  });

  it('builds nothing in the standalone gateway', () => {
    process.env.GATEWAY_STANDALONE = 'true';
    expect(buildPayloadTrace(req(), CTX, process.env)).toBeNull();
  });

  it('builds nothing while capture is off or without VALKEY_URL', () => {
    mockConfig.api_config.observability = {};
    expect(buildPayloadTrace(req(), CTX, process.env)).toBeNull();
    mockConfig.api_config.observability = { payload_capture: { enabled: true } };
    delete process.env.VALKEY_URL;
    expect(buildPayloadTrace(req(), CTX, process.env)).toBeNull();
  });
});

describe('buildPayloadTrace with payload capture off, in a raw capture session', () => {
  beforeEach(() => { mockConfig.api_config.observability = {}; });

  it('a request that was not masked leaves its facts only: no content, not-captured, raw', () => {
    const message = buildPayloadTrace(req({ __rawCaptureSessionId: 'sess-1' }), CTX, process.env)!;
    expect(message).toMatchObject({
      v: 1, requestId: 'req-1', endpoint: '/openai/v1/chat/completions', model: 'gpt-4o', statusCode: 200, durationMs: 42,
      inputTokens: 11, outputTokens: 7, masked: false, truncated: false, omitted: 'not-captured', raw: true
    });
    expect(message).not.toHaveProperty('prompt');
    expect(message).not.toHaveProperty('answer');
    expect(message).not.toHaveProperty('sealedPrompt');
    expect(JSON.stringify(message)).not.toContain(CANARY);
  });

  it('a masked request keeps neither its masked prompt nor its answer', () => {
    const masked = req({
      __rawCaptureSessionId: 'sess-1',
      __pseudonymization: { maskedInputs: [`MASKED_PERSON_1a2b and ${CANARY}`] },
      __siemMaskedResponse: `Hello ${CANARY}`
    });
    const message = buildPayloadTrace(masked, CTX, process.env)!;
    expect(message).toMatchObject({ masked: true, omitted: 'not-captured', raw: true });
    for (const field of ['prompt', 'answer', 'sealedPrompt']) expect(message).not.toHaveProperty(field);
    expect(JSON.stringify(message)).not.toContain(CANARY);
    expect(JSON.stringify(message)).not.toContain('MASKED_PERSON');
  });

  it('outside a raw session it builds nothing', () => {
    expect(buildPayloadTrace(req(), CTX, process.env)).toBeNull();
  });

  it('emitPayloadTrace publishes the facts-only trace', async () => {
    const xadd = jest.fn(async (..._a: any[]) => '1-0');
    securityEventEmitter.setValkeyClient({ status: 'ready', xadd } as any);
    await emitPayloadTrace(req({ __rawCaptureSessionId: 'sess-1' }), CTX);
    expect(xadd).toHaveBeenCalledTimes(1);
    const published = String(xadd.mock.calls[0][6]);
    expect(JSON.parse(published)).toMatchObject({ raw: true, omitted: 'not-captured' });
    expect(published).not.toContain(CANARY);
  });
});

describe('emitPayloadTrace', () => {
  it('appends to the payload-traces stream with a MAXLEN cap', async () => {
    const xadd = jest.fn(async (..._a: any[]) => '1-0');
    securityEventEmitter.setValkeyClient({ status: 'ready', xadd } as any);
    await emitPayloadTrace(req(), CTX);
    expect(xadd).toHaveBeenCalledTimes(1);
    const args = xadd.mock.calls[0].map(String);
    expect(args.slice(0, 6)).toEqual(['payload-traces', 'MAXLEN', '~', '1000', '*', 'trace']);
    expect(JSON.parse(args[6]).requestId).toBe('req-1');
  });

  it('returns at once when the publish never resolves', async () => {
    securityEventEmitter.setValkeyClient({ status: 'ready', xadd: () => new Promise(() => {}) } as any);
    const outcome = await Promise.race([emitPayloadTrace(req(), CTX).then(() => 'returned'), new Promise(r => setTimeout(() => r('hung'), 500))]);
    expect(outcome).toBe('returned');
  });

  it('drops the trace without throwing when Valkey is not ready or the publish fails', async () => {
    securityEventEmitter.setValkeyClient({ status: 'connecting', xadd: jest.fn() } as any);
    await expect(emitPayloadTrace(req(), CTX)).resolves.toBeUndefined();
    securityEventEmitter.setValkeyClient({ status: 'ready', xadd: jest.fn(async () => { throw new Error('boom'); }) } as any);
    await expect(emitPayloadTrace(req(), CTX)).resolves.toBeUndefined();
  });

  it('publishes nothing while capture is off', async () => {
    mockConfig.api_config.observability = {};
    const xadd = jest.fn(async () => '1-0');
    securityEventEmitter.setValkeyClient({ status: 'ready', xadd } as any);
    await emitPayloadTrace(req(), CTX);
    expect(xadd).not.toHaveBeenCalled();
  });

  describe('a trace that cannot be built', () => {
    // A BigInt cannot be stringified: the build/stringify step throws.
    const unbuildable = { ...CTX, inputTokens: BigInt(1) as unknown as number };
    const dropWarnings = () => mockLogger.warn.mock.calls.filter(c => String(c[1]).includes('Payload traces could not be published'));
    afterEach(() => { jest.useRealTimers(); });

    it('is dropped and counted with the other payload trace drops, never logged per request', async () => {
      jest.useFakeTimers({ now: Date.now() + 10 * 86_400_000 });
      const xadd = jest.fn(async (..._a: any[]) => '1-0');
      securityEventEmitter.setValkeyClient({ status: 'ready', xadd } as any);
      mockLogger.warn.mockClear();
      const before = securityEventEmitter.droppedTraceCounts().payload;

      await expect(emitPayloadTrace(req(), unbuildable)).resolves.toBeUndefined();
      await expect(emitPayloadTrace(req(), unbuildable)).resolves.toBeUndefined();

      expect(xadd).not.toHaveBeenCalled();
      expect(securityEventEmitter.droppedTraceCounts().payload).toBe(before + 2);
      expect(mockLogger.warn.mock.calls.filter(c => String(c[1]).includes('Failed to emit payload trace'))).toHaveLength(0);
      expect(dropWarnings()).toHaveLength(1);
    });

    it('warns once for two drops inside a minute and again after a minute', async () => {
      jest.useFakeTimers({ now: Date.now() + 20 * 86_400_000 });
      mockLogger.warn.mockClear();

      await emitPayloadTrace(req(), unbuildable);
      jest.setSystemTime(Date.now() + 30_000);
      await emitPayloadTrace(req(), unbuildable);
      expect(dropWarnings()).toHaveLength(1);

      jest.setSystemTime(Date.now() + 30_001);
      await emitPayloadTrace(req(), unbuildable);
      expect(dropWarnings()).toHaveLength(2);
      expect(dropWarnings()[1][2]).toEqual({ droppedSinceStart: securityEventEmitter.droppedTraceCounts().payload });
    });
  });
});

describe('the stream capture', () => {
  const streamed = () => req({ body: { model: 'gpt-4o', stream: true, messages: [] } });
  const res = () => new EventEmitter() as any;

  it('starts for a streamed request when capture is on, with no SIEM sink asking for content', () => {
    const r = streamed();
    beginStreamContentCapture(r, res());
    expect(getStreamCapture(r)).toBeDefined();
  });

  it('starts nothing when capture is off', () => {
    mockConfig.api_config.observability = {};
    const r = streamed();
    beginStreamContentCapture(r, res());
    expect(getStreamCapture(r)).toBeUndefined();
  });

  it('emitPayloadTrace waits for a started capture to settle', async () => {
    const xadd = jest.fn(async (..._a: any[]) => '1-0');
    securityEventEmitter.setValkeyClient({ status: 'ready', xadd } as any);
    const r = streamed();
    const s = res();
    installStreamCapture(r, s, 8192)!.append('after-chain', 'MASKED_PERSON_1a2b said hi');
    const done = emitPayloadTrace(r, CTX);
    await new Promise(x => setTimeout(x, 20));
    expect(xadd).not.toHaveBeenCalled();
    s.emit('finish');
    await done;
    expect(xadd).toHaveBeenCalledTimes(1);
  });
});
