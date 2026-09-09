/**
 * Per-credential rate limits (spec §2, §4). `credentialRateLimitsFor` is the batch counterpart of
 * `credentialRateLimits` used by the OData ApiKeys/AwsCredentials `after READ` handler - one
 * SELECT for a whole page of rows instead of one per row (the admin's single SQLite connection).
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import { credentialRateLimits, credentialRateLimitsFor, setCredentialRateLimits } from '../../../src/services/rateLimitsService';

const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  for (const t of [KEYS, AWS, 'sap.llm.gateway.admin.RateLimits']) await db.run(DELETE.from(t));
  await db.run(INSERT.into(KEYS).entries([
    { ID: 'k1', key: 'sk-1', name: 'k1', email: 'a@test.com', isActive: true },
    { ID: 'k2', key: 'sk-2', name: 'k2', email: 'a@test.com', isActive: true },
    { ID: 'k3', key: 'sk-3', name: 'k3', email: 'b@test.com', isActive: true }
  ]));
});

describe('credentialRateLimitsFor', () => {
  it('one SELECT returns a map for many ids, defaulting an id with no row to the three nulls', async () => {
    await setCredentialRateLimits(db, { apiKeyId: 'k1' }, { requestsPerMinute: 5, requestsPerHour: 50, requestsPerDay: 500 });
    await setCredentialRateLimits(db, { apiKeyId: 'k2' }, { requestsPerMinute: 9, requestsPerHour: 90, requestsPerDay: 900 });
    // k3 never gets a RateLimits row at all.
    const map = await credentialRateLimitsFor(db, 'apiKey', ['k1', 'k2', 'k3']);
    expect(map.size).toBe(3);
    expect(map.get('k1')).toEqual({ requestsPerMinute: 5, requestsPerHour: 50, requestsPerDay: 500 });
    expect(map.get('k2')).toEqual({ requestsPerMinute: 9, requestsPerHour: 90, requestsPerDay: 900 });
    expect(map.get('k3')).toEqual({ requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null });
    // Matches the single-id lookup exactly, for every id.
    for (const id of ['k1', 'k2', 'k3']) {
      expect(map.get(id)).toEqual(await credentialRateLimits(db, { apiKeyId: id }));
    }
  });

  it('chunks past 200 ids into multiple SELECTs and still returns every id', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `bulk-${i}`);
    await db.run(cds.ql.INSERT.into(KEYS).entries(ids.map((id) => ({ ID: id, key: `sk-${id}`, name: id, email: 'bulk@test.com', isActive: true }))));
    await setCredentialRateLimits(db, { apiKeyId: ids[0] }, { requestsPerMinute: 1 });
    await setCredentialRateLimits(db, { apiKeyId: ids[204] }, { requestsPerMinute: 2 });
    const map = await credentialRateLimitsFor(db, 'apiKey', ids);
    expect(map.size).toBe(205);
    expect(map.get(ids[0])?.requestsPerMinute).toBe(1);
    expect(map.get(ids[204])?.requestsPerMinute).toBe(2);
    expect(map.get(ids[100])).toEqual({ requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null });
  });

  it('empty id list returns an empty map without querying', async () => {
    expect((await credentialRateLimitsFor(db, 'apiKey', [])).size).toBe(0);
  });

  it('awsCredential kind keys on awsCredential_ID, independent of the apiKey rows', async () => {
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(AWS).entries({ ID: 'c1', accessKeyId: 'AKIA1', secretHash: 'h', salt: 's', name: 'c', email: 'a@test.com', userId: 'a@test.com', region: 'us-east-1', isActive: true }));
    await setCredentialRateLimits(db, { awsCredentialId: 'c1' }, { requestsPerMinute: 7, requestsPerHour: 70, requestsPerDay: 100 });
    const apiKeyMap = await credentialRateLimitsFor(db, 'apiKey', ['k1']);
    const awsMap = await credentialRateLimitsFor(db, 'awsCredential', ['c1']);
    // k1 has no RateLimits row under apiKey_ID even though c1's row exists under awsCredential_ID.
    expect(apiKeyMap.get('k1')).toEqual({ requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null });
    expect(awsMap.get('c1')).toEqual({ requestsPerMinute: 7, requestsPerHour: 70, requestsPerDay: 100 });
  });
});
