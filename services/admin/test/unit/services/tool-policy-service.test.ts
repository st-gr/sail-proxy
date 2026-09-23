/** Tool policies: default seed, effective blocks, pattern validation. In-memory SQLite through cds.test(); no gateway, no Valkey. */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));
import * as svc from '../../../src/services/toolPolicyService';

const P = 'sap.llm.gateway.admin.ToolPolicies';
const A = 'sap.llm.gateway.admin.ToolPolicyAllows';
const D = 'sap.llm.gateway.admin.ToolPolicyDenies';
const U = 'sap.llm.gateway.admin.Users';
const K = 'sap.llm.gateway.admin.ApiKeys';

describe('toolPolicyService', () => {
  let db: any;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('seeds exactly one default policy in monitor mode, idempotently', async () => {
    const a = await svc.ensureDefaultPolicy(db);
    const b = await svc.ensureDefaultPolicy(db);
    expect(a.ID).toBe(b.ID);
    expect(a).toMatchObject({ name: 'Default', mode: 'monitor', isDefault: true });
    expect((await db.run(cds.ql.SELECT.from(P).where({ isDefault: true }))).length).toBe(1);
  });

  it('resolves the default block for an unassigned user and the assigned block otherwise', async () => {
    const def = await svc.ensureDefaultPolicy(db);
    await db.run(cds.ql.INSERT.into(U).entries([{ email: 'tp-user@test.com', status: 'active' }]));
    expect(await svc.policyBlockFor(db, 'tp-user@test.com')).toEqual({ policyId: def.ID, policyName: 'Default', mode: 'monitor', allow: [], deny: [], sensitive: [], untrusted: [] });
    const team = { ID: cds.utils.uuid(), name: 'Team', mode: 'strip', isDefault: false };
    await db.run(cds.ql.INSERT.into(P).entries([team]));
    await db.run(cds.ql.INSERT.into(A).entries([{ ID: cds.utils.uuid(), policy_ID: team.ID, pattern: 'function:*' }]));
    await db.run(cds.ql.INSERT.into(D).entries([{ ID: cds.utils.uuid(), policy_ID: team.ID, pattern: 'function:rm_*' }]));
    await svc.assignUser(db, 'tp-user@test.com', team.ID);
    expect(await svc.policyBlockFor(db, 'tp-user@test.com')).toEqual({ policyId: team.ID, policyName: 'Team', mode: 'strip', allow: ['function:*'], deny: ['function:rm_*'], sensitive: [], untrusted: [] });
    await svc.assignUser(db, 'tp-user@test.com', null);
    expect((await svc.policyBlockFor(db, 'tp-user@test.com')).policyId).toBe(def.ID);
  });

  it('resolves a key block only when the key names a policy', async () => {
    const team = (await db.run(cds.ql.SELECT.from(P).where({ name: 'Team' })))[0];
    const keyId = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(K).entries([{ ID: keyId, key: 'tp-key-fixture', maskedKey: 'tp-…', name: 'k', email: 'tp-user@test.com', isActive: true }]));
    expect(await svc.keyPolicyBlockFor(db, keyId)).toBeNull();
    await svc.assignApiKey(db, keyId, team.ID);
    expect((await svc.keyPolicyBlockFor(db, keyId))?.policyName).toBe('Team');
  });

  it('validates writes: pattern syntax, mode, single fixed default', () => {
    expect(svc.validatePolicyWrite({ name: 'x', mode: 'strip', allows: [{ pattern: 'function:a' }], denies: [{ pattern: 'mcp:g/*' }] }, null)).toEqual([]);
    expect(svc.validatePolicyWrite({ name: 'x', mode: 'block' }, null)).toEqual(['mode must be monitor, strip or reject']);
    expect(svc.validatePolicyWrite({ name: 'x', mode: 'monitor', allows: [{ pattern: 'oops' }] }, null)).toEqual(['allow pattern "oops" must look like function:name, hosted:type[/name] or mcp:server[/tool], optionally ending in *']);
    expect(svc.validatePolicyWrite({ isDefault: true }, { isDefault: false })).toEqual(['The default policy is fixed; assign users to another policy instead']);
    expect(svc.validatePolicyWrite({ isDefault: false }, { isDefault: true })).toEqual(['The default policy is fixed; assign users to another policy instead']);
    expect(svc.validatePolicyWrite({ name: '' }, null)).toEqual(['name is required']);
  });

  it('refuses to delete the default policy and lists affected emails', async () => {
    const def = await svc.ensureDefaultPolicy(db);
    expect(() => svc.assertDeletable(def)).toThrow(/default/);
    const team = (await db.run(cds.ql.SELECT.from(P).where({ name: 'Team' })))[0];
    await svc.assignUser(db, 'tp-user@test.com', team.ID);
    expect(await svc.affectedEmails(db, team.ID)).toEqual(['tp-user@test.com']);
  });
});
