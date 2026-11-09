/**
 * /api/plugins (spec 2026-11-04 §7, §8) and the two ValidationService functions the gateway calls,
 * against an in-memory database. The gateways' status (Valkey) and the change marker are mocked.
 */
import path from 'path';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { strToU8, zipSync } from 'fflate';
import Ajv2020 from 'ajv/dist/2020';
import { loadOpenApi } from '@sap-llm-gateway/test-utils';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'cs-admin@test.com': { id: 'cs-admin@test.com', roles: ['admin', 'user'] },
  'cs-user@test.com': { id: 'cs-user@test.com', roles: ['user'] } } };
jest.mock('../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
const scanJson = jest.fn();
const publish = jest.fn();
jest.mock('../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0),
    publish: (...a: any[]) => publish(...a), scanJson: (...a: any[]) => scanJson(...a), shutdown: jest.fn() } }));

const { GET } = cds.test(path.resolve(__dirname, '..'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pluginsRouter = require('../src/srv/plugins-rest-api');
import { getDefaultLogger } from '@libs/logger';
import { listPackages } from '../src/services/pluginStore';

const SECRET = 'f'.repeat(64);
const PACKAGES = 'sap.llm.gateway.admin.PluginPackages';
const STATES = 'sap.llm.gateway.admin.PluginStates';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
const ADMIN = { id: 'admin@example.com', roles: ['admin', 'user'] };
const USER = { id: 'user@example.com', roles: ['user'] };

const appAs = (user: any): express.Application => {
  const app = express();
  app.use((req: any, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/plugins', pluginsRouter);
  return app;
};
const asAdmin = () => request(appAs(ADMIN));
// The 'disable' route needs a JSON content type, so every call there sends a body.

const manifestOf = (over: Record<string, unknown> = {}) =>
  ({ id: 'acme', version: '1.0.0', runtime: 'node', gateway: '*', help: { en: { summary: 'Acme plugin' } }, ...over });
const zipOf = (manifest: Record<string, unknown>, files: Record<string, string> = {}): Buffer =>
  Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'index.js': strToU8('module.exports = [];'), ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])) }));
const upload = (body: Buffer | string, app = asAdmin()) => app.post('/api/plugins').set('Content-Type', 'application/zip').send(body);
const sha = (b: Buffer) => require('crypto').createHash('sha256').update(b).digest('hex');
const audits = async (action: string) => cds.run(cds.ql.SELECT.from(AUDIT).where({ action }));
const gatewayToken = () => ({ headers: { Authorization: `Bearer ${jwt.sign({ service: 'gateway' }, SECRET, { algorithm: 'HS256', issuer: 'gateway-service', expiresIn: '5m' })}` } });
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);

const report = (plugins: any[]) =>
  [{ key: 'sap-llm-gateway:plugin-status:gw-1', value: { gatewayVersion: '0.11.0', at: new Date().toISOString(), plugins } }];

beforeEach(async () => {
  process.env.VALIDATION_TOKEN_SECRET = SECRET;
  delete process.env.INSTALLED_PLUGINS_ENABLED;
  scanJson.mockReset().mockResolvedValue([]);
  publish.mockReset().mockResolvedValue(true);
  const { DELETE: DEL } = cds.ql;
  await cds.run([DEL.from(PACKAGES), DEL.from(STATES), DEL.from(AUDIT), DEL.from(CONFIGS)]);
});

describe('access', () => {
  const routes: Array<[string, string]> = [['get', '/'], ['post', '/'], ['post', '/acme/enable'], ['post', '/acme/disable'], ['delete', '/acme/versions/1.0.0']];

  it('answers 403 to a signed-in user without the admin role on every route', async () => {
    for (const [method, route] of routes) {
      const res = await (request(appAs(USER)) as any)[method](`/api/plugins${route === '/' ? '' : route}`).set('Content-Type', 'application/zip').send(zipOf(manifestOf()));
      expect({ route: `${method} ${route}`, status: res.status }).toEqual({ route: `${method} ${route}`, status: 403 });
    }
    expect(await cds.run(cds.ql.SELECT.from(PACKAGES))).toHaveLength(0);
  });

  it('answers 401 to a caller with no identity', async () => {
    for (const [method, route] of routes) {
      const res = await (request(appAs(null)) as any)[method](`/api/plugins${route === '/' ? '' : route}`);
      expect({ route: `${method} ${route}`, status: res.status }).toEqual({ route: `${method} ${route}`, status: 401 });
    }
  });
});

