/**
 * Saving a configuration through OData (the config app's Save: PATCH ApiConfigurations) stores the
 * checksum and validation result of the document saved, refuses an invalid document and any change
 * to the active configuration's document with a translated 400, and publishes the change event for
 * an update of the active configuration. The REST PUT (create + activate) stays consistent too.
 *
 * In-memory SQLite, mocked auth. The quota/cache hooks of activation are mocked as in
 * test/unit/services/config-activation-quota-hooks.test.ts: they would call out to the gateway.
 */
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'csr-admin@test.com': { id: 'csr-admin@test.com', roles: ['admin', 'user'] } } };

jest.mock('../../../src/services/quotaLimits', () => ({
  ...jest.requireActual('../../../src/services/quotaLimits'),
  invalidateQuotaDefaults: jest.fn()
}));
jest.mock('../../../src/services/userQuotaService', () => ({
  ...jest.requireActual('../../../src/services/userQuotaService'),
  republishAll: jest.fn(async () => 0)
}));
jest.mock('../../../src/services/credentialInvalidation', () => ({
  ...jest.requireActual('../../../src/services/credentialInvalidation'),
  invalidateForEmails: jest.fn(async () => true)
}));

const { GET, POST, PATCH, axios } = cds.test(path.resolve(__dirname, '../../..'));
import { MINIMAL_DEFAULT_CONFIG } from '../../../src/srv/minimal-default-config';
const router = require('../../../src/srv/config-rest-api');

