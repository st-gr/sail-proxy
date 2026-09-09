/**
 * Regression test for a task-1 review finding: `lockedByUserDeactivation` is a lifecycle-owned
 * column (services/admin/src/services/userLifecycleService.ts is its only legitimate writer —
 * deactivate sets it true on the rows it locks, reactivate restores exactly those rows) exposed on
 * the draft-enabled AdminService.ApiKeys and AdminService.AwsCredentials projections. Neither
 * projection guarded it, so any caller with edit rights on a credential (owner or admin) could PATCH
 * it through the draft flow and have it persist, and a later reactivate would then restore a key the
 * lifecycle never locked. Fixed by annotating the element @readonly on both projections
 * (services/admin/src/srv/admin-service.cds) so CAP strips it from every write payload before
 * handlers run; the assertion here is on real behaviour — the flag stays unchanged (CAP silently
 * drops read-only input rather than rejecting the request with 400).
 *
 * Same scaffolding as users-odata.test.ts: cds.test() against an in-memory sqlite db, mocked auth,
 * drafts addressed with IsActiveEntity=false.
 */
import path from 'path';
import { randomUUID } from 'crypto';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'clf-admin@test.com': { id: 'clf-admin@test.com', roles: ['admin', 'user'] },
  'clf-user@test.com': { id: 'clf-user@test.com', roles: ['user'] } } };

const { GET, POST, PATCH } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'clf-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'clf-user@test.com', password: 'x' } };
const S = '/odata/v4/admin';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';

const keyPath = (id: string, active: boolean) => `${S}/ApiKeys(ID=${id},IsActiveEntity=${active})`;
const awsPath = (id: string, active: boolean) => `${S}/AwsCredentials(ID=${id},IsActiveEntity=${active})`;

// Reopen the active row for edit, PATCH the given fields onto its draft, and activate — same dance
// as sap-rates-crud.test.ts's patchActive helper.
async function patchActive(
  entityPath: (id: string, active: boolean) => string,
  id: string,
  patch: Record<string, unknown>,
  auth: any
): Promise<any> {
  await POST(`${entityPath(id, true)}/AdminService.draftEdit`, { PreserveChanges: true }, auth);
  await PATCH(entityPath(id, false), patch, auth);
  return POST(`${entityPath(id, false)}/AdminService.draftActivate`, {}, auth);
}

let keyId: string;
let credId: string;

beforeEach(async () => {
  const { DELETE: DEL, INSERT } = cds.ql;
  for (const t of [KEYS, AWS]) await cds.db.run(DEL.from(t));
  try { await cds.db.run(DEL.from('AdminService.ApiKeys.drafts')); } catch { /* no draft table */ }
  try { await cds.db.run(DEL.from('AdminService.AwsCredentials.drafts')); } catch { /* no draft table */ }

  keyId = randomUUID();
  credId = randomUUID();
  await cds.db.run(INSERT.into(KEYS).entries({
    ID: keyId, key: `sk-${keyId}`, name: 'clf-key', email: 'clf-user@test.com',
    isActive: true, lockedByUserDeactivation: false
  }));
  await cds.db.run(INSERT.into(AWS).entries({
    ID: credId, accessKeyId: 'AKIACLF00000000TEST', name: 'clf-cred',
    email: 'clf-user@test.com', userId: 'clf-user@test.com', region: 'us-east-1',
    isActive: true, lockedByUserDeactivation: false
  }));
});

describe('lockedByUserDeactivation is read-only on the credential projections', () => {
  it('ApiKeys: an admin PATCH through the draft flow cannot flip the flag', async () => {
    const activated = await patchActive(keyPath, keyId, { lockedByUserDeactivation: true }, ADMIN);
    expect(activated.status).toBe(200);
    const row = (await GET(keyPath(keyId, true), ADMIN)).data;
    expect(row.lockedByUserDeactivation).toBe(false);
  });

  it('ApiKeys: the owning non-admin user PATCH through the draft flow cannot flip the flag', async () => {
    const activated = await patchActive(keyPath, keyId, { lockedByUserDeactivation: true }, USER);
    expect(activated.status).toBe(200);
    const row = (await GET(keyPath(keyId, true), ADMIN)).data;
    expect(row.lockedByUserDeactivation).toBe(false);
  });

  it('AwsCredentials: an admin PATCH through the draft flow cannot flip the flag', async () => {
    const activated = await patchActive(awsPath, credId, { lockedByUserDeactivation: true }, ADMIN);
    expect(activated.status).toBe(200);
    const row = (await GET(awsPath(credId, true), ADMIN)).data;
    expect(row.lockedByUserDeactivation).toBe(false);
  });

  it('AwsCredentials: the owning non-admin user PATCH through the draft flow cannot flip the flag', async () => {
    const activated = await patchActive(awsPath, credId, { lockedByUserDeactivation: true }, USER);
    expect(activated.status).toBe(200);
    const row = (await GET(awsPath(credId, true), ADMIN)).data;
    expect(row.lockedByUserDeactivation).toBe(false);
  });
});