describe('upload', () => {
  it('stores a valid package disabled and answers 201, with the sha256 of the raw bytes', async () => {
    const zip = zipOf(manifestOf());
    const res = await upload(zip);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'acme', version: '1.0.0', sha256: sha(zip), sizeBytes: zip.length, enabled: false });
    const [row] = await cds.run(cds.ql.SELECT.from(PACKAGES));
    expect(row).toMatchObject({ pluginId: 'acme', version: '1.0.0', sha256: sha(zip), sizeBytes: zip.length, createdBy: ADMIN.id });
    expect(Buffer.from(row.contentBase64, 'base64').equals(zip)).toBe(true);
    expect(await cds.run(cds.ql.SELECT.from(STATES))).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    const [event] = await audits('plugin.upload');
    expect(event).toMatchObject({ actorId: ADMIN.id, resourceType: 'Plugin', resourceId: 'acme', outcome: 'success' });
    expect(JSON.parse(event.details)).toMatchObject({ version: '1.0.0', sha256: sha(zip) });
  });

  it.each([
    ['not a zip', () => Buffer.from('this is not a zip file at all'), 'NOT_A_ZIP'],
    ['no manifest', () => Buffer.from(zipSync({ 'index.js': strToU8('x') })), 'MANIFEST_MISSING'],
    ['no entry file', () => Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifestOf())) })), 'ENTRY_MISSING'],
    ['a $ref in the schema', () => zipOf(manifestOf({ settings: { schema: { type: 'object', properties: { a: { $ref: '#/x' } } } } })), 'SCHEMA_REF_REFUSED'],
    ['an unsupported runtime', () => zipOf(manifestOf({ runtime: 'deno' })), 'RUNTIME_UNSUPPORTED'],
    ['an invalid id', () => zipOf(manifestOf({ id: 'a b' })), 'MANIFEST_INVALID'],
    ['an unparseable gateway range', () => zipOf(manifestOf({ gateway: 'not a range' })), 'MANIFEST_INVALID'],
  ])('refuses %s with 400 and the library code', async (_name, build, code) => {
    const res = await upload(build());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(code);
    expect(await cds.run(cds.ql.SELECT.from(PACKAGES))).toHaveLength(0);
  });

  it('refuses a settings schema Ajv cannot compile with 400', async () => {
    const res = await upload(zipOf(manifestOf({ settings: { schema: { type: 'bogus' } } })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SETTINGS_SCHEMA_INVALID');
  });

  it('accepts a settings schema that compiles', async () => {
    const res = await upload(zipOf(manifestOf({ settings: { schema: { type: 'object', properties: { url: { type: 'string' } } }, defaults: {} } })));
    expect(res.status).toBe(201);
  });

  it('refuses an id or version too long for the store with 400', async () => {
    expect((await upload(zipOf(manifestOf({ id: 'a'.repeat(65) })))).status).toBe(400);
    expect((await upload(zipOf(manifestOf({ version: `1.0.0-${'a'.repeat(70)}` })))).status).toBe(400);
  });

  it('answers 413 TOO_LARGE for a body over 20 MB', async () => {
    const res = await upload(Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('TOO_LARGE');
  });

  it('refuses a body that is not sent as application/zip', async () => {
    const res = await asAdmin().post('/api/plugins').set('Content-Type', 'application/json').send({ a: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOT_A_ZIP');
  });

  it('same id and version with another sha256 is 409; the same package again is 200 and stores nothing new', async () => {
    const first = zipOf(manifestOf());
    expect((await upload(first)).status).toBe(201);
    const again = await upload(first);
    expect(again.status).toBe(200);
    expect(again.body.unchanged).toBe(true);
    const other = await upload(zipOf(manifestOf(), { 'extra.txt': 'different' }));
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('VERSION_EXISTS');
    expect(await cds.run(cds.ql.SELECT.from(PACKAGES))).toHaveLength(1);
    expect(await audits('plugin.upload')).toHaveLength(1);
  });

  it('refuses an id that a shipped plugin of the gateway already uses, by the status report', async () => {
    scanJson.mockResolvedValue(report([{ id: 'pseudonymizationPlugin', version: '', kind: 'shipped', state: 'running', rules: [] }]));
    const res = await upload(zipOf(manifestOf({ id: 'pseudonymizationPlugin' })));
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: 'PLUGIN_ID_TAKEN' });
    expect((await upload(zipOf(manifestOf({ id: 'fresh' })))).status).toBe(201);
  });

  it('accepts such an id when the gateways have not reported (the gateway decides at sync)', async () => {
    scanJson.mockResolvedValue([]);
    expect((await upload(zipOf(manifestOf({ id: 'pseudonymizationPlugin' })))).status).toBe(201);
    scanJson.mockResolvedValue(null);
    expect((await upload(zipOf(manifestOf({ id: 'oldScript' })))).status).toBe(201);
  });
});

describe('enable', () => {
  it('sets the enabled version, publishes the marker and audits with the sha256', async () => {
    const zip = zipOf(manifestOf());
    await upload(zip);
    const res = await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'acme', enabledVersion: '1.0.0', sha256: sha(zip) });
    expect(await cds.run(cds.ql.SELECT.from(STATES))).toMatchObject([{ pluginId: 'acme', enabledVersion: '1.0.0' }]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toBe('sap-llm-gateway:plugins-changed');
    const [event] = await audits('plugin.enable');
    expect(event).toMatchObject({ actorId: ADMIN.id, resourceId: 'acme' });
    expect(JSON.parse(event.details)).toMatchObject({ version: '1.0.0', sha256: sha(zip) });
  });

  it('switches version and records the previous one', async () => {
    await upload(zipOf(manifestOf()));
    await upload(zipOf(manifestOf({ version: '1.1.0' })));
    await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' });
    await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.1.0' });
    expect(await cds.run(cds.ql.SELECT.from(STATES))).toMatchObject([{ enabledVersion: '1.1.0' }]);
    expect(JSON.parse((await audits('plugin.enable')).pop().details).previousVersion).toBe('1.0.0');
  });

  it('refuses a version incompatible with the admin own version with 409', async () => {
    await upload(zipOf(manifestOf({ gateway: '>=99.0.0' })));
    const res = await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INCOMPATIBLE');
    expect(await cds.run(cds.ql.SELECT.from(STATES))).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown version and 400 without one', async () => {
    await upload(zipOf(manifestOf()));
    expect((await asAdmin().post('/api/plugins/acme/enable').send({ version: '9.9.9' })).status).toBe(404);
    expect((await asAdmin().post('/api/plugins/ghost/enable').send({ version: '1.0.0' })).status).toBe(404);
    expect((await asAdmin().post('/api/plugins/acme/enable').send({})).status).toBe(400);
  });
});