const ADMIN = { auth: { username: 'csr-admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';
axios.defaults.validateStatus = () => true;

// config-service.ts's module.exports is a factory that wires the singleton into a service and
// returns it; handed a stub, it only returns the singleton the served AdminService runs on.
const configurationService = require('../../../src/srv/config-service')({ on: jest.fn(), before: jest.fn(), after: jest.fn() });

// Every event this suite causes (each activation publishes config-activated) must stay in the test:
// unstubbed, it reaches the real Valkey of the CI run, the Phase 5 gateway switches to each throwaway
// configuration and refetches SAP's model list per event, and concurrent live suites fail (private CI,
// 2026-10-07). Installed per test so it survives a restoreMocks setting; tests that assert on
// publishing clear this stub after their own activations.
let publishStub: jest.SpyInstance;
beforeEach(() => {
  publishStub = jest.spyOn(configurationService, 'publishConfigurationEvent').mockResolvedValue(undefined);
});

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const STREAMING_WARNING = 'Streaming timeout is very low (< 30 seconds)';

function withStreamingTimeout(streaming: number) {
  const config = JSON.parse(JSON.stringify(MINIMAL_DEFAULT_CONFIG));
  config.api_config.platform.timeouts.streaming = streaming;
  return config;
}

async function create(name: string, config: unknown): Promise<string> {
  const created = await POST(`${S}/createConfiguration`, { name, configData: JSON.stringify(config), description: 'test' }, ADMIN);
  expect(created.data.success).toBe(true);
  return created.data.configId;
}

async function read(id: string) {
  const row = await GET(`${S}/ApiConfigurations(ID=${id})`, ADMIN);
  expect(row.status).toBe(200);
  return row.data;
}

async function patch(id: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const row = await read(id);
  return PATCH(`${S}/ApiConfigurations(ID=${id})`, body, { ...ADMIN, headers: { 'If-Match': row['@odata.etag'], ...headers } });
}

describe('saving a configuration over OData', () => {
  it('recomputes the checksum and the validation result from the saved document', async () => {
    const id = await create('csr-valid', withStreamingTimeout(10000));
    const before = await read(id);
    expect(JSON.parse(before.validationWarnings)).toEqual([STREAMING_WARNING]);

    const raised = withStreamingTimeout(45000);
    const res = await patch(id, { configData: JSON.stringify(raised, null, 2) });
    expect(res.status).toBe(200);

    const after = await read(id);
    expect(after.checksum).toBe(sha256(JSON.stringify(raised)));
    expect(after.checksum).not.toBe(before.checksum);
    expect(after.isValid).toBe(true);
    expect(after.validationErrors).toBeNull();
    expect(after.validationWarnings).toBeNull();
    expect(after.lastValidated).toBeTruthy();
  });

  it('refuses an invalid document with a 400 naming its errors, and leaves the row unchanged', async () => {
    const id = await create('csr-invalid', withStreamingTimeout(10000));
    const before = await read(id);

    const res = await patch(id, { configData: JSON.stringify({ wrong_property: {} }) });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toMatch(/^The configuration was not saved because it is not valid: .*api_config/);

    const after = await read(id);
    expect(after).toMatchObject({ configData: before.configData, checksum: before.checksum, isValid: true, validationWarnings: before.validationWarnings });
  });

  it('refuses a document that is not JSON with a 400', async () => {
    const id = await create('csr-not-json', withStreamingTimeout(45000));
    const res = await patch(id, { configData: '{ not json' });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toBe('The configuration was not saved: its document is not valid JSON.');
  });

  it('refuses a change to the active configuration\'s document with a 400, translated for the request\'s language', async () => {
    const id = await create('csr-active', withStreamingTimeout(45000));
    const activated = await POST(`${S}/activateConfiguration`, { configId: id }, ADMIN);
    expect(activated.data.success).toBe(true);
    const before = await read(id);

    const res = await patch(id, { configData: JSON.stringify(withStreamingTimeout(60000)) });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toBe('An active configuration cannot be saved. Activate another configuration first, or duplicate this one and edit the copy.');

    const german = await patch(id, { configData: JSON.stringify(withStreamingTimeout(60000)) }, { 'Accept-Language': 'de' });
    expect(german.status).toBe(400);
    expect(german.data.error.message).toBe('Eine aktive Konfiguration kann nicht gespeichert werden. Aktivieren Sie zuerst eine andere Konfiguration, oder duplizieren Sie diese und bearbeiten Sie die Kopie.');

    expect((await read(id)).configData).toBe(before.configData);
  });

  it('drops a client\'s checksum or validity sent without a document', async () => {
    const id = await create('csr-forged', withStreamingTimeout(10000));
    const before = await read(id);
    const res = await patch(id, { description: 'renamed', checksum: 'forged', validationWarnings: null });
    expect(res.status).toBe(200);
    const after = await read(id);
    expect(after).toMatchObject({ description: 'renamed', checksum: before.checksum, validationWarnings: before.validationWarnings });
  });

  it('activation stores its validation result on the activated row', async () => {
    const id = await create('csr-activation', withStreamingTimeout(10000));
    // A row whose stored result went stale (saved before saves recomputed it).
    await cds.run(cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations').set({ validationWarnings: null, lastValidated: null }).where({ ID: id }));
    const activated = await POST(`${S}/activateConfiguration`, { configId: id }, ADMIN);
    expect(activated.data.success).toBe(true);
    const after = await read(id);
    expect(after.isActive).toBe(true);
    expect(after.isValid).toBe(true);
    expect(after.validationErrors).toBeNull();
    expect(JSON.parse(after.validationWarnings)).toEqual([STREAMING_WARNING]);
    expect(after.lastValidated).toBeTruthy();
  });

  it('renaming the active configuration is stored and publishes nothing (its document did not change)', async () => {
    const id = await create('csr-publish', withStreamingTimeout(45000));
    expect((await POST(`${S}/activateConfiguration`, { configId: id }, ADMIN)).data.success).toBe(true);
    const publish = publishStub;
    publish.mockClear();
    const res = await patch(id, { name: 'csr-publish-renamed', description: 'active, renamed' });
    expect(res.status).toBe(200);
    expect(await read(id)).toMatchObject({ name: 'csr-publish-renamed', description: 'active, renamed', isActive: true });
    expect(publish).not.toHaveBeenCalled();
  });

  it('an update of an inactive configuration publishes nothing', async () => {
    const id = await create('csr-no-publish', withStreamingTimeout(45000));
    const publish = publishStub;
    publish.mockClear();
    expect((await patch(id, { description: 'inactive, renamed' })).status).toBe(200);
    expect(publish).not.toHaveBeenCalled();
  });

  it('only activation changes which configuration is active: deactivate, edit, reactivate is refused at its first step', async () => {
    const id = await create('csr-bypass', withStreamingTimeout(45000));
    expect((await POST(`${S}/activateConfiguration`, { configId: id }, ADMIN)).data.success).toBe(true);
    const before = await read(id);
    const publish = publishStub;
    publish.mockClear();
    const step1 = await patch(id, { isActive: false });
    expect(step1.status).toBe(400);
    expect(step1.data.error.message).toBe('Which configuration is active, and when and by whom it was deployed, changes only through Activate or Rollback.');
    expect((await patch(id, { configData: JSON.stringify(withStreamingTimeout(60000)) })).status).toBe(400);
    expect((await patch(id, { configData: JSON.stringify(withStreamingTimeout(60000)), isActive: false })).status).toBe(400);
    const after = await read(id);
    expect(after).toMatchObject({ isActive: true, configData: before.configData, checksum: before.checksum });
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses isActive on an inactive row, and deployedAt / deployedBy, translated', async () => {
    const id = await create('csr-second-active', withStreamingTimeout(45000));
    const res = await patch(id, { isActive: true });
    expect(res.status).toBe(400);
    expect((await read(id)).isActive).toBe(false);
    const active = await GET(`${S}/ApiConfigurations?$filter=isActive eq true&$select=ID`, ADMIN);
    expect(active.data.value.length).toBeLessThanOrEqual(1);
    expect((await patch(id, { deployedBy: 'someone' })).status).toBe(400);
    expect((await patch(id, { deployedAt: '2026-01-01T00:00:00Z' })).status).toBe(400);
    const german = await patch(id, { isActive: true }, { 'Accept-Language': 'de' });
    expect(german.data.error.message).toMatch(/^Welche Konfiguration aktiv ist/);
  });

  it('activation and rollback still change which configuration is active', async () => {
    const first = await create('csr-first', withStreamingTimeout(45000));
    const second = await create('csr-second', withStreamingTimeout(50000));
    expect((await POST(`${S}/activateConfiguration`, { configId: first }, ADMIN)).data.success).toBe(true);
    // deployedAt orders the rollback; keep the two activations apart
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await POST(`${S}/activateConfiguration`, { configId: second }, ADMIN)).data.success).toBe(true);
    expect((await read(first)).isActive).toBe(false);
    expect((await read(second))).toMatchObject({ isActive: true, deployedBy: 'csr-admin@test.com' });

    const rolled = await POST(`${S}/rollbackConfiguration`, { reason: 'test' }, ADMIN);
    expect(rolled.data.success).toBe(true);
    expect((await read(first)).isActive).toBe(true);
    expect((await read(second)).isActive).toBe(false);
  });

  it('activation heals a stale checksum', async () => {
    const id = await create('csr-heal', withStreamingTimeout(45000));
    await cds.run(cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations').set({ checksum: 'stale' }).where({ ID: id }));
    const activated = await POST(`${S}/activateConfiguration`, { configId: id }, ADMIN);
    expect(activated.data.success).toBe(true);
    const row = await read(id);
    expect(row.checksum).toBe(sha256(JSON.stringify(JSON.parse(row.configData))));
    expect(activated.data.checksum).toBe(row.checksum);
  });

  it('refuses a POST on the entity with 400 and stores nothing', async () => {
    const before = (await GET(`${S}/ApiConfigurations?$count=true&$top=0`, ADMIN)).data['@odata.count'];
    const res = await POST(`${S}/ApiConfigurations`, { name: 'csr-post', version: '1.0.0', configData: JSON.stringify(withStreamingTimeout(45000)) }, ADMIN);
    expect(res.status).toBe(400);
    expect(res.data.error.message).toMatch(/createConfiguration/);
    const after = (await GET(`${S}/ApiConfigurations?$count=true&$top=0`, ADMIN)).data['@odata.count'];
    expect(after).toBe(before);
  });

  it('createConfiguration (also what Duplicate calls) still creates an inactive row with its own checksum', async () => {
    const config = withStreamingTimeout(45000);
    const id = await create('csr-create-guard', config);
    const row = await read(id);
    expect(row.isActive).toBe(false);
    expect(row.checksum).toBe(sha256(JSON.stringify(config)));
    expect(row.isValid).toBe(true);
  });

  it('the REST PUT stores a configuration whose checksum and validity match its document', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      const roles = ['admin'];
      req.user = { id: 'csr-admin@test.com', email: 'csr-admin@test.com', roles, scope: roles, attr: { email: 'csr-admin@test.com' }, tenant: 'default', locale: 'en', is: (role: string) => roles.includes(role), _roles: roles };
      next();
    });
    app.use('/api/admin', router);

    const config = withStreamingTimeout(10000);
    const res = await request(app).put('/api/admin/api-config').send(config);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const active = await GET(`${S}/ApiConfigurations?$filter=isActive eq true`, ADMIN);
    expect(active.data.value).toHaveLength(1);
    const row = active.data.value[0];
    expect(row.checksum).toBe(sha256(JSON.stringify(JSON.parse(row.configData))));
    expect(row.checksum).toBe(res.body.checksum);
    expect(row.isValid).toBe(true);
    expect(JSON.parse(row.validationWarnings)).toEqual([STREAMING_WARNING]);
  });
});
