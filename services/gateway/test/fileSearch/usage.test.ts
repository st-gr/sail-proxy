/**
 * Unit tests for the file_search usage emitter (phase 4b, research note §3.1).
 * No Valkey and no admin service: with no Valkey client the real emitter queues
 * in memory, which is what the standalone test reads.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockStandalone = jest.fn(() => false);
jest.mock('../../src/config/unifiedAuthConfig', () => ({
  isStandaloneMode: () => mockStandalone(),
}));

// usageTracker (extractAuthInfo) reaches configService through siemUsageEvent; the real
// module builds an AdminServiceClient at import time.
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => ({ api_config: {} }) },
  getConfig: () => ({ api_config: {} }),
  getTrustForwardedFor: () => false,
}));

import { getDefaultLogger } from '@libs/logger';
import usageEmitter from '../../src/services/usageEventEmitter';
import { buildFileSearchUsageEvent } from '../../src/fileSearch/usageEvent';
import { currentSapTarget, installSapTarget, latestSapTarget, withSapTarget, withLatestSapTarget } from '../../src/sap/sapTarget';
import {
  emitFileSearchUsage, fileSearchCallerOf, storedFileSearchCaller, workerRequestId, derivedRequestId, FileSearchCaller,
  searchUsageSink, completionUsageRecord,
} from '../../src/fileSearch/usage';

const CALLER: FileSearchCaller = { credentialId: 'key-1', authType: 'api_key' };
const USAGE = {
  endpoint: 'file_search/ingest' as const,
  model: 'text-embedding-3-large',
  inputTokens: 42,
  unit: 'tokens' as const,
  responseTime: 17,
  requestId: 'fs-ingest-abc',
};

describe('emitFileSearchUsage', () => {
  beforeEach(() => {
    mockStandalone.mockReturnValue(false);
    usageEmitter.getAndClearMemoryQueue();
    jest.restoreAllMocks();
  });

  it('emits one event with the fixed file_search shape', () => {
    const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);
    const before = Math.floor(Date.now() / 1000);

    emitFileSearchUsage({ ...CALLER, onBehalfOf: 'ada@example.com' }, USAGE);

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][0];
    expect(event).toEqual({
      requestId: 'fs-ingest-abc',
      timestamp: expect.any(Number),
      authType: 'api_key',
      credentialId: 'key-1',
      onBehalfOf: 'ada@example.com',
      provider: 'unknown',
      model: 'text-embedding-3-large',
      inputTokens: 42,
      outputTokens: 0,
      responseTime: 17,
      statusCode: 200,
      endpoint: 'file_search/ingest',
      unit: 'tokens',
      sapTenant: currentSapTarget().tenant,
      sapTenantSource: currentSapTarget().source,
    });
    // Unix seconds, as the main tracker emits and the admin reads (`timestamp * 1000`).
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThan(1e11);
    expect(Number.isInteger(event.timestamp)).toBe(true);
  });

  it('carries the SAP tenant the call was served by: the request\'s pinned target, else the latest (workers)', () => {
    const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);
    const target = (tenant: string) => ({
      ...latestSapTarget(), aiCoreUrl: `https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com/${tenant}`,
      authUrl: `https://${tenant}.authentication.eu10.hana.ondemand.com/oauth/token`, tenant,
      source: 'connection' as const, connectionId: `conn-${tenant}`,
    });
    installSapTarget(target('initech-one'));
    const pinned = latestSapTarget();
    installSapTarget(target('initech-two'));

    withSapTarget(pinned, () => emitFileSearchUsage(CALLER, { ...USAGE, requestId: 'fs-in-request' }));
    emitFileSearchUsage(CALLER, { ...USAGE, requestId: 'fs-in-worker' });

    expect(emit.mock.calls.map(([e]) => [e.requestId, e.sapTenant, e.sapTenantSource])).toEqual([
      ['fs-in-request', 'initech-one', 'connection'],
      ['fs-in-worker', 'initech-two', 'connection'],
    ]);
  });

  it('a worker job keeps the target its SAP call was made with when another is installed meanwhile', async () => {
    const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);
    const target = (tenant: string) => ({
      ...latestSapTarget(), authUrl: `https://${tenant}.authentication.eu10.hana.ondemand.com/oauth/token`, tenant,
      source: 'connection' as const, connectionId: `conn-${tenant}`,
    });
    installSapTarget(target('umbrella-one'));
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    // A (faked) slow SAP call: it reads the target when it starts, the event is emitted when it ends.
    const job = withLatestSapTarget(async () => {
      const calledWith = currentSapTarget().tenant;
      await slow;
      emitFileSearchUsage(CALLER, { ...USAGE, requestId: 'fs-ingest-slow' });
      return calledWith;
    });
    installSapTarget(target('umbrella-two'));
    release();
    expect(await job).toBe('umbrella-one');
    expect(emit.mock.calls[0][0]).toMatchObject({ requestId: 'fs-ingest-slow', sapTenant: 'umbrella-one' });
  });

  it('buildFileSearchUsageEvent stamps whole Unix seconds from the given clock', () => {
    const event = buildFileSearchUsageEvent(CALLER, USAGE, 1_791_331_200_999);
    expect(event.timestamp).toBe(1_791_331_200);
  });

  it('leaves onBehalfOf off the event when the caller has none', () => {
    const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);

    emitFileSearchUsage(CALLER, { ...USAGE, endpoint: 'file_search/rerank', unit: 'units', inputTokens: 1 });

    const event = emit.mock.calls[0][0];
    expect('onBehalfOf' in event).toBe(false);
    expect(event.unit).toBe('units');
    expect(event.endpoint).toBe('file_search/rerank');
  });

  it('emits nothing for a null caller: a credential is never invented', () => {
    const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);

    emitFileSearchUsage(null, USAGE);

    expect(emit).not.toHaveBeenCalled();
  });

  it('logs a warning with the error and lets no rejection escape when the emitter rejects', async () => {
    jest.spyOn(usageEmitter, 'emit').mockRejectedValue(new Error('boom'));
    const warn = jest.spyOn(getDefaultLogger(), 'warn').mockImplementation(() => undefined as any);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => emitFileSearchUsage(CALLER, USAGE)).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(warn).toHaveBeenCalledWith('FileSearchUsage', 'Failed to emit file_search usage event', {
        requestId: 'fs-ingest-abc', error: 'boom',
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('queues the event when not standalone', async () => {
    emitFileSearchUsage(CALLER, USAGE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(usageEmitter.getQueueSize()).toBe(1);
  });

  it('records nothing in standalone mode', async () => {
    mockStandalone.mockReturnValue(true);
    emitFileSearchUsage(CALLER, USAGE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(usageEmitter.getQueueSize()).toBe(0);
  });
});

describe('fileSearchCallerOf', () => {
  it('a cockpit call is billed to the service key on behalf of the acting user', () => {
    const req: any = {
      serviceAuth: { authType: 'service-key', serviceKey: { id: 'svc-key-id', email: 'admin2gateway.service.key' } },
      groundingActor: { email: 'ada@example.com', role: 'user' },
      apiKeyInfo: { active: true, email: 'ada@example.com', authSource: 'grounding' },
    };
    expect(fileSearchCallerOf(req)).toEqual({
      credentialId: 'svc-key-id', authType: 'api_key', onBehalfOf: 'ada@example.com',
    });
  });

  it('a cockpit call without a service key id has no caller', () => {
    const req: any = { groundingActor: { email: 'ada@example.com', role: 'user' }, serviceAuth: {} };
    expect(fileSearchCallerOf(req)).toBeNull();
  });

  it('an OpenAI-API caller is billed to its own key, with no onBehalfOf', () => {
    const req: any = { unifiedAuth: { valid: true, authType: 'api_key', data: { id: 'user-key' } } };
    expect(fileSearchCallerOf(req)).toEqual({ credentialId: 'user-key', authType: 'api_key' });
  });

  it('an AWS credential caller keeps its auth type', () => {
    const req: any = { unifiedAuth: { valid: true, authType: 'aws_credential', data: { credentialId: 'AKIDEXAMPLE' } } };
    expect(fileSearchCallerOf(req)).toEqual({ credentialId: 'AKIDEXAMPLE', authType: 'aws_credential' });
  });

  it('an unidentified credential is no caller, not "unknown"', () => {
    const req: any = { unifiedAuth: { valid: true, authType: 'api_key', data: {} } };
    expect(fileSearchCallerOf(req)).toBeNull();
  });

  it('an unauthenticated request has no caller', () => {
    expect(fileSearchCallerOf({} as any)).toBeNull();
  });
});

describe('storedFileSearchCaller', () => {
  it('is null without a credential, whatever else was stored', () => {
    expect(storedFileSearchCaller(null, 'api_key', 'a@example.test')).toBeNull();
    expect(storedFileSearchCaller(undefined, null)).toBeNull();
    expect(storedFileSearchCaller('', 'api_key')).toBeNull();
  });

  it('keeps an AWS credential and reads anything else as an API key', () => {
    expect(storedFileSearchCaller('aws-1', 'aws_credential')).toEqual({ credentialId: 'aws-1', authType: 'aws_credential' });
    expect(storedFileSearchCaller('key-1', null)).toEqual({ credentialId: 'key-1', authType: 'api_key' });
  });

  it('names the acting user only when one was stored', () => {
    expect(storedFileSearchCaller('svc', 'api_key', 'u@example.test'))
      .toEqual({ credentialId: 'svc', authType: 'api_key', onBehalfOf: 'u@example.test' });
    expect(storedFileSearchCaller('key-1', 'api_key', null)).not.toHaveProperty('onBehalfOf');
  });
});

describe('request ids', () => {
  it('worker ids are prefixed by kind and unique per call', () => {
    const ids = new Set(Array.from({ length: 200 }, () => workerRequestId('ingest')));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^fs-ingest-[0-9a-f-]{36}$/);
    expect(workerRequestId('reembed')).toMatch(/^fs-reembed-[0-9a-f-]{36}$/);
    expect(workerRequestId('context')).toMatch(/^fs-context-[0-9a-f-]{36}$/);
  });

  it('a derived id appends the suffix to the request id', () => {
    expect(derivedRequestId('req-123', 'fs-embed-1')).toBe('req-123-fs-embed-1');
    expect(derivedRequestId('req-123', 'fs-rerank')).toBe('req-123-fs-rerank');
    expect(derivedRequestId('req-123', 'fs-2-embed-1')).toBe('req-123-fs-2-embed-1');
  });

  it('falls back to a fresh uuid for a missing or "unknown" base, so two events never share an id', () => {
    for (const base of [undefined, '', 'unknown']) {
      const a = derivedRequestId(base, 'fs-embed-1');
      const b = derivedRequestId(base, 'fs-embed-1');
      expect(a).toMatch(/^[0-9a-f-]{36}-fs-embed-1$/);
      expect(a).not.toBe(b);
    }
  });

  it('stays within 100 characters and keeps the suffix, so long bases still give distinct ids', () => {
    const base = 'x'.repeat(150);
    const one = derivedRequestId(base, 'fs-embed-1');
    const two = derivedRequestId(base, 'fs-embed-2');
    expect(one.length).toBeLessThanOrEqual(100);
    expect(two.length).toBeLessThanOrEqual(100);
    expect(one.endsWith('-fs-embed-1')).toBe(true);
    expect(one).not.toBe(two);
  });
});

describe('searchUsageSink', () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  const EMBED = { endpoint: 'file_search/search' as const, model: 'm-a', inputTokens: 3, unit: 'tokens' as const, responseTime: 5 };
  const RERANK = { endpoint: 'file_search/rerank' as const, model: 'rr', inputTokens: 1, unit: 'units' as const, responseTime: 8 };

  it('numbers embedding events and names the rerank event, from the request id', () => {
    const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);
    const sink = searchUsageSink(CALLER, 'req-9');
    sink(EMBED);
    sink({ ...EMBED, model: 'm-b' });
    sink(RERANK);
    expect(emit.mock.calls.map((c) => c[0].requestId)).toEqual(['req-9-fs-embed-1', 'req-9-fs-embed-2', 'req-9-fs-rerank']);
    expect(emit.mock.calls.map((c) => c[0].model)).toEqual(['m-a', 'm-b', 'rr']);
    expect(emit.mock.calls[0][0]).toMatchObject({ credentialId: 'key-1', inputTokens: 3, unit: 'tokens', responseTime: 5 });
  });

  it('puts a call index into the ids when given one', () => {
    const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);
    const sink = searchUsageSink(CALLER, 'req-9', 3);
    sink(EMBED);
    sink(RERANK);
    expect(emit.mock.calls.map((c) => c[0].requestId)).toEqual(['req-9-fs-3-embed-1', 'req-9-fs-3-rerank']);
  });

  it('records nothing for a null caller', () => {
    const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);
    searchUsageSink(null, 'req-9')(EMBED);
    expect(emit).not.toHaveBeenCalled();
  });

  it('names the rewrite event and carries its output tokens', () => {
    const emit = jest.spyOn(usageEmitter, 'emit').mockResolvedValue(undefined);
    const sink = searchUsageSink(CALLER, 'req-9');
    sink({ ...completionUsageRecord('file_search/rewrite', 'gpt-5-mini', { input: 30, cacheWrite: 0, cachedRead: 0, output: 9 }, 400) });
    sink(EMBED);
    expect(emit.mock.calls.map((c) => c[0].requestId)).toEqual(['req-9-fs-rewrite', 'req-9-fs-embed-1']);
    expect(emit.mock.calls[0][0]).toMatchObject({
      endpoint: 'file_search/rewrite', model: 'gpt-5-mini', inputTokens: 30, outputTokens: 9, unit: 'tokens', responseTime: 400,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    });
  });
});

describe('completion usage on the event (file_search/context and file_search/rewrite)', () => {
  // Our split: input = uncached INCLUDING cache writes, cacheWrite ⊆ input, cachedRead disjoint.
  // The event: inputTokens = full-rate only, cacheCreationInputTokens = writes,
  // cacheReadInputTokens = reads — the admin adds all four, so nothing is billed twice.
  it('maps the split onto the event fields so the admin total equals the whole prompt plus output', () => {
    const rec = completionUsageRecord('file_search/context', 'anthropic--claude-4.5-haiku',
      { input: 11279, cacheWrite: 11266, cachedRead: 0, output: 40 }, 900);
    const event = buildFileSearchUsageEvent(CALLER, { ...rec, requestId: 'fs-context-1' });
    expect(event).toMatchObject({
      endpoint: 'file_search/context', model: 'anthropic--claude-4.5-haiku', unit: 'tokens',
      inputTokens: 13, cacheCreationInputTokens: 11266, cacheReadInputTokens: 0, outputTokens: 40, responseTime: 900,
    });
    const read = buildFileSearchUsageEvent(CALLER, {
      ...completionUsageRecord('file_search/context', 'gemini-3.5-flash-lite', { input: 28, cacheWrite: 0, cachedRead: 2034, output: 30 }, 5),
      requestId: 'fs-context-2',
    });
    expect(read).toMatchObject({ inputTokens: 28, cacheCreationInputTokens: 0, cacheReadInputTokens: 2034, outputTokens: 30 });
    const total = (e: any) => e.inputTokens + e.outputTokens + e.cacheCreationInputTokens + e.cacheReadInputTokens;
    expect(total(event)).toBe(11279 + 40);
    expect(total(read)).toBe(28 + 2034 + 30);
  });

  it('an embedding event keeps its exact shape: no cache fields, output 0', () => {
    const event = buildFileSearchUsageEvent(CALLER, USAGE);
    expect(event).not.toHaveProperty('cacheCreationInputTokens');
    expect(event).not.toHaveProperty('cacheReadInputTokens');
    expect(event.outputTokens).toBe(0);
  });
});
