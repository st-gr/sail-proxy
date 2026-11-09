import { join } from 'path';

const cds = require('@sap/cds');

import { setCredential, deleteCredential } from '../src/siem/credentialStore';
import { createSecretResolver } from '../src/siem/secretResolver';

describe('siem secret resolver', () => {
  const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
  let activeId: string;

  beforeAll(async () => {
    process.env.SIEM_CREDENTIAL_KEY = 'test-encryption-key-for-siem-credentials';
    await cds.deploy(join(__dirname, '../src/db/schema')).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { DELETE, INSERT, SELECT } = cds.ql;
    await DELETE.from('sap.llm.gateway.admin.SiemCredentials');
    await DELETE.from(CONFIGS);
    delete process.env.SIEM_RESOLVER_TEST;

    // refresh() only ever loads the credentials of the configuration the resolver is PINNED
    // to at construction - here the one below, which also happens to be the active one.
    await INSERT.into(CONFIGS).entries({
      name: 'live', version: '1.0.0', configData: '{}', isActive: true,
    });
    const [row] = await SELECT.from(CONFIGS).columns('ID');
    activeId = row.ID;
  });

  it('prefers the stored credential over the environment', async () => {
    process.env.SIEM_RESOLVER_TEST = 'from-env';
    await setCredential(activeId, 'SIEM_RESOLVER_TEST', 'from-db', 'admin@example.invalid');
    const r = createSecretResolver({ configurationId: activeId });
    await r.refresh();
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBe('from-db');
  });

  it('picks up a rotated value on refresh', async () => {
    await setCredential(activeId, 'SIEM_RESOLVER_TEST', 'v1', 'admin@example.invalid');
    const r = createSecretResolver({ configurationId: activeId });
    await r.refresh();
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBe('v1');

    await setCredential(activeId, 'SIEM_RESOLVER_TEST', 'v2', 'admin@example.invalid');
    await r.refresh();
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBe('v2');
  });

  it('returns undefined for a name that is set nowhere', async () => {
    const r = createSecretResolver({ configurationId: activeId });
    await r.refresh();
    expect(r.resolve('SIEM_NOWHERE')).toBeUndefined();
  });

  it('keeps serving the last good snapshot when a refresh fails', async () => {
    await setCredential(activeId, 'SIEM_RESOLVER_TEST', 'from-db', 'admin@example.invalid');
    const r = createSecretResolver({ configurationId: activeId });
    await r.refresh();

    const original = cds.db.run.bind(cds.db);
    (cds.db as { run: unknown }).run = () => Promise.reject(new Error('db down'));
    try {
      await expect(r.refresh()).resolves.toBeUndefined();
      expect(r.resolve('SIEM_RESOLVER_TEST')).toBe('from-db');
    } finally {
      (cds.db as { run: unknown }).run = original;
    }
  });

  it('keeps serving the last good snapshot when only a single credential read fails, not just when the whole list call fails', async () => {
    // Regression test: getCredential used to catch every error - DB failures included - and
    // return null, which refresh() cannot tell apart from "this credential was deleted". A
    // DB error landing between listCredentialNames succeeding and one row's read must not
    // silently drop that credential from the snapshot.
    process.env.SIEM_RESOLVER_TEST = 'from-env';
    await setCredential(activeId, 'SIEM_RESOLVER_TEST', 'from-db', 'admin@example.invalid');
    const r = createSecretResolver({ configurationId: activeId });
    await r.refresh();
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBe('from-db');

    const original = cds.db.run.bind(cds.db);
    (cds.db as { run: (query: unknown, ...args: unknown[]) => unknown }).run = (
      query: unknown,
      ...args: unknown[]
    ) => {
      // Only the single-row read (getCredential's SELECT.one) fails; the plain SELECT that
      // listCredentialNames issues (no `.one`) goes through untouched.
      const cqn = query as { SELECT?: { one?: boolean } };
      if (cqn?.SELECT?.one) return Promise.reject(new Error('row read down'));
      return original(query, ...args);
    };
    try {
      await expect(r.refresh()).resolves.toBeUndefined();
      // Must still be the stored value, not a silent fall-back to the env value or undefined.
      expect(r.resolve('SIEM_RESOLVER_TEST')).toBe('from-db');
    } finally {
      (cds.db as { run: unknown }).run = original;
    }
  });

  it('does not fall back to the environment when no credential is stored', async () => {
    process.env.SIEM_RESOLVER_TEST = 'from-env';
    const r = createSecretResolver({ configurationId: activeId });
    await r.refresh();
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBeUndefined();
  });

  it('returns the stored value and ignores a conflicting env var', async () => {
    process.env.SIEM_RESOLVER_TEST = 'from-env';
    await setCredential(activeId, 'SIEM_RESOLVER_TEST', 'from-db', 'admin@example.invalid');
    const r = createSecretResolver({ configurationId: activeId });
    await r.refresh();
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBe('from-db');
  });

  it('stops resolving once the stored credential is deleted, rather than reverting to env', async () => {
    process.env.SIEM_RESOLVER_TEST = 'from-env';
    await setCredential(activeId, 'SIEM_RESOLVER_TEST', 'from-db', 'admin@example.invalid');
    const r = createSecretResolver({ configurationId: activeId });
    await r.refresh();
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBe('from-db');

    await deleteCredential(activeId, 'SIEM_RESOLVER_TEST');
    await r.refresh();
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBeUndefined();
  });

  it('keeps serving the pinned configuration credentials after it stops being active', async () => {
    // The dispatcher builds its sinks once and never rebuilds them, so those sinks still
    // belong to this configuration after it is deactivated. Serving its credentials is what
    // keeps them consistent; the alternative - an empty snapshot - would not stop the sinks,
    // it would only make them send an empty API key indefinitely.
    await setCredential(activeId, 'SIEM_RESOLVER_TEST', 'from-db', 'admin@example.invalid');
    const { UPDATE } = cds.ql;
    await UPDATE(CONFIGS).set({ isActive: false }).where({ ID: activeId });

    const r = createSecretResolver({ configurationId: activeId });
    await r.refresh();
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBe('from-db');
  });

  it('serves an empty snapshot for a configuration that has no credentials of its own', async () => {
    const { INSERT, SELECT } = cds.ql;
    await setCredential(activeId, 'SIEM_RESOLVER_TEST', 'from-db', 'admin@example.invalid');
    await INSERT.into(CONFIGS).entries({
      name: 'other', version: '1.0.1', configData: '{}', isActive: false,
    });
    const otherId = (await SELECT.from(CONFIGS).columns('ID', 'name'))
      .find((row: { name: string }) => row.name === 'other').ID;

    const r = createSecretResolver({ configurationId: otherId });
    await r.refresh();
    // Never another configuration's value, not even the active one's.
    expect(r.resolve('SIEM_RESOLVER_TEST')).toBeUndefined();
  });
});
