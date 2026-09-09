/**
 * Deactivation locks every active credential of the user (flagging them), invalidates the
 * gateway's cached validations including the rows just flipped, rewrites the state document and
 * leaves an audit row plus a notification with the admin's client IP; reactivation restores
 * exactly the flagged rows. A deactivated user cannot get new credentials, not even from an admin.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'lc-admin@test.com': { id: 'lc-admin@test.com', roles: ['admin', 'user'] },
  'lc-user@test.com': { id: 'lc-user@test.com', roles: ['user'] } } };

const invalidations: any[] = [];
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: {
    bulkInvalidate: jest.fn(async (list: any[]) => { invalidations.push(...list); }),
    invalidatePattern: jest.fn(async () => 0), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn()
  },
  default: {}
}));
const published: string[] = [];
jest.mock('../../../src/services/userQuotaService', () => ({
  ...jest.requireActual('../../../src/services/userQuotaService'),
  publish: jest.fn(async (_db: any, email: string) => { published.push(email); return true; })
}));

const { POST } = cds.test(path.resolve(__dirname, '../../..'));
import * as lifecycle from '../../../src/services/userLifecycleService';
import * as users from '../../../src/services/usersService';
import { cacheInvalidationService } from '../../../src/services/cacheInvalidationService';

const ADMIN = { auth: { username: 'lc-admin@test.com', password: 'x' } };
const USERS = 'sap.llm.gateway.admin.Users';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const NOTES = 'sap.llm.gateway.admin.SecurityNotifications';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const CTX = { actor: 'lc-admin@test.com', reason: 'left the company', clientIP: '203.0.113.7', userAgent: 'jest' };

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  for (const t of [NOTES, AUDIT, USERS, KEYS, AWS]) await db.run(DELETE.from(t));
  invalidations.length = 0; published.length = 0;
  await db.run(INSERT.into(KEYS).entries([
    { ID: 'k-active', key: 'sk-active', name: 'a', email: 'lc-user@test.com', isActive: true },
    { ID: 'k-off', key: 'sk-off', name: 'b', email: 'lc-user@test.com', isActive: false },           // disabled by an admin earlier
    { ID: 'k-other', key: 'sk-other', name: 'c', email: 'other@test.com', isActive: true }
  ]));
  await db.run(INSERT.into(AWS).entries({ ID: 'c-active', accessKeyId: 'AKIALC1', secretHash: 'h', salt: 's', name: 'c', email: 'lc-user@test.com', userId: 'lc-user@test.com', region: 'us-east-1', isActive: true }));
});

describe('deactivate and reactivate', () => {
  it('locks active credentials, invalidates them, publishes, audits and notifies with the client IP', async () => {
    const { SELECT } = cds.ql;
    const r = await lifecycle.deactivate(db, 'lc-user@test.com', CTX);
    expect(r).toEqual({ email: 'lc-user@test.com', status: 'deactivated', lockedApiKeys: 1, lockedAwsCredentials: 1, cacheInvalidated: true });
    expect(await users.getUser(db, 'lc-user@test.com')).toMatchObject({ status: 'deactivated', statusChangedBy: 'lc-admin@test.com', statusReason: 'left the company' });
    const keys = await db.run(SELECT.from(KEYS).columns('ID', 'isActive', 'lockedByUserDeactivation').orderBy('ID'));
    expect(keys).toEqual([
      { ID: 'k-active', isActive: false, lockedByUserDeactivation: true },
      { ID: 'k-off', isActive: false, lockedByUserDeactivation: false },
      { ID: 'k-other', isActive: true, lockedByUserDeactivation: false }
    ]);
    expect(invalidations).toEqual(expect.arrayContaining([
      { credentialId: 'sk-active', authType: 'api_key', reason: 'user_deactivated' },
      { credentialId: 'AKIALC1', authType: 'aws_credential', reason: 'user_deactivated' }
    ]));
    expect(published).toEqual(['lc-user@test.com']);
    const [audit] = await db.run(SELECT.from(AUDIT).where({ action: 'user.deactivate' }));
    expect(audit).toMatchObject({ resourceType: 'User', resourceId: 'lc-user@test.com', severity: 'high', clientIP: '203.0.113.7', outcome: 'success' });
    const [note] = await db.run(SELECT.from(NOTES).where({ eventType: 'user_deactivated' }));
    expect(note).toMatchObject({ sourceEntity: 'AuditEvents', sourceID: audit.ID, ownerEmail: 'lc-user@test.com', severity: 'high', clientIP: '203.0.113.7', userAgent: 'jest' });
    expect(note.message).toContain('left the company');
  });

  it('is idempotent and reactivation restores only the flagged rows', async () => {
    const { SELECT } = cds.ql;
    await lifecycle.deactivate(db, 'lc-user@test.com', CTX);
    expect(await lifecycle.deactivate(db, 'lc-user@test.com', CTX)).toMatchObject({ lockedApiKeys: 0, lockedAwsCredentials: 0 });
    const r = await lifecycle.reactivate(db, 'lc-user@test.com', { actor: 'lc-admin@test.com', clientIP: '203.0.113.7' });
    expect(r).toEqual({ email: 'lc-user@test.com', status: 'active', restoredApiKeys: 1, restoredAwsCredentials: 1, cacheInvalidated: true });
    const keys = await db.run(SELECT.from(KEYS).columns('ID', 'isActive', 'lockedByUserDeactivation').orderBy('ID'));
    expect(keys).toEqual([
      { ID: 'k-active', isActive: true, lockedByUserDeactivation: false },
      { ID: 'k-off', isActive: false, lockedByUserDeactivation: false },
      { ID: 'k-other', isActive: true, lockedByUserDeactivation: false }
    ]);
    expect((await db.run(SELECT.from(NOTES).where({ eventType: 'user_reactivated' }))).length).toBe(1);
  });

  it('reports a failed cache invalidation without failing the deactivation itself', async () => {
    const { SELECT } = cds.ql;
    (cacheInvalidationService.bulkInvalidate as jest.Mock).mockRejectedValueOnce(new Error('valkey unreachable'));
    const r = await lifecycle.deactivate(db, 'lc-user@test.com', CTX);
    expect(r).toMatchObject({ status: 'deactivated', lockedApiKeys: 1, lockedAwsCredentials: 1, cacheInvalidated: false });
    const keys = await db.run(SELECT.from(KEYS).columns('ID', 'isActive').where({ ID: 'k-active' }));
    expect(keys[0].isActive).toBe(false);
    const [audit] = await db.run(SELECT.from(AUDIT).where({ action: 'user.deactivate' }));
    expect(audit.details).toContain('cache invalidation FAILED');
    const [note] = await db.run(SELECT.from(NOTES).where({ eventType: 'user_deactivated' }));
    expect(note.message).toContain('cache invalidation FAILED');
  });

  it('the normal case reports cacheInvalidated: true', async () => {
    const r = await lifecycle.deactivate(db, 'lc-user@test.com', CTX);
    expect(r.cacheInvalidated).toBe(true);
  });

  it('a deactivated user gets no new credentials, even from an administrator', async () => {
    await lifecycle.deactivate(db, 'lc-user@test.com', CTX);
    const key = await POST('/odata/v4/admin/createApiKey', { name: 'new', email: 'lc-user@test.com' }, ADMIN).catch((e: any) => e.response);
    expect(key.status).toBe(403);
    expect(JSON.stringify(key.data)).toContain('user_deactivated');
    const aws = await POST('/odata/v4/admin/createAwsCredentials', { userId: 'lc-user@test.com', email: 'lc-user@test.com', name: 'new', permissions: [] }, ADMIN).catch((e: any) => e.response);
    expect(aws.status).toBe(403);
    const enable = await POST('/odata/v4/admin/enableApiKey', { keyId: 'k-active' }, ADMIN).catch((e: any) => e.response);
    expect(enable.status === 403 || enable.data?.success === false).toBe(true);
    expect(await lifecycle.isDeactivated(db, 'nobody@test.com')).toBe(false);
  });
});