describe('disable and remove', () => {
  const enabled = async () => { await upload(zipOf(manifestOf())); await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' }); publish.mockClear(); };

  it('disable clears the enabled version, publishes and audits', async () => {
    await enabled();
    const res = await asAdmin().post('/api/plugins/acme/disable').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'acme', enabledVersion: null, warnings: [] });
    expect(await cds.run(cds.ql.SELECT.from(STATES))).toMatchObject([{ enabledVersion: null }]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await audits('plugin.disable')).toHaveLength(1);
  });

  it('disable reads the gateways status before it publishes the marker', async () => {
    await enabled();
    await asAdmin().post('/api/plugins/acme/disable').send({});
    const lastScan = Math.max(...scanJson.mock.invocationCallOrder);
    const lastPublish = Math.max(...publish.mock.invocationCallOrder);
    expect(lastScan).toBeLessThan(lastPublish);
  });

  it('disable still succeeds, without warnings, when the configuration cannot be read', async () => {
    await enabled();
    scanJson.mockResolvedValue(report([{ id: 'acme', version: '1.0.0', kind: 'installed', state: 'running', rules: [{ id: 'r', strategy: 'anthropic' }] }]));
    await cds.run(cds.ql.INSERT.into(CONFIGS).entries({ name: 'c', version: '1', configData: '{not json', isActive: true }));
    const res = await asAdmin().post('/api/plugins/acme/disable').send({});
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
  });

  it('disable works with the setting off', async () => {
    await enabled();
    process.env.INSTALLED_PLUGINS_ENABLED = 'false';
    expect((await asAdmin().post('/api/plugins/acme/disable').send({})).status).toBe(200);
  });

  it('disable of an unknown plugin is 404', async () => {
    expect((await asAdmin().post('/api/plugins/ghost/disable').send({})).status).toBe(404);
  });

  it('disable warns when the active configuration still has hooks naming a reported rule of the plugin', async () => {
    await enabled();
    scanJson.mockResolvedValue(report([{ id: 'acme', version: '1.0.0', kind: 'installed', state: 'running', rules: [{ id: 'acmeRule', strategy: 'anthropic' }, { id: 'unusedRule', strategy: 'anthropic' }] }]));
    const config = { api_config: { hooks: { defaults: { anthropic: { invoke: [{ request: { callback: { id: 'acmeRule' } }, match: [] }] } } } } };
    await cds.run(cds.ql.INSERT.into(CONFIGS).entries({ name: 'c', version: '1', configData: JSON.stringify(config), isActive: true }));
    const res = await asAdmin().post('/api/plugins/acme/disable').send({});
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatchObject({ code: 'HOOKS_REFERENCE_PLUGIN', ruleIds: ['acmeRule'] });
  });

  it('remove refuses the enabled version with 409, removes another and audits', async () => {
    await enabled();
    await upload(zipOf(manifestOf({ version: '1.1.0' })));
    const refused = await asAdmin().delete('/api/plugins/acme/versions/1.0.0');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('VERSION_ENABLED');
    const done = await asAdmin().delete('/api/plugins/acme/versions/1.1.0');
    expect(done.status).toBe(200);
    expect((await listPackages()).map((p) => p.version)).toEqual(['1.0.0']);
    expect(await audits('plugin.remove')).toHaveLength(1);
    expect((await asAdmin().delete('/api/plugins/acme/versions/1.1.0')).status).toBe(404);
  });

  it('remove works with the setting off, and the last version takes the state row with it', async () => {
    await enabled();
    await asAdmin().post('/api/plugins/acme/disable').send({});
    process.env.INSTALLED_PLUGINS_ENABLED = 'false';
    expect((await asAdmin().delete('/api/plugins/acme/versions/1.0.0')).status).toBe(200);
    expect(await cds.run(cds.ql.SELECT.from(STATES))).toHaveLength(0);
  });
});

describe('schemas with an $id', () => {
  const withId = (version: string, id = 'https://example.com/acme.json') =>
    zipOf(manifestOf({ version, settings: { schema: { $id: id, type: 'object', properties: { a: { type: 'string' } } } } }));

  it('a repeated $id does not poison later uploads, refused ones included', async () => {
    expect((await upload(withId('1.0.0'))).status).toBe(201);
    expect((await upload(withId('1.0.0'))).status).toBe(200);
    expect((await upload(withId('1.1.0'))).status).toBe(201);
    expect((await upload(zipOf(manifestOf({ version: '1.2.0', settings: { schema: { $id: 'https://example.com/acme.json', type: 'bogus' } } })))).status).toBe(400);
    expect((await upload(withId('1.3.0'))).status).toBe(201);
  });
});

