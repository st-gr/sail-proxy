/**
 * Users is the one identity the quota and entitlement frameworks share (spec §7.2 item 1):
 * touch creates/refreshes without touching status or constraints, the backfill creates a row per
 * distinct credential/preferences e-mail (never a service key), and the one-shot migration drains
 * ModelCatalogAssignments into Users.entitlementCatalog.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import * as users from '../../../src/services/usersService';
import * as ent from '../../../src/services/modelEntitlementService';

const USERS = 'sap.llm.gateway.admin.Users';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const PREFS = 'sap.llm.gateway.admin.UserPreferences';
const ASG = 'sap.llm.gateway.admin.ModelCatalogAssignments';
const CAT = 'sap.llm.gateway.admin.ModelCatalogs';

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE } = cds.ql;
  for (const t of [USERS, ASG, KEYS, AWS, PREFS]) await db.run(DELETE.from(t));
  await db.run(DELETE.from(CAT).where({ isDefault: false }));
});

describe('touch', () => {
  it('creates a row with first/last seen and roles, then refreshes lastSeenAt only', async () => {
    const created = await users.touch(db, 'a@test.com', { roles: ['user'], displayName: 'A' });
    expect(created).toMatchObject({ email: 'a@test.com', status: 'active', displayName: 'A', rolesSnapshot: '["user"]' });
    expect(created!.firstSeenAt).toBeTruthy();
    const { UPDATE } = cds.ql;
    await db.run(UPDATE(USERS).set({ status: 'deactivated', tokensPerDay: 5 }).where({ email: 'a@test.com' }));
    const again = await users.touch(db, 'a@test.com', { roles: ['admin', 'user'] });
    expect(again).toMatchObject({ status: 'deactivated', tokensPerDay: 5, rolesSnapshot: '["admin","user"]', displayName: 'A' });
    expect(users.parseRoles(again!.rolesSnapshot)).toEqual(['admin', 'user']);
  });
  it('ignores service-key pseudo-users and empty e-mails', async () => {
    expect(await users.touch(db, 'admin2gateway.service.key')).toBeNull();
    expect(await users.touch(db, '')).toBeNull();
    expect(await db.run(cds.ql.SELECT.from(USERS))).toHaveLength(0);
  });

  const isUsersWrite = (q: any): boolean =>
    (q?.INSERT?.into?.ref?.[0] ?? q?.UPSERT?.into?.ref?.[0]) === USERS;

  /**
   * A DbLike that behaves like PostgreSQL inside one request transaction: once a statement has
   * failed, every later statement fails with "current transaction is aborted". SQLite has no such
   * rule, which is why the old recovery (catch the duplicate-key INSERT, re-read) passed every test
   * here and still failed in the Docker and Kyma deployments on a user's first login.
   */
  function postgresLikeDb(inner: any) {
    let aborted = false;
    return {
      run: async (q: any) => {
        if (aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
        try { return await inner.run(q); } catch (e) { aborted = true; throw e; }
      }
    };
  }

  it('a first contact that loses the race to a concurrent one succeeds, even where a failed statement aborts the transaction', async () => {
    // The winner created the row between our read and our write: our read still saw nothing.
    const { INSERT } = cds.ql;
    const winnerSeen = '2026-09-23T17:14:43.000Z';
    await db.run(INSERT.into(USERS).entries({ email: 'races@test.com', firstSeenAt: winnerSeen, lastSeenAt: winnerSeen, status: 'active' }));
    let firstRead = true;
    const staleRead = {
      run: async (q: any) => {
        const isUsersRead = q?.SELECT?.from?.ref?.[0] === USERS;
        if (isUsersRead && firstRead) { firstRead = false; return null; }
        return db.run(q);
      }
    };
    const result = await users.touch(postgresLikeDb(staleRead), 'races@test.com', { roles: ['admin'] });
    expect(result).toMatchObject({ email: 'races@test.com', status: 'active', rolesSnapshot: '["admin"]' });
    expect(new Date(result!.firstSeenAt!).toISOString()).toBe(winnerSeen);   // the winner's first contact stands
    expect(await db.run(cds.ql.SELECT.from(USERS).where({ email: 'races@test.com' }))).toHaveLength(1);
  });

  it('parallel first contacts of one user (a page load) all succeed and leave one active row', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => users.touch(db, 'page-load@test.com', { roles: ['user'] }))
    );
    for (const r of results) expect(r).toMatchObject({ email: 'page-load@test.com', status: 'active' });
    const rows = await db.run(cds.ql.SELECT.from(USERS).where({ email: 'page-load@test.com' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSeenAt).toBeTruthy();
  });

  it('rethrows a genuine write failure on first contact', async () => {
    let intercepted = false;
    const failingDb = {
      run: async (q: any) => {
        if (isUsersWrite(q) && !intercepted) { intercepted = true; throw new Error('synthetic write failure'); }
        return db.run(q);
      }
    };
    await expect(users.touch(failingDb, 'write-fails@test.com')).rejects.toThrow('synthetic write failure');
    expect(await db.run(cds.ql.SELECT.from(USERS).where({ email: 'write-fails@test.com' }))).toHaveLength(0);
  });
});

