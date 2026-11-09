/**
 * The boot-time neverExpires backfill flags every API key and AWS credential that has no expiration
 * date. Its UPDATE used to carry no bound parameter (the flag and IS NULL were inlined), which
 * @cap-js/postgres 1.14 rejects with "Query values must be an array" - in string and object form
 * alike - so it only ever worked on SQLite. It now updates the selected rows by ID.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import { backfillNeverExpires } from '../../../src/db/data/never-expires-backfill';

const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  await db.run(DELETE.from(KEYS));
  await db.run(DELETE.from(AWS));
  await db.run(INSERT.into(KEYS).entries([
    { ID: 'k-legacy', key: 'sk-1', name: 'k', email: 'a@test.com', isActive: true, expiresAt: null, neverExpires: null },
    { ID: 'k-false', key: 'sk-2', name: 'k', email: 'a@test.com', isActive: true, expiresAt: null, neverExpires: false },
    { ID: 'k-dated', key: 'sk-3', name: 'k', email: 'a@test.com', isActive: true, expiresAt: '2030-01-01T00:00:00Z', neverExpires: false },
    { ID: 'k-flagged', key: 'sk-4', name: 'k', email: 'a@test.com', isActive: true, expiresAt: null, neverExpires: true },
  ]));
  await db.run(INSERT.into(AWS).entries({ ID: 'c-legacy', accessKeyId: 'AKIA1', secretHash: 'h', salt: 's', name: 'c', email: 'b@test.com', userId: 'b@test.com', region: 'us-east-1', isActive: true, expiresAt: null, neverExpires: null }));
});

const flags = async (entity: string) =>
  Object.fromEntries((await db.run(cds.ql.SELECT.from(entity).columns('ID', 'neverExpires'))).map((r: any) => [r.ID, !!r.neverExpires]));

it('flags rows without an expiration date, leaves dated and already-flagged rows, and is idempotent', async () => {
  expect(await backfillNeverExpires(db)).toBe(3);
  expect(await flags(KEYS)).toEqual({ 'k-legacy': true, 'k-false': true, 'k-dated': false, 'k-flagged': true });
  expect(await flags(AWS)).toEqual({ 'c-legacy': true });
  expect(await backfillNeverExpires(db)).toBe(0);
});

it('never sends an UPDATE without bound values (what PostgreSQL rejects)', async () => {
  // Every UPDATE must select its rows by ID: the shape that binds parameters on every database.
  const updates: any[] = [];
  const recording = { run: (q: any) => { if (q?.UPDATE) updates.push(q.UPDATE); return db.run(q); } };
  await backfillNeverExpires(recording);
  expect(updates.length).toBeGreaterThan(0);
  for (const u of updates) {
    expect(typeof u.where).not.toBe('string');
    expect(JSON.stringify(u.where)).toContain('"ref":["ID"]');
  }
});