describe('enable and remove together', () => {
  it('never leave a state naming a version that was removed', async () => {
    for (let i = 0; i < 5; i++) {
      await cds.run([cds.ql.DELETE.from(PACKAGES), cds.ql.DELETE.from(STATES)]);
      await upload(zipOf(manifestOf({ version: '1.0.0' })));
      await upload(zipOf(manifestOf({ version: '1.1.0' })));
      await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' });
      await Promise.all([
        asAdmin().post('/api/plugins/acme/enable').send({ version: '1.1.0' }),
        asAdmin().delete('/api/plugins/acme/versions/1.1.0'),
      ]);
      const [state] = await cds.run(cds.ql.SELECT.from(STATES));
      const versions = (await cds.run(cds.ql.SELECT.from(PACKAGES).columns('version'))).map((p: any) => p.version);
      expect(versions).toContain(state.enabledVersion);
    }
  });

  it('enable of a version removed a moment before is 404 and writes no state', async () => {
    await upload(zipOf(manifestOf()));
    await asAdmin().delete('/api/plugins/acme/versions/1.0.0');
    expect((await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' })).status).toBe(404);
    expect(await cds.run(cds.ql.SELECT.from(STATES))).toHaveLength(0);
  });
});

describe('INSTALLED_PLUGINS_ENABLED=false', () => {
  beforeEach(() => { process.env.INSTALLED_PLUGINS_ENABLED = 'false'; });

  it('refuses upload and enable with 403 naming the setting', async () => {
    const up = await upload(zipOf(manifestOf()));
    expect(up.status).toBe(403);
    expect(up.body.message).toContain('INSTALLED_PLUGINS_ENABLED');
    const en = await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' });
    expect(en.status).toBe(403);
    expect(en.body.message).toContain('INSTALLED_PLUGINS_ENABLED');
    expect(await cds.run(cds.ql.SELECT.from(PACKAGES))).toHaveLength(0);
  });

  it('still lists, saying the feature is off', async () => {
    const res = await asAdmin().get('/api/plugins');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });
});

describe('GET /api/plugins', () => {
  it('lists plugins, versions, enabled state, status and built-ins, and never reads the zips', async () => {
    await upload(zipOf(manifestOf()));
    await upload(zipOf(manifestOf({ version: '2.0.0', gateway: '>=99.0.0' })));
    await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' });
    scanJson.mockResolvedValue(report([
      { id: 'acme', version: '1.0.0', kind: 'installed', state: 'running', rules: [{ id: 'acmeRule', strategy: 'anthropic' }] },
      { id: 'builtin', version: '', kind: 'shipped', state: 'running', rules: [{ id: 'b', strategy: 'openai' }] },
    ]));
    const spy = jest.spyOn(cds, 'run');
    const res = await asAdmin().get('/api/plugins');
    const issued = JSON.stringify(spy.mock.calls.map((c: any[]) => c[0]));
    spy.mockRestore();
    expect(issued).toContain('PluginPackages');
    expect(issued).not.toContain('contentBase64');
    expect(JSON.stringify(res.body)).not.toContain('contentBase64');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.gatewayStatus.available).toBe(true);
    const [acme] = res.body.plugins;
    expect(acme).toMatchObject({ id: 'acme', enabledVersion: '1.0.0' });
    expect(acme.versions.map((v: any) => [v.version, v.compatible, v.uploadedBy])).toEqual([['1.0.0', true, ADMIN.id], ['2.0.0', false, ADMIN.id]]);
    expect(acme.status).toMatchObject([{ instance: 'gw-1', state: 'running', rules: [{ id: 'acmeRule' }] }]);
    expect(res.body.builtins.map((b: any) => [b.id, b.kind])).toEqual([['builtin', 'shipped']]);
  });

  it('without Valkey the status is unavailable but the list still works', async () => {
    scanJson.mockResolvedValue(null);
    const res = await asAdmin().get('/api/plugins');
    expect(res.status).toBe(200);
    expect(res.body.gatewayStatus).toEqual({ instances: [], available: false });
  });
});

describe('ValidationService getPlugins() and getPluginPackage()', () => {
  const LIST = '/odata/v4/validation/getPlugins()';
  const PACKAGE = (id: string, version: string) => `/odata/v4/validation/getPluginPackage(id='${id}',version='${version}')`;
  const asAdminUser = { auth: { username: 'cs-admin@test.com', password: 'x' } };
  const asPlainUser = { auth: { username: 'cs-user@test.com', password: 'x' } };

  it('requires the gateway service JWT: no token, a user and a forged token get 403', async () => {
    const forged = jwt.sign({ service: 'gateway' }, 'not-the-secret', { algorithm: 'HS256', issuer: 'gateway-service' });
    for (const url of [LIST, PACKAGE('acme', '1.0.0')]) {
      expect((await ok(GET(url))).status).toBe(403);
      expect((await ok(GET(url, asAdminUser))).status).toBe(403);
      expect((await ok(GET(url, asPlainUser))).status).toBe(403);
      expect((await ok(GET(url, { headers: { Authorization: `Bearer ${forged}` } }))).status).toBe(403);
    }
  });

  it('lists the enabled versions with their sha256 and nothing else', async () => {
    const zip = zipOf(manifestOf());
    await upload(zip);
    await upload(zipOf(manifestOf({ id: 'other' })));
    await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' });
    const res = await GET(LIST, gatewayToken());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ success: true, enabled: true, plugins: [{ id: 'acme', version: '1.0.0', sha256: sha(zip) }] });
  });

  it('with the setting off: success, enabled false, no plugins, and no package', async () => {
    await upload(zipOf(manifestOf()));
    await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' });
    process.env.INSTALLED_PLUGINS_ENABLED = 'false';
    const res = await GET(LIST, gatewayToken());
    expect(res.data).toMatchObject({ success: true, enabled: false, plugins: [] });
    expect((await ok(GET(PACKAGE('acme', '1.0.0'), gatewayToken()))).status).toBe(404);
  });

  it('serves the enabled package as base64 with its sha256, and 404 for any other version', async () => {
    const zip = zipOf(manifestOf());
    await upload(zip);
    await upload(zipOf(manifestOf({ version: '1.1.0' })));
    await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' });
    const res = await GET(PACKAGE('acme', '1.0.0'), gatewayToken());
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.sha256).toBe(sha(zip));
    expect(Buffer.from(res.data.contentBase64, 'base64').equals(zip)).toBe(true);
    expect((await ok(GET(PACKAGE('acme', '1.1.0'), gatewayToken()))).status).toBe(404);
    expect((await ok(GET(PACKAGE('ghost', '1.0.0'), gatewayToken()))).status).toBe(404);
  });
});

