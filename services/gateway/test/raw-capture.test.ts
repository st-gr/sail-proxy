/**
 * Raw capture in the gateway: the sessions it learns of over Valkey, and the collectors that keep a
 * selected request's stages in memory, seal them and publish them once after the response.
 *
 * @see ../src/services/rawCapture.ts
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLog }));

import { openSealed } from '@libs/trace-seal';
import {
  applySessions, activeSessionFor, rawCaptureRunning, openCollector, recordStage, closeCollector,
  openCollectorCount, clearRawCaptureState, RawTraceMessage,
} from '../src/services/rawCapture';
import securityEventEmitter from '../src/services/securityEventEmitter';

const ENV_KEY = randomBytes(32).toString('hex');
const CANARY = 'Jane Roe lives at 7 Example Lane';
const LIMITS = { stageMaxBytes: 262144, maxStages: 40, requestMaxBytes: 2097152 };
const T0 = new Date('2026-11-13T09:00:00.000Z');
const ENDS = '2026-11-13T10:00:00.000Z';

const sessionKey = (sessions: unknown[]) => JSON.stringify({ sessions });

let savedKey: string | undefined;
let xadd: jest.Mock<(...args: string[]) => Promise<string>>;
beforeEach(() => {
  savedKey = process.env.METADATA_ENCRYPTION_KEY;
  process.env.METADATA_ENCRYPTION_KEY = ENV_KEY;
  xadd = jest.fn(async (..._args: string[]) => '1-0');
  securityEventEmitter.setValkeyClient({ status: 'ready', xadd });
  clearRawCaptureState();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.METADATA_ENCRYPTION_KEY; else process.env.METADATA_ENCRYPTION_KEY = savedKey;
  securityEventEmitter.setValkeyClient(undefined);
  clearRawCaptureState();
  jest.useRealTimers();
});

/** The one published message, parsed, and its raw JSON. */
function published(): { message: RawTraceMessage; json: string } {
  expect(xadd).toHaveBeenCalledTimes(1);
  const args = xadd.mock.calls[0];
  expect(args.slice(0, 6)).toEqual(['raw-traces', 'MAXLEN', '~', '50', '*', 'raw']);
  return { message: JSON.parse(args[6]), json: args[6] };
}

function openedStages(message: RawTraceMessage): { name: string; content: string }[] {
  const opened = openSealed(message.sealedStages, process.env);
  if (!opened.ok) throw new Error(`sealed stages did not open: ${opened.reason}`);
  return JSON.parse(opened.text);
}

