/**
 * The cockpit's configuration app sends Activate and Rollback through the UI5 OData V4 model's
 * default group ($auto, no $direct group in its manifest), so in production they arrive inside a
 * multipart/mixed $batch. These tests send the same shape (see batchBody) and check that the
 * hand-over still happens only after the commit of the batch part. cds.test on in-memory SQLite (one
 * connection); the publisher is a fake iovalkey a test can look through at the moment of a publish.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'hab-admin@test.com': { id: 'hab-admin@test.com', roles: ['admin', 'user'] } } };

type Hook = (channel: string, event: any) => Promise<void>;
const mockValkey = { published: [] as { channel: string; message: string }[], onPublish: null as Hook | null };
jest.mock('iovalkey', () => {
  class FakeValkey {
    async ping() { return 'PONG'; }
    async get() { return null; }
    async subscribe() { return 0; }
    on() { return this; }
    async publish(channel: string, message: string) {
      if (mockValkey.onPublish) await mockValkey.onPublish(channel, JSON.parse(message));
      mockValkey.published.push({ channel, message });
      return 1;
    }
    async quit() { return 'OK'; }
    disconnect() { /* nothing open */ }
  }
  return { __esModule: true, default: FakeValkey, Redis: FakeValkey };
});

const { POST } = cds.test(path.resolve(__dirname, '../../..'));
import { MINIMAL_DEFAULT_CONFIG } from '../../../src/srv/minimal-default-config';
import { LOGGING_SETTINGS_ENTITY, loadLoggingSettings } from '../../../src/services/loggingSettings';