const HOOK = { request: { callback: { id: 'acmeRule' }, match: ['acme:any'] } };
const HOOKS = { definitions: { 'acme:any': { type: 'header', name: 'x-acme', equals: '1' } }, defaults: { anthropic: { invoke: [HOOK] } } };
const SETTINGS = { schema: { type: 'object', properties: { retries: { type: 'number' } }, additionalProperties: false } };

const seedActive = async (apiConfig: Record<string, unknown> = {}, name = 'base'): Promise<string> => {
  const ID = cds.utils.uuid();
  await cds.run(cds.ql.INSERT.into(CONFIGS).entries({ ID, name, version: `v-${ID.slice(0, 6)}`, configData: JSON.stringify({ api_config: apiConfig }),
    checksum: 'c', isActive: true, createdAt: new Date().toISOString(), createdBy: 'seed' }));
  return ID;
};
const enableAcme = async (over: Record<string, unknown> = {}): Promise<void> => {
  const manifest = manifestOf(over);
  expect((await upload(zipOf(manifest))).status).toBe(201);
  expect((await asAdmin().post(`/api/plugins/${manifest.id}/enable`).send({ version: manifest.version })).status).toBe(200);
};
const validateAs = (apiConfig: Record<string, unknown>) =>
  cds.tx({ user: new cds.User({ id: ADMIN.id, roles: ADMIN.roles }) }, () =>
    cds.services.AdminService.send('validateConfiguration', { configData: JSON.stringify({ api_config: apiConfig }) }));
const configRows = (): Promise<any[]> => cds.run(cds.ql.SELECT.from(CONFIGS));

describe('settings at save', () => {
  it('an enabled plugin with settings that break its schema makes the configuration invalid', async () => {
    await enableAcme({ settings: SETTINGS });
    const result = await validateAs({ plugins: { acme: { retries: 'many' } } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.startsWith('/api_config/plugins/acme'))).toBe(true);
    expect((await validateAs({ plugins: { acme: { retries: 3 } } })).valid).toBe(true);
  });

  it('settings of a disabled plugin are only a warning', async () => {
    await upload(zipOf(manifestOf({ settings: SETTINGS })));
    const result = await validateAs({ plugins: { acme: { retries: 'many' } } });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('acme'))).toBe(true);
  });

  it('a hook naming a rule no gateway reports is a warning, and none with no report', async () => {
    const hooks = { defaults: { anthropic: { invoke: [HOOK] } }, definitions: HOOKS.definitions };
    expect((await validateAs({ hooks })).warnings.some((w: string) => w.includes('acmeRule'))).toBe(false);
    scanJson.mockResolvedValue(report([{ id: 'other', version: '', kind: 'shipped', state: 'running', rules: [{ id: 'x', strategy: 'before' }] }]));
    const result = await validateAs({ hooks });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('acmeRule'))).toBe(true);
  });
});

