import { join } from 'path';
import axios from 'axios';

const cds = require('@sap/cds');

import {
  setCredential, getCredential, deleteCredential, listCredentialNames, copyCredentials,
} from '../src/siem/credentialStore';
import { createSecretResolver } from '../src/siem/secretResolver';
import {
  setSecretResolverHandle, refreshSecretResolver, startSecretResolver, stopSecretResolver,
} from '../src/siem/secretResolverHandle';
import { resolveSiemDispatch } from '../src/siem/siemConfigResolver';
import { toSiemEvent } from '../src/siem/siemEvent';

describe('siem credential scoping', () => {
  const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
  const CREDS = 'sap.llm.gateway.admin.SiemCredentials';
  let activeId: string;
  let draftId: string;

  beforeAll(async () => {
    process.env.SIEM_CREDENTIAL_KEY = 'test-encryption-key-for-siem-credentials';
    await cds.deploy(join(__dirname, '../src/db/schema')).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { DELETE, INSERT, SELECT } = cds.ql;
    await DELETE.from(CREDS);
    await DELETE.from(CONFIGS);
    await INSERT.into(CONFIGS).entries(
      { name: 'live', version: '1.0.0', configData: '{}', isActive: true },
      { name: 'draft', version: '1.0.1', configData: '{}', isActive: false },
    );
    const rows = await SELECT.from(CONFIGS).columns('ID', 'isActive');
    activeId = rows.find((r: any) => r.isActive).ID;
    draftId = rows.find((r: any) => !r.isActive).ID;
  });

  it('keeps the same slot name independent across configurations', async () => {
    await setCredential(activeId, 'SIEM_DD_KEY', 'live-value', 'admin@example.invalid');
    await setCredential(draftId, 'SIEM_DD_KEY', 'draft-value', 'admin@example.invalid');

    expect(await getCredential(activeId, 'SIEM_DD_KEY')).toBe('live-value');
    expect(await getCredential(draftId, 'SIEM_DD_KEY')).toBe('draft-value');
  });

  it('editing a draft configuration does not touch the active one', async () => {
    await setCredential(activeId, 'SIEM_DD_KEY', 'live-value', 'admin@example.invalid');
    await setCredential(draftId, 'SIEM_DD_KEY', 'draft-value', 'admin@example.invalid');
    await deleteCredential(draftId, 'SIEM_DD_KEY');

    expect(await getCredential(activeId, 'SIEM_DD_KEY')).toBe('live-value');
    expect(await getCredential(draftId, 'SIEM_DD_KEY')).toBeNull();
  });

  it('lists only the requested configuration credentials', async () => {
    await setCredential(activeId, 'SIEM_A', 'a', 'admin@example.invalid');
    await setCredential(draftId, 'SIEM_B', 'b', 'admin@example.invalid');

    expect((await listCredentialNames(activeId)).map(c => c.name)).toEqual(['SIEM_A']);
    expect((await listCredentialNames(draftId)).map(c => c.name)).toEqual(['SIEM_B']);
  });

  it('copies credentials to a duplicated configuration', async () => {
    await setCredential(activeId, 'SIEM_DD_KEY', 'live-value', 'admin@example.invalid');
    await copyCredentials(activeId, draftId, 'admin@example.invalid');

    expect(await getCredential(draftId, 'SIEM_DD_KEY')).toBe('live-value');
    // Re-encrypted for the target, not a shared row.
    const { SELECT } = cds.ql;
    const rows = await SELECT.from(CREDS).columns('salt', 'iv');
    expect(new Set(rows.map((r: any) => r.salt)).size).toBe(2);
  });

  it('deletes credentials when the owning configuration is deleted', async () => {
    const { DELETE, SELECT } = cds.ql;
    await setCredential(draftId, 'SIEM_DD_KEY', 'draft-value', 'admin@example.invalid');
    await DELETE.from(CONFIGS).where({ ID: draftId });

    expect(await SELECT.from(CREDS).where({ configuration_ID: draftId })).toHaveLength(0);
  });

  it('refreshes immediately when the ACTIVE configuration credential changes', async () => {
    await setCredential(activeId, 'SIEM_DD_KEY', 'v1', 'admin@example.invalid');
    const r = createSecretResolver({ configurationId: activeId, refreshIntervalMs: 0 });
    setSecretResolverHandle(r);
    await r.refresh();
    expect(r.resolve('SIEM_DD_KEY')).toBe('v1');

    await setCredential(activeId, 'SIEM_DD_KEY', 'v2', 'admin@example.invalid');
    await refreshSecretResolver();
    expect(r.resolve('SIEM_DD_KEY')).toBe('v2');
    setSecretResolverHandle(null);
  });

  it('a change to an INACTIVE configuration does not alter what is resolved', async () => {
    await setCredential(activeId, 'SIEM_DD_KEY', 'live', 'admin@example.invalid');
    const r = createSecretResolver({ configurationId: activeId, refreshIntervalMs: 0 });
    setSecretResolverHandle(r);
    await r.refresh();

    await setCredential(draftId, 'SIEM_DD_KEY', 'draft', 'admin@example.invalid');
    await refreshSecretResolver();
    expect(r.resolve('SIEM_DD_KEY')).toBe('live');
    setSecretResolverHandle(null);
  });

  // admin-service.ts's initializeSiemDispatcher cannot be exercised directly in a Jest test
  // (see siemConfigResolver.ts's doc comment - it opens a real Valkey connection and starts
  // uncancelled timers). This drives the exact two functions that method calls -
  // startSecretResolver (secretResolverHandle.ts) and resolveSiemDispatch, wired together the
  // same way - rather than a hand-built createSecretResolver(), so it proves the production
  // wiring itself resolves a stored credential, not just that the pieces can be made to work
  // when assembled a different way in a test.
  it('resolves a stored credential through the production start path', async () => {
    await setCredential(activeId, 'SIEM_DATADOG_TEST_KEY', 'stored-api-key', 'admin@example.invalid');

    const resolver = await startSecretResolver(activeId);
    try {
      const resolved = resolveSiemDispatch({
        enabled: true,
        sinks: [{
          name: 'datadog', type: 'datadog', enabled: true, api_key_env: 'SIEM_DATADOG_TEST_KEY',
        }],
      }, resolver.resolve);

      // validateConfig() (called inside resolveSiemDispatch) only lets a sink through when
      // resolveSecret actually returned a value - a missing credential drops the sink and
      // adds a "no credential stored" warning instead. Getting here at all is the assertion.
      expect(resolved).not.toBeNull();
      expect(resolved!.sinks.map(s => s.name)).toEqual(['datadog']);
      expect(resolved!.warnings).toEqual([]);
    } finally {
      stopSecretResolver();
    }
  });

  // The seam between "the dispatcher is built once at init()" and "the resolver reloads every
  // 60s". The resolver used to re-select the ACTIVE configuration on every refresh, so
  // activating a different configuration silently re-pointed the sinks that were already
  // running: one refresh after activating B, a sink built from A resolved B's key and shipped
  // A's events under B's org key - validateConfig() === [] and no warning anywhere. Activating
  // a duplicate configuration (no credentials of its own, since nothing calls copyCredentials)
  // resolved undefined instead, and datadogSink sends 'DD-API-KEY: ""' forever, because
  // validateConfig() is never re-consulted once a sink is built.
  it('a running sink keeps resolving the credential of the configuration it was built from when another is activated', async () => {
    const { UPDATE } = cds.ql;
    await setCredential(activeId, 'SIEM_DD_KEY', 'AAAA-key-for-org-A', 'admin@example.invalid');
    await setCredential(draftId, 'SIEM_DD_KEY', 'BBBB-key-for-org-B', 'admin@example.invalid');

    // Exactly initializeSiemDispatcher's order: pin the resolver to the configuration whose
    // configData builds the sinks, then build them from it.
    const resolver = await startSecretResolver(activeId);
    try {
      const resolved = resolveSiemDispatch({
        enabled: true,
        sinks: [{ name: 'datadog', type: 'datadog', enabled: true, api_key_env: 'SIEM_DD_KEY' }],
      }, resolver.resolve);
      expect(resolved).not.toBeNull();
      const sink = resolved!.sinks[0];

      // Activation, as config-service.ts performs it: two separate UPDATEs.
      await UPDATE(CONFIGS).set({ isActive: false }).where({ ID: activeId });
      await UPDATE(CONFIGS).set({ isActive: true }).where({ ID: draftId });
      // The 60s tick that used to swap the credential out from under the running sink.
      await resolver.refresh();

      expect(resolver.resolve('SIEM_DD_KEY')).toBe('AAAA-key-for-org-A');
      expect(sink.validateConfig()).toEqual([]);

      // Not just the resolver: the header the still-running sink actually sends.
      const post = jest.spyOn(axios, 'post').mockResolvedValue({ status: 202 } as never);
      try {
        await sink.send([toSiemEvent({
          eventId: 'evt-scoping-1', eventType: 'failed_auth', severity: 'high',
          timestamp: '2026-08-21T10:00:00.000Z', credentialId: 'missing',
          authType: 'api_key', clientIP: '203.0.113.9', endpoint: '/x',
        } as never)]);
        const sent = post.mock.calls[0][2] as { headers: Record<string, string> };
        expect(sent.headers['DD-API-KEY']).toBe('AAAA-key-for-org-A');
      } finally {
        post.mockRestore();
      }
    } finally {
      stopSecretResolver();
    }
  });
});
