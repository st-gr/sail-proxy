import { join } from 'path';

const cds = require('@sap/cds');

import { setCredential } from '../src/siem/credentialStore';
import { findOrphanedCredentials, deleteOrphanedCredentials } from '../src/siem/credentialSweep';

describe('siem credential sweep', () => {
  const CREDENTIALS = 'sap.llm.gateway.admin.SiemCredentials';
  const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
  const { DELETE, INSERT, SELECT } = cds.ql;

  beforeAll(async () => {
    process.env.SIEM_CREDENTIAL_KEY = 'test-encryption-key-for-siem-credentials';
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to('db');
  });

  beforeEach(async () => {
    await DELETE.from(CREDENTIALS);
    await DELETE.from(CONFIGS);
    await DELETE.from('sap.llm.gateway.admin.AuditEvents');
  });

  /** Inserts a configuration row and returns its generated ID. */
  async function createConfiguration(configData: string, name = 'cfg'): Promise<string> {
    await INSERT.into(CONFIGS).entries({ name, version: '1.0.0', configData });
    const [row] = await SELECT.from(CONFIGS).columns('ID').where({ name });
    return row.ID;
  }

  function siemConfig(sinks: Record<string, unknown>[]): string {
    return JSON.stringify({ api_config: { observability: { siem: { enabled: true, sinks } } } });
  }

  it('finds a row whose configuration was deleted as no-configuration', async () => {
    await setCredential('missing-config-id', 'SIEM_ORPHAN', 'v', 'admin@example.invalid');

    const orphans = await findOrphanedCredentials();

    expect(orphans).toEqual([
      expect.objectContaining({
        configurationId: 'missing-config-id',
        configurationName: null,
        name: 'SIEM_ORPHAN',
        reason: 'no-configuration',
      }),
    ]);
  });

  it('finds a slot no sink references as not-referenced', async () => {
    const configId = await createConfiguration(siemConfig([
      { name: 'datadog', type: 'datadog', enabled: true, api_key_env: 'SIEM_DD_KEY' },
    ]));
    await setCredential(configId, 'SIEM_STALE_SLOT', 'v', 'admin@example.invalid');

    const orphans = await findOrphanedCredentials();

    expect(orphans).toEqual([
      expect.objectContaining({
        configurationId: configId,
        configurationName: 'cfg',
        name: 'SIEM_STALE_SLOT',
        reason: 'not-referenced',
      }),
    ]);
  });

  // The single most important test in this suite: a slot a sink genuinely references must
  // never come back as an orphan, or the sweep would delete a live, irreplaceable credential.
  // Non-inertness checked manually: inverting the `referenced.has(row.name)` check in
  // credentialSweep.ts's findOrphanedCredentials turns this test red.
  it('never classifies a slot a sink actually references as orphaned', async () => {
    const configId = await createConfiguration(siemConfig([
      { name: 'datadog', type: 'datadog', enabled: true, api_key_env: 'SIEM_DD_KEY' },
    ]));
    await setCredential(configId, 'SIEM_DD_KEY', 'v', 'admin@example.invalid');

    const orphans = await findOrphanedCredentials();

    expect(orphans).toEqual([]);
  });

  it('treats credentials as referenced when configData does not parse', async () => {
    const configId = await createConfiguration('{ not valid json');
    await setCredential(configId, 'SIEM_ANY_SLOT', 'v', 'admin@example.invalid');

    const orphans = await findOrphanedCredentials();

    expect(orphans).toEqual([]);
  });

  it('treats credentials as referenced when the configuration has no siem block', async () => {
    const configId = await createConfiguration(JSON.stringify({ api_config: { providers: [] } }));
    await setCredential(configId, 'SIEM_ANY_SLOT', 'v', 'admin@example.invalid');

    const orphans = await findOrphanedCredentials();

    expect(orphans).toEqual([]);
  });

  it('judges the same slot name in two configurations independently', async () => {
    const referencedConfigId = await createConfiguration(siemConfig([
      { name: 'datadog', type: 'datadog', enabled: true, api_key_env: 'SIEM_SHARED_NAME' },
    ]), 'cfg-referenced');
    const orphanConfigId = await createConfiguration(siemConfig([
      { name: 'datadog', type: 'datadog', enabled: true, api_key_env: 'SIEM_OTHER' },
    ]), 'cfg-orphan');

    await setCredential(referencedConfigId, 'SIEM_SHARED_NAME', 'v1', 'admin@example.invalid');
    await setCredential(orphanConfigId, 'SIEM_SHARED_NAME', 'v2', 'admin@example.invalid');

    const orphans = await findOrphanedCredentials();

    expect(orphans).toEqual([
      expect.objectContaining({ configurationId: orphanConfigId, name: 'SIEM_SHARED_NAME', reason: 'not-referenced' }),
    ]);
  });

  it('the find result carries no ciphertext, iv, salt or authTag', async () => {
    const configId = await createConfiguration(siemConfig([]));
    await setCredential(configId, 'SIEM_ANY_SLOT', 'super-secret-value', 'admin@example.invalid');

    const orphans = await findOrphanedCredentials();
    const serialized = JSON.stringify(orphans);

    expect(orphans.length).toBeGreaterThan(0);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('iv');
    expect(serialized).not.toContain('salt');
    expect(serialized).not.toContain('authTag');
  });

  describe('deleteOrphanedCredentials', () => {
    it('removes exactly the rows given and no others, writing one audit event per deletion', async () => {
      await setCredential('missing-config-a', 'SIEM_DELETE_ME', 'v', 'admin@example.invalid');
      await setCredential('missing-config-b', 'SIEM_KEEP_ME', 'v', 'admin@example.invalid');

      const orphans = await findOrphanedCredentials();
      const toDelete = orphans.filter(o => o.name === 'SIEM_DELETE_ME');
      expect(toDelete).toHaveLength(1);

      const deleted = await deleteOrphanedCredentials(toDelete, 'sweeper@example.invalid');

      expect(deleted).toBe(1);
      const remaining = await SELECT.from(CREDENTIALS).columns('name');
      expect(remaining.map((r: any) => r.name)).toEqual(['SIEM_KEEP_ME']);

      const auditRows = await SELECT.from('sap.llm.gateway.admin.AuditEvents')
        .where({ resourceId: 'SIEM_DELETE_ME' });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        actorId: 'sweeper@example.invalid',
        action: 'siem_credential.delete',
        resourceType: 'SiemCredential',
        resourceId: 'SIEM_DELETE_ME',
        outcome: 'success',
      });
      expect(JSON.stringify(auditRows[0])).not.toContain('super-secret-value');

      const auditForKept = await SELECT.from('sap.llm.gateway.admin.AuditEvents')
        .where({ resourceId: 'SIEM_KEEP_ME' });
      expect(auditForKept).toHaveLength(0);
    });
  });
});