describe('enable with stored settings', () => {
  it('warns when the stored settings fail the new version schema', async () => {
    await seedActive({ plugins: { acme: { retries: 'many' } } });
    await upload(zipOf(manifestOf({ version: '2.0.0', settings: SETTINGS })));
    const res = await asAdmin().post('/api/plugins/acme/enable').send({ version: '2.0.0' });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatchObject({ code: 'STORED_SETTINGS_INVALID' });
    expect(res.body.warnings[0].message).toContain('retries');
  });

  it('has no warning when the stored settings fit, or there are none, or no configuration is active', async () => {
    await upload(zipOf(manifestOf({ settings: SETTINGS })));
    expect((await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' })).body.warnings).toEqual([]);
    await seedActive({ plugins: { acme: { retries: 2 } } });
    expect((await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' })).body.warnings).toEqual([]);
  });
});

describe('POST /api/plugins/suggested-hooks', () => {
  const post = (ids: unknown) => asAdmin().post('/api/plugins/suggested-hooks').send({ ids });
  const HOOK_B = { request: { callback: { id: 'betaRule' }, match: ['beta:any'] } };
  const HOOKS_B = { definitions: { 'beta:any': { type: 'header', name: 'x-beta', equals: '1' } }, defaults: { anthropic: { invoke: [HOOK_B] } } };

  it('stores one configuration with the hooks of every plugin named, and activates nothing', async () => {
    await enableAcme({ hooks: HOOKS });
    await enableAcme({ id: 'beta', version: '2.0.0', hooks: HOOKS_B });
    const baseId = await seedActive();
    const before = (await configRows()).length;
    const res = await post(['acme', 'beta']);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Suggested hooks: acme 1.0.0, beta 2.0.0', warnings: [] });
    const rows = await configRows();
    expect(rows).toHaveLength(before + 1);
    const data = JSON.parse(rows.find((r) => r.ID === res.body.configId).configData).api_config;
    expect(data.hooks.defaults.anthropic.invoke).toEqual([HOOK, HOOK_B]);
    expect(Object.keys(data.hooks.definitions).sort()).toEqual(['acme:any', 'beta:any']);
    expect(rows.filter((r) => r.isActive).map((r) => r.ID)).toEqual([baseId]);
    expect(await audits('plugin.suggest_hooks')).toHaveLength(2);
  });

  it('one id gives the same name as the single-plugin route', async () => {
    await enableAcme({ hooks: HOOKS });
    await seedActive();
    const res = await post(['acme']);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('acme 1.0.0 suggested hooks');
  });

  it('a plugin with nothing to add is named in the warnings, and the others still go in', async () => {
    await enableAcme({ hooks: HOOKS });
    await enableAcme({ id: 'plain', version: '1.0.0' });
    await seedActive();
    const res = await post(['acme', 'plain']);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('acme 1.0.0 suggested hooks');
    expect(res.body.warnings.some((w: string) => w.includes('"plain"'))).toBe(true);
  });

  it('when no plugin has anything to add it refuses and creates nothing', async () => {
    await enableAcme({ id: 'plain', version: '1.0.0' });
    await seedActive();
    const before = (await configRows()).length;
    const res = await post(['plain']);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_SUGGESTED_HOOKS');
    expect(await configRows()).toHaveLength(before);
  });

  it('a plugin that is not enabled refuses the whole request and creates nothing', async () => {
    await enableAcme({ hooks: HOOKS });
    await seedActive();
    const before = (await configRows()).length;
    const res = await post(['acme', 'ghost']);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PLUGIN_NOT_FOUND');
    expect(await configRows()).toHaveLength(before);
  });

  it.each([[undefined], [[]], ['acme'], [['acme', 'acme']], [['../x']], [[1]], [Array.from({ length: 51 }, (_v, i) => `p${i}`)]])('refuses %j as the ids', async (ids) => {
    const res = await post(ids);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_id');
  });

  it('refuses a non-JSON content type with 415', async () => {
    const res = await asAdmin().post('/api/plugins/suggested-hooks').type('form').send('ids=acme');
    expect(res.status).toBe(415);
  });
});

describe('POST /api/plugins/:id/suggested-hooks', () => {
  const post = (id = 'acme') => asAdmin().post(`/api/plugins/${id}/suggested-hooks`).send({});

  it('stores a new configuration with the hooks merged in, does not activate it, and names it', async () => {
    await enableAcme({ hooks: HOOKS });
    const baseId = await seedActive({ platform: { timeouts: { default: 60000 } } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'acme 1.0.0 suggested hooks', warnings: [] });
    const created = (await configRows()).find((r) => r.ID === res.body.configId);
    expect(created).toMatchObject({ name: 'acme 1.0.0 suggested hooks', isActive: false });
    const data = JSON.parse(created.configData).api_config;
    expect(data.hooks.defaults.anthropic.invoke).toEqual([HOOK]);
    expect(data.platform.timeouts.default).toBe(60000);
    const active = (await configRows()).filter((r) => r.isActive);
    expect(active.map((r) => r.ID)).toEqual([baseId]);
    expect(await audits('plugin.suggest_hooks')).toHaveLength(1);
  });

  it('returns the warning for a model whose own list replaces the defaults', async () => {
    await enableAcme({ hooks: HOOKS });
    await seedActive({ models: { overrides: { 'model-a': { hooks: { invoke: [HOOK] } } } }, hooks: { definitions: HOOKS.definitions } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.warnings.some((w: string) => w.includes('model-a'))).toBe(true);
  });

  it('refuses a non-JSON content type with 415 and creates nothing', async () => {
    await enableAcme({ hooks: HOOKS });
    await seedActive();
    const res = await asAdmin().post('/api/plugins/acme/suggested-hooks').type('form').send('a=b');
    expect(res.status).toBe(415);
    expect(await configRows()).toHaveLength(1);
  });

  it('400 when the manifest has no hooks', async () => {
    await enableAcme();
    await seedActive();
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_SUGGESTED_HOOKS');
  });

  it('404 for an unknown plugin, 409 for one that is not enabled', async () => {
    await seedActive();
    expect((await post('ghost')).status).toBe(404);
    await upload(zipOf(manifestOf({ hooks: HOOKS })));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PLUGIN_NOT_ENABLED');
  });

  it('refuses with a clear error when no configuration is active, and creates nothing', async () => {
    await enableAcme({ hooks: HOOKS });
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NO_ACTIVE_CONFIGURATION');
    expect(await configRows()).toHaveLength(0);
  });

  it('409 HOOK_CONFLICT when the configuration defines the same rule id differently, and creates nothing', async () => {
    await enableAcme({ hooks: HOOKS });
    await seedActive({ hooks: { definitions: { 'acme:any': { type: 'header', name: 'x-other', equals: '2' } } } });
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('HOOK_CONFLICT');
    expect(await configRows()).toHaveLength(1);
  });

  it('409 HOOKS_ALREADY_PRESENT when the active configuration has them all', async () => {
    await enableAcme({ hooks: HOOKS });
    await seedActive({ hooks: HOOKS });
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('HOOKS_ALREADY_PRESENT');
    expect(await configRows()).toHaveLength(1);
  });

  it('returns the validation error and creates nothing when the merged configuration is refused', async () => {
    await enableAcme({ hooks: { defaults: { anthropic: { invoke: [{ bogus: true }] } } } });
    await seedActive();
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CONFIGURATION_INVALID');
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(await configRows()).toHaveLength(1);
  });
});

describe('GET /api/plugins/settings-schemas', () => {
  const help = { en: { summary: 'English summary', settings: { retries: 'English retries' } }, pt: { summary: 'Resumo', settings: { retries: 'Tentativas' } } };
  const get = (lang?: string) => asAdmin().get(`/api/plugins/settings-schemas${lang ? `?lang=${lang}` : ''}`);

  it('applies the help of the language (pt-BR finds pt) and says there was no fallback', async () => {
    await enableAcme({ settings: SETTINGS, help });
    const res = await get('pt-BR');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'acme', summary: 'Resumo', helpFallback: false });
    expect(res.body[0].schema.properties.retries.description).toBe('Tentativas');
  });

  it('falls back to the first language, says so, and logs once per plugin version', async () => {
    await enableAcme({ version: '3.0.0', settings: SETTINGS, help });
    const info = jest.spyOn(getDefaultLogger(), 'info');
    const first = await get('fr');
    await get('fr');
    await get('de');
    expect(first.body[0]).toMatchObject({ summary: 'English summary', helpFallback: true });
    expect(first.body[0].schema.properties.retries.description).toBe('English retries');
    expect(info.mock.calls.filter((c) => String(c[1]).includes('acme') && String(c[1]).includes('3.0.0'))).toHaveLength(1);
    info.mockRestore();
  });

  it('shows the manifest defaults as schema defaults, keeping a default the schema declares and the stored manifest as it is', async () => {
    const schema = { type: 'object', properties: { retries: { type: 'number' }, timeout: { type: 'number', default: 9 }, name: { type: 'string' } } };
    await enableAcme({ settings: { schema, defaults: { retries: 3, timeout: 30, unknown: 1 } }, help });
    const res = await get();
    const props = res.body[0].schema.properties;
    expect(props.retries.default).toBe(3);
    expect(props.timeout.default).toBe(9);
    expect(props.name).toEqual({ type: 'string' });
    expect(props.unknown).toBeUndefined();
    const stored = await cds.run(cds.ql.SELECT.from(PACKAGES));
    expect(JSON.parse(stored[0].manifest).settings.schema.properties.retries).toEqual({ type: 'number' });
  });

  it('lists enabled plugins that have settings only', async () => {
    await upload(zipOf(manifestOf({ id: 'disabled', settings: SETTINGS })));
    await enableAcme({ id: 'nosettings' });
    await enableAcme({ settings: SETTINGS });
    const res = await get();
    expect(res.body.map((e: any) => e.id)).toEqual(['acme']);
  });

  it('is empty with the setting off, and does not read any zip', async () => {
    await enableAcme({ settings: SETTINGS });
    const spy = jest.spyOn(cds, 'run');
    process.env.INSTALLED_PLUGINS_ENABLED = 'false';
    expect((await get()).body).toEqual([]);
    process.env.INSTALLED_PLUGINS_ENABLED = 'true';
    await get();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('contentBase64');
    spy.mockRestore();
  });
});

describe('the id settings-schemas', () => {
  it('is refused at upload with MANIFEST_INVALID, so it can never shadow the route', async () => {
    const res = await upload(zipOf(manifestOf({ id: 'settings-schemas' })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MANIFEST_INVALID');
    expect(await cds.run(cds.ql.SELECT.from(PACKAGES))).toHaveLength(0);
  });
});

describe('answers match openapi/admin-rest.yaml', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  let doc: Awaited<ReturnType<typeof loadOpenApi>>;
  beforeAll(async () => {
    doc = await loadOpenApi(path.resolve(__dirname, '../../../openapi/admin-rest.yaml'));
    ajv.addSchema({ $id: 'admin-rest.yaml', components: doc.components });
  });

  function expectDocumented(route: string, method: string, res: request.Response): void {
    const op = (doc.paths?.[route] as any)?.[method];
    if (!op) throw new Error(`${method.toUpperCase()} ${route} is not documented`);
    let response = op.responses?.[String(res.status)];
    if (response?.$ref) response = (doc.components?.responses as any)?.[response.$ref.split('/').pop()];
    if (!response) throw new Error(`${method.toUpperCase()} ${route} does not document ${res.status}: ${JSON.stringify(res.body)}`);
    const schema = JSON.parse(JSON.stringify(response.content['application/json'].schema).replace(/"#\/components\//g, '"admin-rest.yaml#/components/'));
    const validate = ajv.compile(schema);
    const valid = validate(res.body);
    expect({ route, status: res.status, errors: valid ? null : validate.errors }).toEqual({ route, status: res.status, errors: null });
  }

  it('the list, upload, enable, disable and remove answers, and their refusals', async () => {
    const zip = zipOf(manifestOf({ settings: { schema: { type: 'object' } } }));
    scanJson.mockResolvedValue(report([{ id: 'acme', version: '1.0.0', kind: 'installed', state: 'failed', error: 'boom', rules: [{ id: 'r', strategy: 'anthropic' }] },
      { id: 'builtin', version: '', kind: 'shipped', state: 'running', rules: [] }]));
    expectDocumented('/plugins', 'post', await upload(zip));
    expectDocumented('/plugins', 'post', await upload(zip));
    expectDocumented('/plugins', 'post', await upload(Buffer.from('nope')));
    expectDocumented('/plugins', 'post', await upload(zipOf(manifestOf(), { 'x.txt': 'other' })));
    expectDocumented('/plugins', 'post', await upload(zipOf(manifestOf({ id: 'builtin' }))));
    expectDocumented('/plugins', 'post', await upload(Buffer.alloc(20 * 1024 * 1024 + 1)));
    expectDocumented('/plugins', 'post', await upload(zip, request(appAs(USER))));
    expectDocumented('/plugins', 'get', await asAdmin().get('/api/plugins'));
    expectDocumented('/plugins/{id}/enable', 'post', await asAdmin().post('/api/plugins/acme/enable').send({ version: '1.0.0' }));
    expectDocumented('/plugins/{id}/enable', 'post', await asAdmin().post('/api/plugins/acme/enable').send({ version: '8.8.8' }));
    expectDocumented('/plugins/{id}/enable', 'post', await asAdmin().post('/api/plugins/acme/enable').send({}));
    expectDocumented('/plugins/{id}/versions/{version}', 'delete', await asAdmin().delete('/api/plugins/acme/versions/1.0.0'));
    expectDocumented('/plugins/{id}/disable', 'post', await asAdmin().post('/api/plugins/acme/disable').send({}));
    expectDocumented('/plugins/{id}/disable', 'post', await asAdmin().post('/api/plugins/ghost/disable').send({}));
    expectDocumented('/plugins/{id}/disable', 'post', await asAdmin().post('/api/plugins/acme/disable').type('form').send('a=b'));
    expectDocumented('/plugins/{id}/versions/{version}', 'delete', await asAdmin().delete('/api/plugins/acme/versions/1.0.0'));
    expectDocumented('/plugins/{id}/versions/{version}', 'delete', await asAdmin().delete('/api/plugins/acme/versions/1.0.0'));
    process.env.INSTALLED_PLUGINS_ENABLED = 'false';
    expectDocumented('/plugins', 'post', await upload(zip));
  });

  it('the suggested-hooks answer for several plugins, and its refusals', async () => {
    const path = '/plugins/suggested-hooks';
    const post = (ids: unknown) => asAdmin().post('/api/plugins/suggested-hooks').send({ ids });
    await enableAcme({ hooks: HOOKS });
    await seedActive();
    expectDocumented(path, 'post', await post([]));
    expectDocumented(path, 'post', await post(['ghost']));
    expectDocumented(path, 'post', await post(['acme']));
    expectDocumented(path, 'post', await asAdmin().post('/api/plugins/suggested-hooks').type('form').send('a=b'));
    expectDocumented(path, 'post', await request(appAs(USER)).post('/api/plugins/suggested-hooks').send({ ids: ['acme'] }));
  });

  it('the suggested-hooks and settings-schemas answers, and their refusals', async () => {
    const path = (id: string) => `/api/plugins/${id}/suggested-hooks`;
    expectDocumented('/plugins/{id}/suggested-hooks', 'post', await asAdmin().post(path('ghost')).send({}));
    await enableAcme({ settings: SETTINGS });
    expectDocumented('/plugins/{id}/suggested-hooks', 'post', await asAdmin().post(path('acme')).send({}));
    expectDocumented('/plugins/{id}/suggested-hooks', 'post', await asAdmin().post(path('acme')).type('form').send('a=b'));
    expectDocumented('/plugins/{id}/suggested-hooks', 'post', await asAdmin().post(path('acme')).send({}));
    expectDocumented('/plugins/{id}/suggested-hooks', 'post', await request(appAs(USER)).post(path('acme')).send({}));
    await asAdmin().post('/api/plugins/acme/disable').send({});
    await upload(zipOf(manifestOf({ version: '2.0.0', hooks: HOOKS, settings: SETTINGS })));
    await asAdmin().post('/api/plugins/acme/enable').send({ version: '2.0.0' });
    expectDocumented('/plugins/{id}/suggested-hooks', 'post', await asAdmin().post(path('acme')).send({}));
    await seedActive();
    expectDocumented('/plugins/{id}/suggested-hooks', 'post', await asAdmin().post(path('acme')).send({}));
    expectDocumented('/plugins/settings-schemas', 'get', await asAdmin().get('/api/plugins/settings-schemas?lang=en'));
    expectDocumented('/plugins/settings-schemas', 'get', await request(appAs(USER)).get('/api/plugins/settings-schemas'));
    await seedActive({ plugins: { acme: { retries: 'many' } } });
    await upload(zipOf(manifestOf({ version: '3.0.0', settings: SETTINGS })));
    expectDocumented('/plugins/{id}/enable', 'post', await asAdmin().post('/api/plugins/acme/enable').send({ version: '3.0.0' }));
  });
});
