import { join } from 'path';
import * as fs from 'fs';

const cds = require('@sap/cds');

import { setCredential, deleteCredential, listCredentialNames, getCredential } from '../src/siem/credentialStore';
import * as credentialStore from '../src/siem/credentialStore';
import { setSecretResolverHandle } from '../src/siem/secretResolverHandle';
import * as credentialSweep from '../src/siem/credentialSweep';

describe('siem credential actions', () => {
  let handlers: Record<string, (req: any) => any>;
  // Actions are scoped to a configuration, but this suite tests the action handlers'
  // own behaviour (validation, auditing, error shape) - a single fixed configuration id is
  // enough; scoping semantics themselves are covered by siem-credential-scoping.test.ts.
  const CONFIG_ID = 'cred-actions-test-config';

  beforeAll(async () => {
    process.env.SIEM_CREDENTIAL_KEY = 'test-encryption-key-for-siem-credentials';
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    const db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../src/db/schema')).to(db);

    // AdminService is not exported for direct instantiation - the module only exports the
    // `(srv) => { adminService.init(srv); ... }` factory CAP calls at service-mount time. A
    // minimal recording stub standing in for the CDS service object captures the *real*
    // bound handler functions as init() registers them via `service.on(name, handler)`, so
    // every assertion below runs the actual admin-service.ts code, not a copy of it.
    handlers = {};
    require('../src/srv/admin-service')({
      on: (...args: any[]) => { handlers[args[0]] = args[args.length - 1]; },
      before: () => {},
      after: () => {},
    });
  });

  beforeEach(async () => {
    await cds.ql.DELETE.from('sap.llm.gateway.admin.SiemCredentials');
    await cds.ql.DELETE.from('sap.llm.gateway.admin.AuditEvents');
    jest.restoreAllMocks();
  });

  it('declares all five actions as admin-only', () => {
    const src = fs.readFileSync(join(__dirname, '../src/srv/admin-service.cds'), 'utf8');
    for (const action of [
      'setSiemCredential', 'deleteSiemCredential', 'listSiemCredentials',
      'findOrphanedSiemCredentials', 'deleteOrphanedSiemCredentials',
    ]) {
      // The @(requires: 'admin') immediately preceding the action declaration.
      const re = new RegExp(`@\\(requires:\\s*'admin'\\)[\\s\\S]{0,120}?action\\s+${action}\\b`);
      expect(src).toMatch(re);
    }
  });

  describe('listSiemCredentials', () => {
    it('never exposes the value or the ciphertext', async () => {
      await setCredential(CONFIG_ID, 'SIEM_TEST', 'super-secret-value', 'admin@example.invalid');
      const listed = await handlers.listSiemCredentials({
        data: { configurationId: CONFIG_ID }, user: { id: 'admin@example.invalid' },
      });
      expect(JSON.stringify(listed)).not.toContain('super-secret-value');
      expect(JSON.stringify(listed)).not.toContain('ciphertext');
      expect(listed[0]).toEqual(expect.objectContaining({ name: 'SIEM_TEST' }));
      expect(Object.keys(listed[0])).toEqual(
        expect.arrayContaining(['name', 'updatedAt', 'updatedBy', 'maskedHint']),
      );
      expect(Object.keys(listed[0])).not.toContain('ciphertext');
    });

    it('the masked hint does not reveal the middle of the value', async () => {
      await setCredential(CONFIG_ID, 'SIEM_TEST', 'abcdefghijklmnop', 'admin@example.invalid');
      const [row] = await handlers.listSiemCredentials({
        data: { configurationId: CONFIG_ID }, user: { id: 'admin@example.invalid' },
      });
      expect(row.maskedHint).toBe('abcd…mnop');
      expect(row.maskedHint).not.toContain('efghijkl');
    });

    it('rejects rather than returning [] when the store errors, so an outage is not read as "no credentials"', async () => {
      jest.spyOn(credentialStore, 'listCredentialNames').mockRejectedValueOnce(new Error('DB down'));
      await expect(handlers.listSiemCredentials({
        data: { configurationId: CONFIG_ID }, user: { id: 'admin@example.invalid' },
      })).rejects.toThrow('Failed to list SIEM credentials');
    });

    it('rejects rather than throwing an unrelated error when configurationId is missing', async () => {
      await expect(handlers.listSiemCredentials({ data: {}, user: { id: 'admin@example.invalid' } }))
        .rejects.toThrow('configurationId is required');
    });
  });

  describe('setSiemCredential', () => {
    it('returns { success: false } rather than throwing on a blank name', async () => {
      await expect(
        handlers.setSiemCredential({
          data: { configurationId: CONFIG_ID, name: '  ', value: 'v' },
          user: { id: 'admin@example.invalid' },
        }),
      ).resolves.toEqual({ success: false, error: 'name is required' });
    });

    it('returns { success: false } rather than throwing when configurationId is missing', async () => {
      await expect(
        handlers.setSiemCredential({ data: { name: 'SIEM_TEST', value: 'v' }, user: { id: 'admin@example.invalid' } }),
      ).resolves.toEqual({ success: false, error: 'configurationId is required' });
    });

    it('names the missing SIEM_CREDENTIAL_KEY instead of failing generically, without echoing any value', async () => {
      // Every set fails this way on a stack where the variable was never wired in (the docker
      // stack, until setup-docker.js generated it) - the operator needs to be told which
      // setting is missing, not just that "it failed".
      const saved = process.env.SIEM_CREDENTIAL_KEY;
      delete process.env.SIEM_CREDENTIAL_KEY;
      try {
        const result = await handlers.setSiemCredential({
          data: { configurationId: CONFIG_ID, name: 'SIEM_NO_KEY', value: 'top-secret-value' },
          user: { id: 'admin@example.invalid' },
        });
        expect(result).toEqual({
          success: false,
          error: 'SIEM_CREDENTIAL_KEY is not configured on the admin service; the credential was not stored',
        });
        expect(JSON.stringify(result)).not.toContain('top-secret-value');
        expect(await listCredentialNames(CONFIG_ID)).toEqual([]);
      } finally {
        process.env.SIEM_CREDENTIAL_KEY = saved;
      }
    });

    it('keeps the generic message for a failure that is not the missing key', async () => {
      jest.spyOn(credentialStore, 'setCredential').mockRejectedValueOnce(new Error('DB down'));
      await expect(handlers.setSiemCredential({
        data: { configurationId: CONFIG_ID, name: 'SIEM_DB_DOWN', value: 'v' },
        user: { id: 'admin@example.invalid' },
      })).resolves.toEqual({ success: false, error: 'Failed to store the credential' });
    });

    it('records an audit event keyed by name, with the value nowhere in it, on success', async () => {
      const result = await handlers.setSiemCredential({
        data: { configurationId: CONFIG_ID, name: 'SIEM_AUDITED', value: 'top-secret-value' },
        user: { id: 'admin@example.invalid' },
      });
      expect(result).toEqual({ success: true });

      const rows = await cds.ql.SELECT.from('sap.llm.gateway.admin.AuditEvents')
        .where({ resourceId: 'SIEM_AUDITED' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: 'admin@example.invalid',
        action: 'siem_credential.set',
        resourceType: 'SiemCredential',
        resourceId: 'SIEM_AUDITED',
        outcome: 'success',
        severity: 'high',
      });
      expect(JSON.stringify(rows[0])).not.toContain('top-secret-value');
      expect(rows[0].details).toContain(CONFIG_ID);
    });

    it('normalises a whitespace-padded name so it round-trips under the trimmed name', async () => {
      const result = await handlers.setSiemCredential({
        data: { configurationId: CONFIG_ID, name: '  SPLUNK_TOKEN  ', value: 'v1' },
        user: { id: 'admin@example.invalid' },
      });
      expect(result).toEqual({ success: true });
      expect(await listCredentialNames(CONFIG_ID)).toEqual([expect.objectContaining({ name: 'SPLUNK_TOKEN' })]);
      // secretResolver looks up the exact env var name - this must find it.
      expect(await getCredential(CONFIG_ID, 'SPLUNK_TOKEN')).toBe('v1');
    });
  });

  describe('deleteSiemCredential', () => {
    it('returns { success: false } rather than throwing on a blank name', async () => {
      await expect(
        handlers.deleteSiemCredential({
          data: { configurationId: CONFIG_ID, name: '' }, user: { id: 'admin@example.invalid' },
        }),
      ).resolves.toEqual({ success: false, error: 'name is required' });
    });

    it('returns { success: false } rather than throwing when configurationId is missing', async () => {
      await expect(
        handlers.deleteSiemCredential({ data: { name: 'SIEM_TEST' }, user: { id: 'admin@example.invalid' } }),
      ).resolves.toEqual({ success: false, error: 'configurationId is required' });
    });

    it('deletes the stored credential and records a success audit event', async () => {
      await setCredential(CONFIG_ID, 'SIEM_TO_DELETE', 'v', 'admin@example.invalid');
      const result = await handlers.deleteSiemCredential({
        data: { configurationId: CONFIG_ID, name: 'SIEM_TO_DELETE' },
        user: { id: 'admin@example.invalid' },
      });
      expect(result).toEqual({ success: true });
      expect(await listCredentialNames(CONFIG_ID)).toEqual([]);

      const rows = await cds.ql.SELECT.from('sap.llm.gateway.admin.AuditEvents')
        .where({ resourceId: 'SIEM_TO_DELETE', outcome: 'success' });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('siem_credential.delete');
    });

    it('normalises a whitespace-padded name so it still matches the stored row', async () => {
      await setCredential(CONFIG_ID, 'SPLUNK_TOKEN', 'v1', 'admin@example.invalid');
      const result = await handlers.deleteSiemCredential({
        data: { configurationId: CONFIG_ID, name: '  SPLUNK_TOKEN  ' },
        user: { id: 'admin@example.invalid' },
      });
      expect(result).toEqual({ success: true });
      expect(await listCredentialNames(CONFIG_ID)).toEqual([]);
    });

    it('records a failure audit event when the store throws, same as a failed set', async () => {
      jest.spyOn(credentialStore, 'deleteCredential').mockRejectedValueOnce(new Error('DB down'));

      const result = await handlers.deleteSiemCredential({
        data: { configurationId: CONFIG_ID, name: 'SIEM_FAIL' },
        user: { id: 'admin@example.invalid' },
      });
      expect(result).toEqual({ success: false, error: 'Failed to delete the credential' });

      const rows = await cds.ql.SELECT.from('sap.llm.gateway.admin.AuditEvents')
        .where({ resourceId: 'SIEM_FAIL', outcome: 'failure' });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('siem_credential.delete');
    });
  });

  describe('findOrphanedSiemCredentials', () => {
    it('never exposes ciphertext, iv, salt or authTag - assert on the serialized result', async () => {
      const config = 'sap.llm.gateway.admin.ApiConfigurations';
      await cds.ql.INSERT.into(config).entries({
        name: 'orphan-report-config', version: '1.0.0',
        configData: JSON.stringify({ api_config: { observability: { siem: { enabled: true, sinks: [] } } } }),
      });
      const [{ ID: configId }] = await cds.ql.SELECT.from(config).columns('ID').where({ name: 'orphan-report-config' });
      await setCredential(configId, 'SIEM_ORPHAN_REPORT', 'super-secret-value', 'admin@example.invalid');

      const found = await handlers.findOrphanedSiemCredentials({ data: {}, user: { id: 'admin@example.invalid' } });

      expect(found.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(found);
      expect(serialized).not.toContain('super-secret-value');
      expect(serialized).not.toContain('ciphertext');
      expect(serialized).not.toContain('authTag');
    });

    it('rejects rather than returning [] when the sweep errors', async () => {
      jest.spyOn(credentialSweep, 'findOrphanedCredentials').mockRejectedValueOnce(new Error('DB down'));
      await expect(handlers.findOrphanedSiemCredentials({ data: {}, user: { id: 'admin@example.invalid' } }))
        .rejects.toThrow('Failed to find orphaned SIEM credentials');
    });
  });

  describe('deleteOrphanedSiemCredentials', () => {
    it('rejects mismatched or empty arrays without touching the store', async () => {
      await expect(handlers.deleteOrphanedSiemCredentials({
        data: { names: ['A'], configurationIds: [] }, user: { id: 'admin@example.invalid' },
      })).resolves.toEqual({
        success: false, deleted: 0,
        error: 'names and configurationIds must be non-empty, equal-length arrays',
      });
    });

    it('deletes only the requested pairs that are still actual orphans, one audit event each', async () => {
      await setCredential('missing-config-x', 'SIEM_ACTION_DELETE', 'v', 'admin@example.invalid');
      await setCredential('missing-config-y', 'SIEM_ACTION_KEEP', 'v', 'admin@example.invalid');

      const result = await handlers.deleteOrphanedSiemCredentials({
        data: { names: ['SIEM_ACTION_DELETE'], configurationIds: ['missing-config-x'] },
        user: { id: 'admin@example.invalid' },
      });

      expect(result).toEqual({ success: true, deleted: 1 });
      expect(await listCredentialNames('missing-config-x')).toEqual([]);
      expect(await listCredentialNames('missing-config-y')).toEqual([
        expect.objectContaining({ name: 'SIEM_ACTION_KEEP' }),
      ]);

      const rows = await cds.ql.SELECT.from('sap.llm.gateway.admin.AuditEvents')
        .where({ resourceId: 'SIEM_ACTION_DELETE' });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('siem_credential.delete');
    });

    it('does not delete a pair that is not actually an orphan', async () => {
      const config = 'sap.llm.gateway.admin.ApiConfigurations';
      await cds.ql.INSERT.into(config).entries({
        name: 'still-referenced-config', version: '1.0.0',
        configData: JSON.stringify({
          api_config: { observability: { siem: { enabled: true, sinks: [{ name: 'dd', type: 'datadog', enabled: true, api_key_env: 'SIEM_LIVE' }] } } },
        }),
      });
      const [{ ID: configId }] = await cds.ql.SELECT.from(config).columns('ID').where({ name: 'still-referenced-config' });
      await setCredential(configId, 'SIEM_LIVE', 'v', 'admin@example.invalid');

      const result = await handlers.deleteOrphanedSiemCredentials({
        data: { names: ['SIEM_LIVE'], configurationIds: [configId] },
        user: { id: 'admin@example.invalid' },
      });

      expect(result).toEqual({ success: true, deleted: 0 });
      expect(await getCredential(configId, 'SIEM_LIVE')).toBe('v');
    });
  });

  // Pins the "active configurations only" invariant at the handler level with real
  // ApiConfigurations rows and a spy on the resolver handle - CONFIG_ID above matches no row,
  // so the tests using it never exercise this branch either way, and the scoping test's own
  // resolver-refresh tests call refreshSecretResolver() directly, bypassing this guard
  // entirely. Non-inertness checked manually: inverting the `isActiveConfiguration` check in
  // setSiemCredential/deleteSiemCredential (admin-service.ts) turns every test in this
  // `describe` red.
  describe('immediate resolver refresh only fires for the ACTIVE configuration', () => {
    const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
    let activeId: string;
    let inactiveId: string;
    let fakeHandle: { resolve: jest.Mock; refresh: jest.Mock; stop: jest.Mock };

    beforeEach(async () => {
      const { DELETE, INSERT, SELECT } = cds.ql;
      await DELETE.from(CONFIGS);
      await INSERT.into(CONFIGS).entries(
        { name: 'active', version: '1.0.0', configData: '{}', isActive: true },
        { name: 'inactive', version: '1.0.1', configData: '{}', isActive: false },
      );
      const rows = await SELECT.from(CONFIGS).columns('ID', 'isActive');
      activeId = rows.find((r: any) => r.isActive).ID;
      inactiveId = rows.find((r: any) => !r.isActive).ID;

      fakeHandle = { resolve: jest.fn(), refresh: jest.fn().mockResolvedValue(undefined), stop: jest.fn() };
      setSecretResolverHandle(fakeHandle);
    });

    afterEach(async () => {
      setSecretResolverHandle(null);
      await cds.ql.DELETE.from(CONFIGS);
    });

    it('setSiemCredential refreshes the resolver when the target is the ACTIVE configuration', async () => {
      const result = await handlers.setSiemCredential({
        data: { configurationId: activeId, name: 'SIEM_GUARD', value: 'v' },
        user: { id: 'admin@example.invalid' },
      });
      expect(result).toEqual({ success: true });
      expect(fakeHandle.refresh).toHaveBeenCalledTimes(1);
    });

    it('setSiemCredential does NOT refresh the resolver when the target is an INACTIVE configuration', async () => {
      const result = await handlers.setSiemCredential({
        data: { configurationId: inactiveId, name: 'SIEM_GUARD', value: 'v' },
        user: { id: 'admin@example.invalid' },
      });
      expect(result).toEqual({ success: true });
      expect(fakeHandle.refresh).not.toHaveBeenCalled();
    });

    it('deleteSiemCredential refreshes the resolver when the target is the ACTIVE configuration', async () => {
      await setCredential(activeId, 'SIEM_GUARD', 'v', 'admin@example.invalid');
      fakeHandle.refresh.mockClear();

      const result = await handlers.deleteSiemCredential({
        data: { configurationId: activeId, name: 'SIEM_GUARD' },
        user: { id: 'admin@example.invalid' },
      });
      expect(result).toEqual({ success: true });
      expect(fakeHandle.refresh).toHaveBeenCalledTimes(1);
    });

    it('deleteSiemCredential does NOT refresh the resolver when the target is an INACTIVE configuration', async () => {
      await setCredential(inactiveId, 'SIEM_GUARD', 'v', 'admin@example.invalid');
      fakeHandle.refresh.mockClear();

      const result = await handlers.deleteSiemCredential({
        data: { configurationId: inactiveId, name: 'SIEM_GUARD' },
        user: { id: 'admin@example.invalid' },
      });
      expect(result).toEqual({ success: true });
      expect(fakeHandle.refresh).not.toHaveBeenCalled();
    });
  });
});
