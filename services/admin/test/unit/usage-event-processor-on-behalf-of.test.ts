/**
 * Grounding phase 4b: usage the gateway records for a cockpit action carries the platform service
 * key as its credential and the acting user in `onBehalfOf`. The processor books such a row to the
 * acting user (row e-mail, bucket, quota republish), but only when the key IS a service key; a
 * user's own key can never move its usage onto someone else. Rerank search units keep their
 * `units` unit, and unpriced file_search events cost zero while every other endpoint keeps the
 * fallback price. Real in-memory SQLite, like usage-event-processor-counters.test.ts.
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const cds = require('@sap/cds');

import UsageEventProcessor, { UsageEvent } from '../../src/services/usageEventProcessor';
import { BUCKETS, rebuild } from '../../src/services/usageCounters';
import * as quota from '../../src/services/userQuotaService';
import { modelCostService } from '../../src/services/modelCostService';
import { buildFileSearchUsageEvent } from '../../../gateway/src/fileSearch/usageEvent';

const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const SERVICE_KEY_EMAIL = 'admin2gateway.service.key';
const T = Math.floor(Date.now() / 1000);

describe('UsageEventProcessor: onBehalfOf, units and file_search pricing (real sqlite)', () => {
  let db: any;
  let publishSpy: jest.SpyInstance;
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);
    // No gateway here: an uncached model must not send the cost service to the network.
    jest.spyOn(modelCostService as any, 'refreshPricingData').mockRejectedValue(new Error('no gateway in tests'));
  });
  beforeEach(async () => {
    const { DELETE, INSERT } = cds.ql;
    for (const t of [BUCKETS, KEY_USAGE, KEYS, 'sap.llm.gateway.admin.Users']) await db.run(DELETE.from(t));
    await db.run(INSERT.into(KEYS).entries([
      { ID: 'svc', key: 'sk-svc', name: 'Admin Service to Gateway', email: SERVICE_KEY_EMAIL, isActive: true, usageCount: 0 },
      { ID: 'k-user', key: 'sk-user', name: 'own key', email: 'owner@test.com', isActive: true, usageCount: 0 }
    ]));
    publishSpy = jest.spyOn(quota, 'publishMany').mockResolvedValue(undefined as any);
  });
  afterEach(() => publishSpy.mockRestore());

  const persist = (events: UsageEvent[], enableCostCalculation = false) =>
    (new UsageEventProcessor({ enableCostCalculation }) as any).persistUsageEvents(events);
  const event = (o: Partial<UsageEvent>): UsageEvent => ({
    requestId: uuidv4(), timestamp: T, authType: 'api_key', credentialId: 'svc', provider: 'unknown', model: 'text-embedding-3-large',
    inputTokens: 100, outputTokens: 0, responseTime: 10, statusCode: 200, endpoint: 'file_search/ingest', unit: 'tokens', ...o
  });
  const rows = () => db.run(cds.ql.SELECT.from(KEY_USAGE).columns('requestId', 'email', 'keyName', 'unit', 'totalCost', 'sapCost', 'endpoint'));
  const buckets = async () => (await db.run(cds.ql.SELECT.from(BUCKETS).columns('email', 'requests', 'tokens').orderBy('email')))
    .map((r: any) => ({ email: r.email, requests: Number(r.requests), tokens: Number(r.tokens) }));
  const published = (): string[] => [...(publishSpy.mock.calls[0]?.[1] ?? [])].sort();

  it('books a service-key event to the acting user: row e-mail, bucket and quota republish', async () => {
    await persist([event({ onBehalfOf: 'actor@test.com' })]);
    const [row] = await rows();
    expect(row).toMatchObject({ email: 'actor@test.com', keyName: 'Admin Service to Gateway', unit: 'tokens' });
    expect(await buckets()).toEqual([{ email: 'actor@test.com', requests: 1, tokens: 100 }]);
    expect(published()).toEqual(['actor@test.com']);
    // the acting user's Users row is refreshed; the service key never gets one
    const users = await db.run(cds.ql.SELECT.from('sap.llm.gateway.admin.Users').columns('email'));
    expect(users.map((u: any) => u.email)).toEqual(['actor@test.com']);
  });

  it("ignores onBehalfOf on a user's own key: the usage stays with the key owner", async () => {
    await persist([event({ credentialId: 'k-user', onBehalfOf: 'victim@test.com' })]);
    expect((await rows())[0].email).toBe('owner@test.com');
    expect(await buckets()).toEqual([{ email: 'owner@test.com', requests: 1, tokens: 100 }]);
    expect(published()).toEqual(['owner@test.com']);
  });

  it.each([
    ['not an e-mail', 'not-an-email'],
    ['longer than 255 characters', `${'a'.repeat(250)}@test.com`],
    ['an empty string', ''],
    ['not a string', 42 as any]
  ])('ignores a malformed onBehalfOf (%s) on the service key', async (_name, onBehalfOf) => {
    await persist([event({ onBehalfOf })]);
    expect((await rows())[0].email).toBe(SERVICE_KEY_EMAIL);
    // the bucket folds by the row e-mail as before; the service key has no quota to republish
    expect(await buckets()).toEqual([{ email: SERVICE_KEY_EMAIL, requests: 1, tokens: 100 }]);
    expect(published()).toEqual([]);
  });

  it("keeps the 'units' unit for rerank and counts the units into the token bucket like cells", async () => {
    await persist([
      event({ endpoint: 'file_search/rerank', model: 'cohere-reranker', unit: 'units', inputTokens: 1, onBehalfOf: 'actor@test.com' }),
      event({ endpoint: '/x', unit: 'cells' as any, credentialId: 'k-user' }),
      event({ endpoint: '/y', unit: 'bogus' as any, credentialId: 'k-user' })
    ]);
    const units = (await rows()).map((r: any) => [r.endpoint, r.unit]).sort();
    expect(units).toEqual([['/x', 'cells'], ['/y', 'tokens'], ['file_search/rerank', 'units']]);
    expect(await buckets()).toEqual([
      { email: 'actor@test.com', requests: 1, tokens: 1 },
      { email: 'owner@test.com', requests: 2, tokens: 200 }
    ]);
  });

  it('prices an unpriced file_search event at zero and keeps the fallback for other endpoints', async () => {
    const model = 'unpriced-embedding-model';
    await persist([
      event({ requestId: 'fs', model, inputTokens: 1000, onBehalfOf: 'actor@test.com' }),
      event({ requestId: 'chat', model, endpoint: '/chat/completions', inputTokens: 1000, credentialId: 'k-user' })
    ], true);
    const byId = Object.fromEntries((await rows()).map((r: any) => [r.requestId, r]));
    expect(Number(byId.fs.totalCost)).toBe(0);
    expect(Number(byId.fs.sapCost)).toBe(0);
    expect(Number(byId.chat.totalCost)).toBeCloseTo(0.001, 6);   // $0.001 per 1k input tokens fallback
    expect(byId.chat.sapCost).toBeNull();
  });

  it('contract: the event the gateway builds for file_search lands today, in the row and the bucket', async () => {
    // "Today" is sampled before the event is built and again after the persist, so a run that
    // crosses 00:00 UTC accepts either day instead of flaking.
    const dayBefore = new Date().toISOString().slice(0, 10);
    const gatewayEvent = buildFileSearchUsageEvent(
      { credentialId: 'svc', authType: 'api_key', onBehalfOf: 'actor@test.com' },
      { endpoint: 'file_search/ingest', model: 'text-embedding-3-large', inputTokens: 42, unit: 'tokens', responseTime: 17, requestId: 'fs-ingest-contract' }
    );
    await persist([gatewayEvent as UsageEvent]);
    const dayAfter = new Date().toISOString().slice(0, 10);
    const [row] = await db.run(cds.ql.SELECT.from(KEY_USAGE).columns('validFrom', 'email'));
    const rowDay = new Date(row.validFrom).toISOString().slice(0, 10);
    expect([dayBefore, dayAfter]).toContain(rowDay);
    const [bucket] = await db.run(cds.ql.SELECT.from(BUCKETS).columns('email', 'day'));
    expect(bucket.email).toBe('actor@test.com');
    expect(String(bucket.day).slice(0, 10)).toBe(rowDay);
  });

  it('contract: a file_search context event lands with its cache split, nothing billed twice', async () => {
    // The gateway's split (orchestrationCompletion.ts CompletionUsage): input = uncached
    // INCLUDING cache writes, cacheWrite a subset of it, cachedRead disjoint. The event carries
    // four disjoint fields, so the row's total is the whole prompt plus the output.
    const gatewayEvent = buildFileSearchUsageEvent(
      { credentialId: 'svc', authType: 'api_key', onBehalfOf: 'actor@test.com' },
      {
        endpoint: 'file_search/context', model: 'anthropic--claude-4.5-haiku', unit: 'tokens', responseTime: 900,
        requestId: 'fs-context-contract', inputTokens: 11279, cacheWriteTokens: 11266, cacheReadTokens: 0, outputTokens: 40,
      }
    );
    const readEvent = buildFileSearchUsageEvent(
      { credentialId: 'svc', authType: 'api_key', onBehalfOf: 'actor@test.com' },
      {
        endpoint: 'file_search/context', model: 'anthropic--claude-4.5-haiku', unit: 'tokens', responseTime: 700,
        requestId: 'fs-context-contract-2', inputTokens: 13, cacheWriteTokens: 0, cacheReadTokens: 11266, outputTokens: 38,
      }
    );
    await persist([gatewayEvent as UsageEvent, readEvent as UsageEvent]);
    const got = await db.run(cds.ql.SELECT.from(KEY_USAGE)
      .columns('requestId', 'endpoint', 'unit', 'inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'totalTokens')
      .orderBy('requestId'));
    expect(got.map((r: any) => ({ ...r, totalTokens: Number(r.totalTokens) }))).toEqual([
      { requestId: 'fs-context-contract', endpoint: 'file_search/context', unit: 'tokens', inputTokens: 13, outputTokens: 40,
        cacheCreationInputTokens: 11266, cacheReadInputTokens: 0, totalTokens: 11279 + 40 },
      { requestId: 'fs-context-contract-2', endpoint: 'file_search/context', unit: 'tokens', inputTokens: 13, outputTokens: 38,
        cacheCreationInputTokens: 0, cacheReadInputTokens: 11266, totalTokens: 13 + 11266 + 38 },
    ]);
  });

  it('a rebuild of the buckets equals the incremental result', async () => {
    await persist([
      event({ onBehalfOf: 'actor@test.com' }),
      event({ endpoint: 'file_search/rerank', unit: 'units', inputTokens: 1, onBehalfOf: 'actor@test.com' }),
      event({ credentialId: 'k-user', onBehalfOf: 'victim@test.com', inputTokens: 7 }),
      event({ onBehalfOf: 'bad' })
    ]);
    const incremental = await buckets();
    await db.run(cds.ql.DELETE.from(BUCKETS));
    await rebuild(db);
    expect(await buckets()).toEqual(incremental);
    expect(incremental).toEqual([
      { email: 'actor@test.com', requests: 2, tokens: 101 },
      { email: SERVICE_KEY_EMAIL, requests: 1, tokens: 100 },
      { email: 'owner@test.com', requests: 1, tokens: 7 }
    ]);
  });
});