const ADMIN = { auth: { username: 'hab-admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';
const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
const CONFIG_CHANGE_CHANNEL = 'sap-llm-gateway:config-changed';
let configService: any;

const handOvers = () => mockValkey.published.filter((m) => m.channel === CONFIG_CHANGE_CHANNEL)
  .map((m) => JSON.parse(m.message)).filter((e) => e.configData !== undefined);

function document(level: string) {
  return { ...MINIMAL_DEFAULT_CONFIG, api_config: { ...MINIMAL_DEFAULT_CONFIG.api_config,
    platform: { ...(MINIMAL_DEFAULT_CONFIG.api_config as any).platform, logging: { defaultLevel: level } } } };
}
async function create(name: string): Promise<string> {
  const created = await POST(`${S}/createConfiguration`, { name, configData: JSON.stringify(document('INFO')), description: 'test' }, ADMIN);
  expect(created.data.success).toBe(true);
  return created.data.configId;
}
const activeName = async () => (await cds.db.run(cds.ql.SELECT.one.from(CONFIGS).columns('name').where({ isActive: true })))?.name;

/** The name of the active configuration, read in a root transaction of its own; 'blocked' when that waits for more than a second. */
async function activeNameInOwnTransaction(): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const read = cds.tx(async (tx: any) => (await tx.run(cds.ql.SELECT.one.from(CONFIGS).columns('name').where({ isActive: true })))?.name);
  const blocked = new Promise<string>((r) => { timer = setTimeout(() => r('blocked'), 1000); });
  try { return await Promise.race([read, blocked]); } finally { clearTimeout(timer); }
}
function seenAtPublish(eventType: string): string[] {
  const seen: string[] = [];
  mockValkey.onPublish = async (channel, event) => {
    if (channel === CONFIG_CHANGE_CHANNEL && event.eventType === eventType) seen.push(await activeNameInOwnTransaction());
  };
  return seen;
}

interface Part { method: string; url: string; body?: unknown }

/**
 * A multipart/mixed $batch body as the UI5 V4 model (1.136, lib/_Batch.js _serializeBatchRequest)
 * writes it: a single change of a group goes unwrapped (_Requestor.isChangeSetOptional is true for
 * V4), several changes go into one change set whose parts carry Content-ID "<i>.<changeset>". An
 * array in `parts` is a change set (an atomicity group).
 */
function batchBody(parts: Array<Part | Part[]>): { body: string; contentType: string } {
  const batch = 'batch_id-1731400000000-1';
  const request = (p: Part, contentId?: string) => [
    'Content-Type:application/http\r\n', 'Content-Transfer-Encoding:binary\r\n',
    contentId ? `Content-ID:${contentId}\r\n` : '', '\r\n',
    `${p.method} ${p.url} HTTP/1.1\r\n`,
    'Accept:application/json;odata.metadata=minimal;IEEE754Compatible=true\r\n',
    'Content-Type:application/json;charset=UTF-8;IEEE754Compatible=true\r\n', '\r\n',
    p.body === undefined ? '' : JSON.stringify(p.body), '\r\n'
  ].join('');
  const out: string[] = [];
  parts.forEach((part, index) => {
    out.push(`--${batch}\r\n`);
    if (!Array.isArray(part)) { out.push(request(part)); return; }
    const changeset = `changeset_id-1731400000000-${index}`;
    out.push(`Content-Type: multipart/mixed;boundary=${changeset}\r\n\r\n`);
    part.forEach((p, i) => out.push(`--${changeset}\r\n`, request(p, `${i}.${index}`)));
    out.push(`--${changeset}--\r\n`);
  });
  out.push(`--${batch}--\r\n`);
  return { body: out.join(''), contentType: `multipart/mixed; boundary=${batch}` };
}
async function sendBatch(parts: Array<Part | Part[]>): Promise<{ status: number; text: string }> {
  const { body, contentType } = batchBody(parts);
  const r = await POST(`${S}/$batch`, body, { ...ADMIN, headers: { 'Content-Type': contentType, Accept: 'multipart/mixed', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0' },
    transformResponse: (raw: string) => raw, validateStatus: () => true });
  return { status: r.status, text: String(r.data) };
}
const activation = (configId: string): Part => ({ method: 'POST', url: 'activateConfiguration', body: { configId } });

beforeAll(async () => {
  configService = require('../../../src/srv/config-service')({ on() {}, before() {}, after() {} });
  process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
  try { await configService.initializeValkey(); } finally { delete process.env.VALKEY_URL; }
  expect(configService.isValkeyAvailable).toBe(true);
  expect((await POST(`${S}/activateConfiguration`, { configId: await create('batch-start') }, ADMIN)).data.success).toBe(true);
  await configService.publishStartupEvent(); // not left to its timer, which would land in a test
});

beforeEach(async () => {
  mockValkey.published.length = 0;
  mockValkey.onPublish = null;
  await cds.db.run(cds.ql.DELETE.from(LOGGING_SETTINGS_ENTITY));
  await loadLoggingSettings();
});

describe('the cockpit\'s $batch', () => {
  it('an activation as the cockpit sends it: a separate root transaction sees the new version when the one hand-over is published', async () => {
    const id = await create('batch-activation');
    const seen = seenAtPublish('config-activated');
    const r = await sendBatch([activation(id)]);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/HTTP\/1\.1 200/);
    expect(r.text).toMatch(/"success":true/);
    expect(seen).toEqual(['batch-activation']);
    expect(handOvers().map((e) => [e.eventType, e.configName])).toEqual([['config-activated', 'batch-activation']]);
  });

  it('an activation inside a change set: the same', async () => {
    const id = await create('batch-changeset-activation');
    const seen = seenAtPublish('config-activated');
    const r = await sendBatch([[activation(id)]]);
    expect(r.text).toMatch(/HTTP\/1\.1 200/);
    expect(r.text).toMatch(/"success":true/);
    expect(seen).toEqual(['batch-changeset-activation']);
    expect(handOvers().map((e) => e.configName)).toEqual(['batch-changeset-activation']);
  });

  it('a rollback as the cockpit sends it: a separate root transaction sees the previous version when the one hand-over is published', async () => {
    await POST(`${S}/activateConfiguration`, { configId: await create('batch-rollback-first') }, ADMIN);
    await POST(`${S}/activateConfiguration`, { configId: await create('batch-rollback-second') }, ADMIN);
    mockValkey.published.length = 0;
    const seen = seenAtPublish('config-rollback');
    const r = await sendBatch([{ method: 'POST', url: 'rollbackConfiguration', body: { reason: 'test' } }]);
    expect(r.text).toMatch(/HTTP\/1\.1 200/);
    expect(r.text).toMatch(/"success":true/);
    expect(r.text).toMatch(/"rolledBackTo"/);
    expect(seen).toEqual(['batch-rollback-first']);
    expect(handOvers().map((e) => [e.eventType, e.configName])).toEqual([['config-rollback', 'batch-rollback-first']]);
  });

  it('a change set refused after the activation did its work is rolled back: nothing is published, the old version stays active', async () => {
    const before = await activeName();
    const id = await create('batch-rolled-back');
    // The second operation of the atomicity group is refused (an OData CREATE of ApiConfigurations is always 400).
    const r = await sendBatch([[activation(id), { method: 'POST', url: 'ApiConfigurations', body: { name: 'refused' } }]]);
    expect(r.text).toMatch(/HTTP\/1\.1 400/);
    expect(await activeName()).toBe(before);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(handOvers()).toEqual([]);
  });

  it('two atomicity groups that each hand over: two hand-overs, in order, the last with the new version and the new settings', async () => {
    const id = await create('batch-two-groups');
    const r = await sendBatch([[activation(id)], [{ method: 'POST', url: 'setLoggingSettings', body: { defaultLevel: 'TRACE' } }]]);
    expect(r.text.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
    const events = handOvers();
    expect(events.map((e) => e.eventType)).toEqual(['config-activated', 'logging-settings-changed']);
    const last = events.at(-1);
    expect(last.configName).toBe('batch-two-groups');
    expect(last.configData.api_config.platform.logging.defaultLevel).toBe('TRACE');
  });
});
