/**
 * UsageEventProcessor keeps UserUsageDaily in step with the rows it persists (spec §3.2): landed
 * rows increment the owner's bucket, dropped duplicates do not, unresolvable owners fold into
 * nothing, and rows + buckets are one transaction. Real in-memory SQLite, un-mocked, like
 * usage-event-processor-idempotency.test.ts.
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const cds = require('@sap/cds');

import UsageEventProcessor, { UsageEvent } from '../../src/services/usageEventProcessor';
import { BUCKETS } from '../../src/services/usageCounters';

const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const T0 = Math.floor(new Date('2026-09-07T10:00:00Z').getTime() / 1000);

describe('UsageEventProcessor: usage buckets (real sqlite, un-mocked)', () => {
  let db: any;
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);
  });
  beforeEach(async () => {
    const { DELETE, INSERT } = cds.ql;
    for (const t of [BUCKETS, KEY_USAGE, AWS_USAGE, KEYS, AWS]) await db.run(DELETE.from(t));
    await db.run(INSERT.into(KEYS).entries({ ID: 'k-1', key: 'sk-1', name: 'k', email: 'a@test.com', isActive: true, usageCount: 0 }));
    await db.run(INSERT.into(AWS).entries({ ID: 'c-1', accessKeyId: 'AKIAC1', secretHash: 'h', salt: 's', name: 'c', email: 'b@test.com', userId: 'legacy-user-id', isActive: true, usageCount: 0 }));
  });

  const processor = () => new UsageEventProcessor({ enableCostCalculation: false });
  const persist = (p: UsageEventProcessor, events: UsageEvent[]) => (p as any).persistUsageEvents(events);
  const event = (o: Partial<UsageEvent>): UsageEvent => ({
    requestId: uuidv4(), timestamp: T0, authType: 'api_key', credentialId: 'k-1', provider: 'anthropic', model: 'm',
    inputTokens: 100, outputTokens: 50, responseTime: 10, statusCode: 200, ...o
  });
  const buckets = async () => (await db.run(cds.ql.SELECT.from(BUCKETS).columns('email', 'day', 'currency', 'requests', 'tokens', 'sapCost')))
    .map((r: any) => ({ ...r, requests: Number(r.requests), tokens: Number(r.tokens), sapCost: Number(r.sapCost) }));

  it('lands one bucket per owner and day; a duplicate persisted again does not count twice', async () => {
    const e1 = event({ inputTokens: 100, outputTokens: 50 });
    const e2 = event({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, timestamp: T0 + 60 });
    const p = processor();
    await persist(p, [e1, e2]);
    await persist(processor(), [e1]);                               // a second subscriber replays e1
    expect(await db.run(cds.ql.SELECT.from(KEY_USAGE).columns('count(*) as n'))).toEqual([{ n: 2 }]);
    // 150 + 15 fresh tokens: e2's three cache-read tokens are priced, not counted
    expect(await buckets()).toEqual([{ email: 'a@test.com', day: '2026-09-07', currency: '', requests: 2, tokens: 165, sapCost: 0 }]);
    await p.shutdown();
  });

  it('AWS rows increment the credential owner (its email, not the legacy userId); unknown credentials fold into nothing', async () => {
    await persist(processor(), [
      event({ authType: 'aws_credential', credentialId: 'c-1', inputTokens: 7, outputTokens: 0 }),
      event({ credentialId: uuidv4(), inputTokens: 999, outputTokens: 0 })                  // no ApiKeys row: owner unknown@example.com
    ]);
    expect((await db.run(cds.ql.SELECT.from(AWS_USAGE).columns('userId')))[0].userId).toBe('legacy-user-id');
    expect(await buckets()).toEqual([{ email: 'b@test.com', day: '2026-09-07', currency: '', requests: 1, tokens: 7, sapCost: 0 }]);
  });

  it('rows and buckets are one transaction: when the bucket write fails, the rows of that batch are not persisted', async () => {
    await db.run('DROP TABLE sap_llm_gateway_admin_UserUsageDaily');
    // persistUsageEvents logs the failure and rethrows (pre-existing behavior, unrelated to this
    // task); the DB-level rollback is what this test is proving, so the rejection is expected.
    await persist(processor(), [event({})]).catch(() => {});
    expect(await db.run(cds.ql.SELECT.from(KEY_USAGE).columns('count(*) as n'))).toEqual([{ n: 0 }]);
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);   // restore for the other tests
  });
});