describe('sessions', () => {
  it('match a credential in a session until endsAt and not one millisecond after, without any message', () => {
    applySessions(sessionKey([{ id: 's-1', credentialIds: ['cred-jane'], endsAt: ENDS }]), T0);
    expect(activeSessionFor('cred-jane', new Date('2026-11-13T09:59:59.999Z'))).toEqual(expect.objectContaining({ id: 's-1' }));
    expect(activeSessionFor('cred-jane', new Date(ENDS))).toEqual(expect.objectContaining({ id: 's-1' }));
    expect(activeSessionFor('cred-jane', new Date(Date.parse(ENDS) + 1))).toBeUndefined();
  });

  it('never match another credential, nor a request without one', () => {
    applySessions(sessionKey([{ id: 's-1', credentialIds: ['cred-jane'], endsAt: ENDS }]), T0);
    expect(activeSessionFor('cred-other', T0)).toBeUndefined();
    expect(activeSessionFor(undefined, T0)).toBeUndefined();
  });

  it('leave no session after a malformed key, with one warning', () => {
    applySessions(sessionKey([{ id: 's-1', credentialIds: ['cred-jane'], endsAt: ENDS }]), T0);
    for (const bad of ['{not json', JSON.stringify({ sessions: 'all' }), JSON.stringify({ sessions: [{ id: 's-2', credentialIds: 'cred-jane', endsAt: ENDS }] })]) {
      mockLog.warn.mockClear();
      applySessions(bad, T0);
      expect(activeSessionFor('cred-jane', T0)).toBeUndefined();
      expect(rawCaptureRunning()).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
    }
  });

  it('are cleared without a warning when the key is gone', () => {
    applySessions(sessionKey([{ id: 's-1', credentialIds: ['cred-jane'], endsAt: ENDS }]), T0);
    applySessions(null, T0);
    expect(rawCaptureRunning()).toBe(false);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('ignore a session that has already ended', () => {
    applySessions(sessionKey([{ id: 's-1', credentialIds: ['cred-jane'], endsAt: '2026-11-13T08:00:00.000Z' }]), T0);
    expect(rawCaptureRunning()).toBe(false);
  });

  it('end by themselves at endsAt, so nothing is running afterwards', () => {
    jest.useFakeTimers({ now: T0 });
    applySessions(sessionKey([{ id: 's-1', credentialIds: ['cred-jane'], endsAt: ENDS }]), new Date());
    expect(rawCaptureRunning()).toBe(true);
    jest.advanceTimersByTime(Date.parse(ENDS) - T0.getTime() + 1);
    expect(rawCaptureRunning()).toBe(false);
  });
});

describe('a collector', () => {
  it('publishes the stages recorded under its request id, in order, sealed and only once', () => {
    openCollector('req-1', 's-1', 'cred-jane', LIMITS);
    recordStage('req-1', '00_arrival', { messages: [{ role: 'user', content: CANARY }] });
    recordStage('req-other', '02_sap_request_payload', { other: true });
    recordStage('req-1', '02_sap_request_payload', { prompt: CANARY });
    recordStage('req-1', 'zz_client_response', { text: 'ok' });
    closeCollector('req-1', { statusCode: 200, complete: true });
    closeCollector('req-1', { statusCode: 200, complete: true });

    const { message, json } = published();
    expect(message).toMatchObject({ v: 1, requestId: 'req-1', sessionId: 's-1', credentialId: 'cred-jane', cutStages: false });
    expect(typeof message.capturedAt).toBe('string');
    expect(message.stageIndex.map((s) => s.name)).toEqual(['00_arrival', '02_sap_request_payload', 'zz_client_response']);
    expect(message.stageIndex.every((s) => s.cut === false && s.bytes > 0)).toBe(true);
    const stages = openedStages(message);
    expect(stages.map((s) => s.name)).toEqual(['00_arrival', '02_sap_request_payload', 'zz_client_response']);
    expect(JSON.parse(stages[1].content).payload).toEqual({ prompt: CANARY });
    expect(json).not.toContain('Jane Roe');
    expect(openCollectorCount()).toBe(0);
  });

  it('keeps the value at the time of the call, not a later change of the object', () => {
    openCollector('req-1', 's-1', 'cred-jane', LIMITS);
    const data: any = { step: 'before' };
    recordStage('req-1', '02_stage', data);
    data.step = 'after';
    closeCollector('req-1', { statusCode: 200, complete: true });
    expect(JSON.parse(openedStages(published().message)[0].content).payload).toEqual({ step: 'before' });
  });

  it('copes with circular data, buffers and streams', () => {
    openCollector('req-1', 's-1', 'cred-jane', LIMITS);
    const circular: any = { name: 'loop' };
    circular.self = circular;
    recordStage('req-1', '02_stage', { circular, buffer: Buffer.from('hello'), stream: new PassThrough() });
    closeCollector('req-1', { statusCode: 200, complete: true });
    const payload = JSON.parse(openedStages(published().message)[0].content).payload;
    expect(payload.circular.self).toBe('[Circular Reference]');
    expect(payload.buffer).toEqual({ buffer: 'base64', bytes: 5, data: Buffer.from('hello').toString('base64') });
    expect(payload.stream).toBe('[stream: not captured]');
  });

  it('gives a stage name recorded again in the same request a suffix (#2, #3) in recording order, in the index and the sealed stages', () => {
    openCollector('req-1', 's-1', 'cred-jane', { ...LIMITS, stageMaxBytes: 100 });
    recordStage('req-1', '00_arrival', { n: 0 });
    recordStage('req-1', '03_sap_response_raw', { text: 'x'.repeat(200) });
    recordStage('req-1', 'zz_client_response', { done: true });
    recordStage('req-1', '03_sap_response_raw', { n: 2 });
    recordStage('req-1', '03_sap_response_raw', { n: 3 });
    closeCollector('req-1', { statusCode: 200, complete: true });
    const { message } = published();
    const names = ['00_arrival', '03_sap_response_raw', '03_sap_response_raw#2', '03_sap_response_raw#3', 'zz_client_response'];
    expect(message.stageIndex.map((s) => s.name)).toEqual(names);
    expect(message.stageIndex.map((s) => s.cut)).toEqual([false, true, false, false, false]);
    const stages = openedStages(message);
    expect(stages.map((s) => s.name)).toEqual(names);
    expect(JSON.parse(stages[2].content).payload).toEqual({ n: 2 });
    expect(JSON.parse(stages[3].content).payload).toEqual({ n: 3 });
  });

  it('is a no-op for a request without a collector', () => {
    recordStage('req-unknown', '02_stage', { prompt: CANARY });
    closeCollector('req-unknown', { statusCode: 200, complete: true });
    expect(xadd).not.toHaveBeenCalled();
  });
});

describe('the limits', () => {
  it('cut a stage over stage_max_bytes and mark it', () => {
    openCollector('req-1', 's-1', 'cred-jane', { ...LIMITS, stageMaxBytes: 100 });
    recordStage('req-1', '02_big', { text: 'x'.repeat(500) });
    recordStage('req-1', '03_small', { ok: true });
    closeCollector('req-1', { statusCode: 200, complete: true });
    const { message } = published();
    expect(message.stageIndex[0]).toEqual({ name: '02_big', bytes: 100, cut: true });
    expect(message.stageIndex[1].cut).toBe(false);
    expect(message.cutStages).toBe(false);
    expect(Buffer.byteLength(openedStages(message)[0].content)).toBe(100);
  });

  it('keep at most max_stages, the last for the client\'s bytes, and mark the drop', () => {
    openCollector('req-1', 's-1', 'cred-jane', LIMITS);
    recordStage('req-1', '00_arrival', { n: 0 });
    for (let i = 1; i <= 45; i++) recordStage('req-1', `stage_${i}`, { n: i });
    recordStage('req-1', 'zz_client_response', { done: true });
    closeCollector('req-1', { statusCode: 200, complete: true });
    const { message } = published();
    expect(message.stageIndex).toHaveLength(40);
    expect(message.stageIndex[38].name).toBe('stage_38');
    expect(message.stageIndex[39].name).toBe('zz_client_response');
    expect(message.cutStages).toBe(true);
  });

  it('stop the request at request_max_bytes, keeping room for the client\'s stage', () => {
    // The stages before the client's may use request_max_bytes less min(stage_max_bytes, request_max_bytes / 4): 250 - 62.
    openCollector('req-1', 's-1', 'cred-jane', { stageMaxBytes: 100, maxStages: 40, requestMaxBytes: 250 });
    for (let i = 1; i <= 4; i++) recordStage('req-1', `stage_${i}`, { text: 'y'.repeat(300) });
    recordStage('req-1', 'zz_client_response', { text: 'z'.repeat(300) });
    closeCollector('req-1', { statusCode: 200, complete: true });
    const { message } = published();
    expect(message.stageIndex).toEqual([
      { name: 'stage_1', bytes: 100, cut: true },
      { name: 'stage_2', bytes: 88, cut: true },
      { name: 'zz_client_response', bytes: 62, cut: true },
    ]);
    expect(message.cutStages).toBe(true);
    expect(openedStages(message).reduce((n, s) => n + Buffer.byteLength(s.content), 0)).toBe(250);
  });

  it('let a stage after the client\'s use what the client left of request_max_bytes', () => {
    openCollector('req-1', 's-1', 'cred-jane', { stageMaxBytes: 100, maxStages: 40, requestMaxBytes: 250 });
    recordStage('req-1', 'stage_1', { text: 'y'.repeat(300) });
    recordStage('req-1', 'stage_2', { text: 'y'.repeat(300) });
    recordStage('req-1', 'zz_client_response', 'ok');
    recordStage('req-1', 'stage_3', { text: 'y'.repeat(300) });
    closeCollector('req-1', { statusCode: 200, complete: true });
    const { message } = published();
    const client = message.stageIndex.find((s) => s.name === 'zz_client_response')!;
    expect(message.stageIndex.find((s) => s.name === 'stage_3')).toEqual({ name: 'stage_3', bytes: 250 - 188 - client.bytes, cut: true });
  });

  it('open at most 50 collectors at once; more are not captured, and counted', () => {
    for (let i = 0; i < 50; i++) expect(openCollector(`req-${i}`, 's-1', 'cred-jane', LIMITS)).toBe(true);
    expect(openCollector('req-50', 's-1', 'cred-jane', LIMITS)).toBe(false);
    expect(openCollectorCount()).toBe(50);
    expect(mockLog.warn).toHaveBeenCalledWith('RawCapture', expect.stringContaining('not captured'), expect.objectContaining({ droppedSinceStart: 1 }));
  });
});

describe('publishing', () => {
  it('drops and counts the message when Valkey is not ready; the caller is unaffected', () => {
    const notReady = { status: 'connecting', xadd: jest.fn() };
    securityEventEmitter.setValkeyClient(notReady);
    const before = securityEventEmitter.droppedTraceCounts().raw;
    openCollector('req-1', 's-1', 'cred-jane', LIMITS);
    recordStage('req-1', '02_stage', { prompt: CANARY });
    expect(() => closeCollector('req-1', { statusCode: 200, complete: true })).not.toThrow();
    expect(notReady.xadd).not.toHaveBeenCalled();
    expect(securityEventEmitter.droppedTraceCounts().raw).toBe(before + 1);
    expect(openCollectorCount()).toBe(0);
  });

  it('counts a failed XADD as a drop', async () => {
    securityEventEmitter.setValkeyClient({ status: 'ready', xadd: jest.fn(async () => { throw new Error('OOM'); }) });
    const before = securityEventEmitter.droppedTraceCounts().raw;
    openCollector('req-1', 's-1', 'cred-jane', LIMITS);
    closeCollector('req-1', { statusCode: 200, complete: true });
    await new Promise((r) => setImmediate(r));
    expect(securityEventEmitter.droppedTraceCounts().raw).toBe(before + 1);
  });

  it('says once, when the first collector opens, that the seal key is weak', () => {
    process.env.METADATA_ENCRYPTION_KEY = 'short';
    openCollector('req-1', 's-1', 'cred-jane', LIMITS);
    openCollector('req-2', 's-1', 'cred-jane', LIMITS);
    const keyWarnings = mockLog.warn.mock.calls.filter((c) => String(c[1]).includes('METADATA_ENCRYPTION_KEY'));
    expect(keyWarnings).toHaveLength(1);
  });
});

describe('a session message reaching the gateway', () => {
  const ENV_KEYS = ['VALKEY_URL', 'UNIFIED_TOKEN_SYSTEM_ENABLED', 'ADMIN_SERVICE_URL', 'GATEWAY_STANDALONE', 'PAYLOAD_LOGGING_ENABLED', 'GATEWAY_LOG_SHIPPING'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    jest.dontMock('iovalkey');
  });

  /** A gateway on a fake Valkey whose raw capture key holds `fake.stored`; `fake.failReads` reads throw. */
  async function startGateway(fake: { stored: string | null; failReads: number }) {
    const listeners: ((channel: string, message: string) => unknown)[] = [];
    const subscribed: string[] = [];
    const published: string[] = [];
    const reads = { count: 0 };
    jest.resetModules();
    jest.doMock('iovalkey', () => class FakeValkey {
      on(event: string, listener: any) { if (event === 'message') listeners.push(listener); return this; }
      async subscribe(...channels: string[]) { subscribed.push(...channels); return channels.length; }
      async publish(channel: string) { published.push(channel); return 1; }
      async get(key: string) {
        if (key !== 'sap-llm-gateway:raw-capture') return null;
        reads.count++;
        if (fake.failReads > 0) { fake.failReads--; throw new Error('Connection is closed'); }
        return fake.stored;
      }
      disconnect() { /* nothing open */ }
    });
    const quiet = { ...mockLog, reinitialize: jest.fn(), applyLoggingConfig: jest.fn(), fixedByEnvironment: jest.fn(() => ({})) };
    jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quiet }));
    const clearAllCaches = jest.fn();
    jest.doMock('../src/services/modelService', () => ({ default: { clearAllCaches, getModels: async () => ({ object: 'list', data: [] }) } }));
    jest.dontMock('../src/services/configService');
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
    process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
    process.env.ADMIN_SERVICE_URL = 'http://admin.example.org';
    const configService = require('../src/services/configService');
    const rawCapture = require('../src/services/rawCapture');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const waiting = configService.getConfigAsync();
    for (let i = 0; i < 50 && published.length === 0; i++) await new Promise((r) => setImmediate(r));
    for (const l of listeners) await l('sap-llm-gateway:config-changed', JSON.stringify({ eventType: 'config-activated', version: '1', configData: { api_config: {} } }));
    await waiting;
    await settle();
    return { configService, rawCapture, listeners, subscribed, quiet, clearAllCaches, reads };
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

  it('applies the sessions of the key, read at start and on the message, without a configuration reload', async () => {
    const fake = { stored: sessionKey([{ id: 's-start', credentialIds: ['cred-jane'], endsAt: '2099-01-01T00:00:00.000Z' }]) as string | null, failReads: 0 };
    const { configService, rawCapture, listeners, subscribed, quiet, clearAllCaches } = await startGateway(fake);
    try {
      expect(subscribed).toContain('sap-llm-gateway:raw-capture-changed');
      expect(rawCapture.activeSessionFor('cred-jane', new Date())).toEqual(expect.objectContaining({ id: 's-start' }));

      quiet.reinitialize.mockClear();
      clearAllCaches.mockClear();
      fake.stored = sessionKey([{ id: 's-next', credentialIds: ['cred-john'], endsAt: '2099-01-01T00:00:00.000Z' }]);
      for (const l of listeners) await l('sap-llm-gateway:raw-capture-changed', '{}');
      await settle();
      expect(rawCapture.activeSessionFor('cred-jane', new Date())).toBeUndefined();
      expect(rawCapture.activeSessionFor('cred-john', new Date())).toEqual(expect.objectContaining({ id: 's-next' }));
      expect(quiet.reinitialize).not.toHaveBeenCalled();
      expect(clearAllCaches).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      rawCapture.clearRawCaptureState();
      await configService.closeValkeyConnections();
    }
  });

  it('re-reads the key every minute while a session is held, so a Stop whose read failed still ends the capture', async () => {
    const fake = { stored: sessionKey([{ id: 's-1', credentialIds: ['cred-jane'], endsAt: '2099-01-01T00:00:00.000Z' }]) as string | null, failReads: 0 };
    const { configService, rawCapture, listeners, reads } = await startGateway(fake);
    try {
      expect(rawCapture.rawCaptureRunning()).toBe(true);

      // Stop: the key is gone, but the read on the message fails.
      fake.stored = null;
      fake.failReads = 1;
      for (const l of listeners) await l('sap-llm-gateway:raw-capture-changed', '{}');
      await settle();
      expect(rawCapture.rawCaptureRunning()).toBe(true);

      const before = reads.count;
      jest.advanceTimersByTime(59_999);
      await settle();
      expect(reads.count).toBe(before);
      jest.advanceTimersByTime(1);
      await settle();
      expect(reads.count).toBe(before + 1);
      expect(rawCapture.rawCaptureRunning()).toBe(false);

      // No session held: no more reads.
      jest.advanceTimersByTime(10 * 60_000);
      await settle();
      expect(reads.count).toBe(before + 1);
    } finally {
      jest.clearAllTimers();
      rawCapture.clearRawCaptureState();
      await configService.closeValkeyConnections();
    }
  });

  it('keeps no re-read timer when no session is held', async () => {
    const fake = { stored: null as string | null, failReads: 0 };
    const { configService, rawCapture, reads } = await startGateway(fake);
    try {
      const before = reads.count;
      jest.advanceTimersByTime(10 * 60_000);
      await settle();
      expect(reads.count).toBe(before);
    } finally {
      jest.clearAllTimers();
      rawCapture.clearRawCaptureState();
      await configService.closeValkeyConnections();
    }
  });
});
