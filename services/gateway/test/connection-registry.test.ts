/**
 * The gateway's in-memory Connections snapshot (spec 2026-10-23 §4.2): pulled from the admin,
 * refetched on the change marker or after 60 s, single-flight, and kept - never dropped - when a
 * refetch fails. Credentials live in it, so nothing it logs may carry an error body.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const logged: string[] = [];
const record = (...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ debug: record, info: record, warn: record, error: record, trace: record }) }));

import { ConnectionRegistry, SNAPSHOT_TTL_MS, RETRY_AFTER_FAILURE_MS, FRESH_WAIT_MS } from '../src/connections/connectionRegistry';
import type { Connection, ConnectionBackend } from '../src/connections/types';

const conn = (name: string, published: string[] = []): Connection => ({
  id: `id-${name}`, name, providerType: 'openai', settings: { baseUrl: 'https://api.openai.com/v1' },
  credentials: { secret: 'sk-secret' },
  models: published.map((upstream) => ({ modelId: `${upstream}--${name}`, upstreamModel: upstream, displayName: null, family: 'openai', capabilities: ['chat'], priced: true })),
});

function setup(initial: Connection[] = [conn('oa', ['gpt-4o'])]) {
  let now = 1_000_000;
  let next: Connection[] | Error = initial;
  const fetch = jest.fn(async () => { if (next instanceof Error) throw next; return next; });
  const backend: ConnectionBackend = { fetch };
  const registry = new ConnectionRegistry(backend, () => now);
  return {
    registry, fetch,
    advance: (ms: number) => { now += ms; },
    respond: (value: Connection[] | Error) => { next = value; },
  };
}

beforeEach(() => { logged.length = 0; });

describe('ConnectionRegistry', () => {
  it('fetches once for concurrent callers', async () => {
    const { registry, fetch } = setup();
    await Promise.all([registry.ensureFresh(), registry.ensureFresh(), registry.ensureFresh()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(registry.connections().map((c) => c.name)).toEqual(['oa']);
  });

  it('serves the cached snapshot within the TTL and refetches after it', async () => {
    const { registry, fetch, advance } = setup();
    await registry.ensureFresh();
    advance(SNAPSHOT_TTL_MS - 1);
    await registry.ensureFresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(2);
    await registry.ensureFresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('markStale forces a refetch', async () => {
    const { registry, fetch, respond } = setup();
    await registry.ensureFresh();
    respond([conn('oa', ['gpt-4o', 'gpt-4o-mini'])]);
    registry.markStale();
    await registry.ensureFresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(registry.publishedModels().map((p) => p.model.modelId)).toEqual(['gpt-4o--oa', 'gpt-4o-mini--oa']);
  });

  it('a change marked while a fetch is in flight is fetched again, and waited for', async () => {
    let release: (v: Connection[]) => void = () => {};
    const responses: Array<() => Promise<Connection[]>> = [
      () => new Promise<Connection[]>((r) => { release = r; }),
      async () => [conn('oa', ['gpt-4o', 'gpt-4o-mini'])],
    ];
    const fetch = jest.fn(() => responses.shift()!());
    const registry = new ConnectionRegistry({ fetch }, () => 1_000_000);
    const first = registry.ensureFresh();
    registry.markStale(); // the file or the admin changed after the in-flight fetch read it
    const second = registry.ensureFresh();
    release([conn('oa', ['gpt-4o'])]);
    await first;
    await second;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(registry.publishedModels().map((p) => p.model.modelId)).toEqual(['gpt-4o--oa', 'gpt-4o-mini--oa']);
  });

  it('a failed fetch keeps the last snapshot and retries only after 10 s', async () => {
    const { registry, fetch, advance, respond } = setup();
    await registry.ensureFresh();
    respond(new Error('admin down'));
    registry.markStale();
    await expect(registry.ensureFresh()).resolves.toBeUndefined();
    expect(registry.connections().map((c) => c.name)).toEqual(['oa']);
    advance(RETRY_AFTER_FAILURE_MS - 1);
    await registry.ensureFresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    respond([]);
    advance(2);
    await registry.ensureFresh();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(registry.connections()).toEqual([]);
  });

  it('a failed fetch logs no credential or error body', async () => {
    const { registry, respond } = setup();
    respond(Object.assign(new Error('request failed: {"secret":"sk-secret"}'), { response: { data: { secret: 'sk-secret' } } }));
    await registry.ensureFresh();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain('sk-secret');
  });

  it('a successful fetch logs no credential', async () => {
    const { registry } = setup();
    await registry.ensureFresh();
    expect(logged.join('\n')).not.toContain('sk-secret');
  });

  it('with no backend it stays empty and ensureFresh resolves', async () => {
    const registry = new ConnectionRegistry(null);
    await expect(registry.ensureFresh()).resolves.toBeUndefined();
    expect(registry.connections()).toEqual([]);
    expect(registry.isExternalModelId('gpt-4o--oa')).toBe(false);
  });

  it('knows published external ids, except shadowed ones', async () => {
    const { registry } = setup();
    await registry.ensureFresh();
    expect(registry.isExternalModelId('gpt-4o--oa')).toBe(true);
    expect(registry.isExternalModelId('gpt-4o')).toBe(false);
    registry.setShadowed(['gpt-4o--oa']);
    expect(registry.isExternalModelId('gpt-4o--oa')).toBe(false);
    registry.setShadowed([]);
    expect(registry.isExternalModelId('gpt-4o--oa')).toBe(true);
  });

  it('refreshInBackground waits for the first load only', async () => {
    const { registry, fetch, advance, respond } = setup();
    await registry.refreshInBackground();
    expect(registry.connections().map((c) => c.name)).toEqual(['oa']);
    let release!: () => void;
    fetch.mockImplementationOnce(() => new Promise<Connection[]>((resolve) => { release = () => resolve([]); }));
    respond([]);
    advance(SNAPSHOT_TTL_MS);
    await registry.refreshInBackground();          // resolves while the refetch is still pending
    expect(registry.connections().map((c) => c.name)).toEqual(['oa']);
    release();
    await registry.ensureFresh();
    expect(registry.connections()).toEqual([]);
  });

  it('setBackend attaches a backend later (index.ts does so at startup)', async () => {
    const registry = new ConnectionRegistry(null);
    registry.setBackend({ fetch: async () => [conn('late', ['gpt-4o'])] });
    await registry.ensureFresh();
    expect(registry.connections().map((c) => c.name)).toEqual(['late']);
  });

  // modelService and the entitlement rules import the registry; it must not drag the admin client
  // (constructed at load) into every module that does - suites mocking unifiedAuthConfig broke on it.
  it('importing the registry does not load the admin client', () => {
    jest.isolateModules(() => {
      jest.doMock('../src/clients/adminServiceClient', () => { throw new Error('adminServiceClient loaded'); });
      expect(() => require('../src/connections/connectionRegistry')).not.toThrow();
    });
  });

  it('an inactive connection is resolvable but not listed', async () => {
    const { registry } = setup([{ ...conn('off', ['gpt-4o']), isActive: false }]);
    await registry.ensureFresh();
    expect(registry.resolveExternal('gpt-4o--off')?.connection.isActive).toBe(false);
    expect(registry.resolveExternal('gpt-4o--off')?.model.upstreamModel).toBe('gpt-4o');
    expect(registry.isExternalModelId('gpt-4o--off')).toBe(true);
    expect(registry.publishedModels()).toEqual([]);
  });

  it('a connection without isActive (an admin older than B1 sends active ones only) is active', async () => {
    const { registry } = setup();
    await registry.ensureFresh();
    expect(registry.publishedModels().map((p) => p.model.modelId)).toEqual(['gpt-4o--oa']);
  });

  it('resolveExternal: a hit for a published id, nothing for an unknown or a shadowed one', async () => {
    const { registry } = setup();
    await registry.ensureFresh();
    expect(registry.resolveExternal('gpt-4o--oa')?.connection.name).toBe('oa');
    expect(registry.resolveExternal('gpt-4o')).toBeUndefined();
    registry.setShadowed(['gpt-4o--oa']);
    expect(registry.resolveExternal('gpt-4o--oa')).toBeUndefined();
  });

  it('refreshForRequest waits for a refetch the change marker asked for, not for one the TTL is due for', async () => {
    const { registry, fetch, advance, respond } = setup([]);
    await registry.ensureFresh();
    expect(registry.isExternalModelId('gpt-4o--oa')).toBe(false);
    // The admin published a model: the marker arrives, and the very next request must see it.
    respond([conn('oa', ['gpt-4o'])]);
    registry.markStale();
    await registry.refreshForRequest();
    expect(registry.isExternalModelId('gpt-4o--oa')).toBe(true);
    // Only the TTL expired: the request goes on with the current snapshot.
    const calls = fetch.mock.calls.length;
    let release!: (v: Connection[]) => void;
    fetch.mockImplementationOnce(() => new Promise<Connection[]>((r) => { release = r; }));
    advance(SNAPSHOT_TTL_MS + 1);
    await registry.refreshForRequest();   // returns while the refetch is still open
    expect(fetch.mock.calls.length).toBe(calls + 1);
    expect(registry.isExternalModelId('gpt-4o--oa')).toBe(true);
    release([]);
    await registry.ensureFresh();
    expect(registry.isExternalModelId('gpt-4o--oa')).toBe(false);
  });

  it('refreshForRequest does not wait on a failing admin: SAP traffic keeps its pace during an outage', async () => {
    const { registry, fetch, advance, respond } = setup();
    await registry.ensureFresh();
    respond(new Error('admin down'));
    registry.markStale();
    await registry.refreshForRequest();          // the marker's refetch fails ...
    advance(RETRY_AFTER_FAILURE_MS + 1);         // ... and once the retry window is over
    let release!: (v: Connection[]) => void;
    fetch.mockImplementationOnce(() => new Promise<Connection[]>((r) => { release = r; }));
    const started = Date.now();
    await registry.refreshForRequest();          // the next request does not wait for the retry
    expect(Date.now() - started).toBeLessThan(50);
    release([conn('oa', ['gpt-4o'])]);
  });

  it('refreshForRequest waits at most FRESH_WAIT_MS for a slow admin', async () => {
    const { registry, fetch } = setup();
    await registry.ensureFresh();
    fetch.mockImplementationOnce(() => new Promise<Connection[]>(() => { /* never answers */ }));
    registry.markStale();
    const started = Date.now();
    await registry.refreshForRequest();
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(FRESH_WAIT_MS - 20);
    expect(waited).toBeLessThan(FRESH_WAIT_MS + 500);
  });

  it('finds a connection by id', async () => {
    const { registry } = setup();
    await registry.ensureFresh();
    expect(registry.getConnection('id-oa')?.name).toBe('oa');
    expect(registry.getConnection('nope')).toBeUndefined();
  });
  it('onRefresh listeners get every successful snapshot, never a failed refresh; a throwing listener harms nothing', async () => {
    const { registry, respond, advance } = setup();
    const seen: string[][] = [];
    registry.onRefresh(() => { throw new Error('listener bug'); });
    registry.onRefresh((connections) => seen.push(connections.map((c) => c.name)));
    await registry.ensureFresh();
    respond(new Error('admin down'));
    registry.markStale();
    await registry.ensureFresh();
    respond([conn('az')]);
    advance(RETRY_AFTER_FAILURE_MS);
    registry.markStale();
    await registry.ensureFresh();
    expect(seen).toEqual([['oa'], ['az']]);
    expect(registry.getConnection('id-az')?.name).toBe('az');
  });
});