describe('backfillUsers', () => {
  it('creates one row per distinct e-mail of keys, credentials and preferences, idempotently', async () => {
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(KEYS).entries([
      { ID: 'k1', key: 'sk-1', name: 'k', email: 'a@test.com', isActive: true },
      { ID: 'k2', key: 'sk-2', name: 'k', email: 'admin2gateway.service.key', isActive: true }
    ]));
    await db.run(INSERT.into(AWS).entries({ ID: 'c1', accessKeyId: 'AKIA1', secretHash: 'h', salt: 's', name: 'c', email: 'b@test.com', userId: 'b@test.com', region: 'us-east-1', isActive: true }));
    await db.run(INSERT.into(PREFS).entries({ ID: 'p1', email: 'c@test.com' }));
    expect(await users.backfillUsers(db)).toBe(3);
    expect(await users.backfillUsers(db)).toBe(0);
    const emails = (await db.run(cds.ql.SELECT.from(USERS).columns('email').orderBy('email'))).map((u: any) => u.email);
    expect(emails).toEqual(['a@test.com', 'b@test.com', 'c@test.com']);
  });
});

describe('migrateCatalogAssignments', () => {
  it('copies each legacy row into Users.entitlementCatalog and drains the table', async () => {
    const { INSERT, SELECT } = cds.ql;
    const def = await ent.ensureDefaultCatalog(db);
    await db.run(INSERT.into(CAT).entries({ ID: 'cat-team', name: 'Team', isDefault: false }));
    await db.run(INSERT.into(ASG).entries([{ email: 'a@test.com', catalog_ID: 'cat-team' }, { email: 'b@test.com', catalog_ID: def.ID }]));
    expect(await users.migrateCatalogAssignments(db)).toBe(2);
    const rows = await db.run(SELECT.from(USERS).columns('email', 'entitlementCatalog_ID').orderBy('email'));
    expect(rows).toEqual([{ email: 'a@test.com', entitlementCatalog_ID: 'cat-team' }, { email: 'b@test.com', entitlementCatalog_ID: def.ID }]);
    expect(await db.run(SELECT.from(ASG))).toHaveLength(0);
    // a later unassignment must survive the next boot: nothing left to re-apply
    await ent.unassignCatalog(db, 'a@test.com');
    expect(await users.migrateCatalogAssignments(db)).toBe(0);
    expect((await users.getUser(db, 'a@test.com'))!.entitlementCatalog_ID).toBeNull();
  });
});

describe('entitlement reads and writes Users', () => {
  it('assign/unassign/affectedEmails/getAssignedCatalog go through Users.entitlementCatalog', async () => {
    const { INSERT } = cds.ql;
    await ent.ensureDefaultCatalog(db);
    await db.run(INSERT.into(CAT).entries({ ID: 'cat-a', name: 'A', isDefault: false }));
    await ent.assignCatalog(db, 'a@test.com', 'cat-a');
    expect((await users.getUser(db, 'a@test.com'))!.entitlementCatalog_ID).toBe('cat-a');
    expect((await ent.getAssignedCatalog(db, 'a@test.com'))!.ID).toBe('cat-a');
    expect(await ent.affectedEmails(db, 'cat-a')).toEqual(['a@test.com']);
    await expect(ent.assertDeletable(db, (await ent.getCatalog(db, 'cat-a'))!)).rejects.toMatchObject({ status: 409 });
    await ent.unassignCatalog(db, 'a@test.com');
    expect(await ent.getAssignedCatalog(db, 'a@test.com')).toBeNull();
    expect(await ent.affectedEmails(db, 'cat-a')).toEqual([]);
    await expect(ent.assignCatalog(db, 'x.service.key', 'cat-a')).rejects.toMatchObject({ status: 400, code: 'not_a_user' });
  });
});
