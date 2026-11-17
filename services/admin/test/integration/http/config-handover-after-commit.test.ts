/**
 * The configuration is handed to the gateway only after the request that changed it has committed
 * (activation, rollback, an update of the active configuration), never after a rollback, and every
 * hand-over goes through one queue, so the last event the gateway gets carries the newest committed
 * configuration. cds.test on in-memory SQLite (one connection: a read in a separate root transaction
 * waits while a request's transaction is open). The publisher is a fake iovalkey; a test can look at
 * the database at the moment of a publish, delay it, make it fail or hang.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'hac-admin@test.com': { id: 'hac-admin@test.com', roles: ['admin', 'user'] } } };

type Hook = (channel: string, event: any) => Promise<void>;
const mockValkey = {
  published: [] as { channel: string; message: string }[],
  mode: 'ok' as 'ok' | 'fail' | 'fail-once' | 'hang-once',
  onPublish: null as Hook | null
};
jest.mock('iovalkey', () => {
  class FakeValkey {
    async ping() { return 'PONG'; }
    async get() { return null; }
    async subscribe() { return 0; }
    on() { return this; }
    async publish(channel: string, message: string) {
      if (mockValkey.mode === 'fail') throw new Error('Connection is closed.');
      if (mockValkey.mode === 'fail-once') { mockValkey.mode = 'ok'; throw new Error('Connection is closed.'); }
      if (mockValkey.mode === 'hang-once') { mockValkey.mode = 'ok'; return new Promise(() => undefined); }
      if (mockValkey.onPublish) await mockValkey.onPublish(channel, JSON.parse(message));
      mockValkey.published.push({ channel, message });
      return 1;
    }
    async quit() { return 'OK'; }
    disconnect() { /* nothing open */ }
  }
  return { __esModule: true, default: FakeValkey, Redis: FakeValkey };
});

const mockOrder: string[] = [];
jest.mock('../../../src/services/userQuotaService', () => ({
  ...jest.requireActual('../../../src/services/userQuotaService'),
  republishAll: jest.fn(async () => { mockOrder.push('republishAll'); return 0; })
}));
jest.mock('../../../src/services/credentialInvalidation', () => ({
  ...jest.requireActual('../../../src/services/credentialInvalidation'),
  invalidateForEmails: jest.fn(async () => { mockOrder.push('invalidateForEmails'); return true; })
}));

const { GET, POST, PATCH } = cds.test(path.resolve(__dirname, '../../..'));
import { MINIMAL_DEFAULT_CONFIG } from '../../../src/srv/minimal-default-config';
import { LOGGING_SETTINGS_ENTITY, loadLoggingSettings } from '../../../src/services/loggingSettings';
import { republishAll } from '../../../src/services/userQuotaService';

const ADMIN = { auth: { username: 'hac-admin@test.com', password: 'x' } };
const S = '/odata/v4/admin';
const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
const CONFIG_CHANGE_CHANNEL = 'sap-llm-gateway:config-changed';
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let configService: any;

/** Test switches read by the handlers registered below. */
const during = { rejectAfterActivation: false, activateOnUpdate: null as string | null };

const configEvents = () => mockValkey.published.filter((m) => m.channel === CONFIG_CHANGE_CHANNEL).map((m) => JSON.parse(m.message));
/** The events that carry a configuration (an update's 'config-changed' is also sent bare to the same channel; the gateway then fetches). */
const handOvers = () => configEvents().filter((e) => e.configData !== undefined);
const answerFields = (data: any) => Object.keys(data).filter((k) => !k.startsWith('@')).sort();

function document(level: string) {
  return { ...MINIMAL_DEFAULT_CONFIG, api_config: { ...MINIMAL_DEFAULT_CONFIG.api_config,
    platform: { ...(MINIMAL_DEFAULT_CONFIG.api_config as any).platform, logging: { defaultLevel: level } } } };
}
async function create(name: string, level = 'INFO'): Promise<string> {
  const created = await POST(`${S}/createConfiguration`, { name, configData: JSON.stringify(document(level)), description: 'test' }, ADMIN);
  expect(created.data.success).toBe(true);
  return created.data.configId;
}
const activate = (configId: string) => ok(POST(`${S}/activateConfiguration`, { configId }, ADMIN));
const setLevel = (defaultLevel: string) => ok(POST(`${S}/setLoggingSettings`, { defaultLevel }, ADMIN));

/** The name of the active configuration, read in a root transaction of its own; 'blocked' when that waits for more than a second. */
async function activeNameInOwnTransaction(): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const read = cds.tx(async (tx: any) => (await tx.run(cds.ql.SELECT.one.from(CONFIGS).columns('name').where({ isActive: true })))?.name);
  const blocked = new Promise<string>((r) => { timer = setTimeout(() => r('blocked'), 1000); });
  try { return await Promise.race([read, blocked]); } finally { clearTimeout(timer); }
}
const activeName = async () => (await cds.db.run(cds.ql.SELECT.one.from(CONFIGS).columns('name').where({ isActive: true })))?.name;

beforeAll(async () => {
  const srv = cds.services.AdminService;
  srv.after('activateConfiguration', (_result: any, req: any) => {
    mockOrder.push('after handler');
    if (during.rejectAfterActivation) req.reject(500, 'test: the activation is rolled back');
  });
  // Makes the updated row the active one inside the UPDATE's own transaction, after the
  // configuration service's before handler accepted it as inactive: the one way to reach the
  // publish after an update of the active configuration (a concurrent activation, in production).
  srv.prepend(() => srv.on('UPDATE', 'ApiConfigurations', async (req: any, next: () => Promise<any>) => {
    const result = await next();
    if (during.activateOnUpdate) {
      await cds.run(cds.ql.UPDATE(CONFIGS).set({ isActive: false }).where({ isActive: true }));
      await cds.run(cds.ql.UPDATE(CONFIGS).set({ isActive: true }).where({ ID: during.activateOnUpdate }));
    }
    return result;
  }));
  expect((await activate(await create('start'))).data.success).toBe(true);
  configService = require('../../../src/srv/config-service')({ on() {}, before() {}, after() {} });
  process.env.VALKEY_URL = 'redis://valkey.example.org:6379';
  try { await configService.initializeValkey(); } finally { delete process.env.VALKEY_URL; }
  expect(configService.isValkeyAvailable).toBe(true);
  // The admin's start-up event, published now: the one its start-up timer sends would otherwise
  // land in the middle of a test.
  await configService.publishStartupEvent();
});

beforeEach(async () => {
  mockValkey.published.length = 0;
  mockValkey.mode = 'ok';
  mockValkey.onPublish = null;
  mockOrder.length = 0;
  during.rejectAfterActivation = false;
  during.activateOnUpdate = null;
  (republishAll as jest.Mock).mockClear();
  await cds.db.run(cds.ql.DELETE.from(LOGGING_SETTINGS_ENTITY));
  await loadLoggingSettings();
});

/** Records what a separate root transaction sees as active while events of `eventType` are published. */
function seenAtPublish(eventType: string): string[] {
  const seen: string[] = [];
  mockValkey.onPublish = async (channel, event) => {
    if (channel === CONFIG_CHANGE_CHANNEL && event.eventType === eventType) seen.push(await activeNameInOwnTransaction());
  };
  return seen;
}

describe('the hand-over happens after the commit', () => {
  it('activation: a separate root transaction sees the new version as active when the event is published', async () => {
    const seen = seenAtPublish('config-activated');
    expect((await activate(await create('commit-activation'))).data.success).toBe(true);
    expect(seen).toEqual(['commit-activation']);
    expect(configEvents().at(-1)).toMatchObject({ eventType: 'config-activated', configName: 'commit-activation' });
  });

  it('rollback: a separate root transaction sees the previous version as active when the event is published', async () => {
    await activate(await create('rollback-first'));
    await activate(await create('rollback-second'));
    const seen = seenAtPublish('config-rollback');
    const r = await ok(POST(`${S}/rollbackConfiguration`, { reason: 'test' }, ADMIN));
    expect(r.data).toMatchObject({ success: true, rolledBackFrom: expect.any(String), rolledBackTo: expect.any(String) });
    expect(seen).toEqual(['rollback-first']);
    expect(configEvents().at(-1)).toMatchObject({ eventType: 'config-rollback', configName: 'rollback-first' });
  });

  it('update of the active configuration: a separate root transaction sees it active when the event is published', async () => {
    const id = await create('commit-update');
    const row = await GET(`${S}/ApiConfigurations(ID=${id})`, ADMIN);
    during.activateOnUpdate = id;
    const seen = seenAtPublish('config-changed');
    const r = await ok(PATCH(`${S}/ApiConfigurations(ID=${id})`, { configData: JSON.stringify(document('WARN')) },
      { ...ADMIN, headers: { 'If-Match': row.data['@odata.etag'] } }));
    expect(r.status).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(['commit-update']);
    expect(handOvers().at(-1)).toMatchObject({ eventType: 'config-changed', configName: 'commit-update' });
    expect(handOvers().at(-1).configData.api_config.platform.logging.defaultLevel).toBe('WARN');
  });

  it('an activation whose transaction is rolled back publishes nothing and runs no follow-up', async () => {
    const before = await activeName();
    during.rejectAfterActivation = true;
    const r = await activate(await create('rolled-back'));
    expect(r.status).toBe(500);
    expect(await activeName()).toBe(before);
    expect(configEvents()).toEqual([]);
    expect(republishAll).not.toHaveBeenCalled();
    expect(mockOrder).toEqual(['after handler']);
  });

  it('the follow-ups (quota republish, cache invalidation) run after the request\'s handlers, once it committed', async () => {
    expect((await activate(await create('follow-ups'))).data.success).toBe(true);
    expect(mockOrder[0]).toBe('after handler');
    expect(mockOrder).toEqual(expect.arrayContaining(['republishAll', 'invalidateForEmails']));
  });
});

describe('the last event carries the newest version and the newest logging settings', () => {
  it('when the logging settings change first and an activation follows while their event is published', async () => {
    const id = await create('order-settings-first');
    let activation: Promise<any> | undefined;
    mockValkey.onPublish = async (channel, event) => {
      if (channel !== CONFIG_CHANGE_CHANNEL || event.eventType !== 'logging-settings-changed' || activation) return;
      activation = activate(id);
      await sleep(300);
    };
    expect((await setLevel('TRACE')).status).toBe(200);
    expect((await activation)!.data.success).toBe(true);
    const last = handOvers().at(-1);
    expect(last.configName).toBe('order-settings-first');
    expect(last.configData.api_config.platform.logging.defaultLevel).toBe('TRACE');
  });

  it('when an activation comes first and the logging settings change while its event is published', async () => {
    const id = await create('order-activation-first');
    let settings: Promise<any> | undefined;
    mockValkey.onPublish = async (channel, event) => {
      if (channel !== CONFIG_CHANGE_CHANNEL || event.eventType !== 'config-activated' || settings) return;
      settings = setLevel('DEBUG');
      await sleep(300);
    };
    expect((await activate(id)).data.success).toBe(true);
    expect((await settings)!.status).toBe(200);
    const last = handOvers().at(-1);
    expect(last.configName).toBe('order-activation-first');
    expect(last.configData.api_config.platform.logging.defaultLevel).toBe('DEBUG');
  });
});

describe('one hand-over failing does not stop the next', () => {
  it('a publish that hangs until its timeout: the activation is answered, and the next hand-over is published afterwards', async () => {
    mockValkey.mode = 'hang-once';
    expect((await activate(await create('hangs'))).data.success).toBe(true);
    expect((await activate(await create('after-hang'))).data.success).toBe(true);
    expect(configEvents().at(-1)).toMatchObject({ eventType: 'config-activated', configName: 'after-hang' });
  }, 15000);

  it('a hand-over given up while it still reads does not publish what it read afterwards', async () => {
    const read = configService.readConfigurationForGateway.bind(configService);
    const slow = jest.spyOn(configService, 'readConfigurationForGateway').mockImplementationOnce(async () => {
      const old = await read();
      await sleep(3500);
      return old;
    });
    try {
      expect((await activate(await create('slow-read'))).data.success).toBe(true);
      expect((await activate(await create('after-slow-read'))).data.success).toBe(true);
      await sleep(800); // the slow read has finished by now
      expect(handOvers().map((e) => e.configName)).toEqual(['after-slow-read']);
    } finally {
      slow.mockRestore();
    }
  }, 15000);

  it('a publish that rejects does not fail the next', async () => {
    mockValkey.mode = 'fail-once';
    expect((await activate(await create('rejects'))).data.success).toBe(true);
    expect((await activate(await create('after-reject'))).data.success).toBe(true);
    expect(configEvents().at(-1)).toMatchObject({ eventType: 'config-activated', configName: 'after-reject' });
  });
});

describe('the logging settings\' answer', () => {
  it('reports no failed delivery when its hand-over waits behind a slow one and is then published in time', async () => {
    const id = await create('slow-ahead');
    let settings: Promise<any> | undefined;
    mockValkey.onPublish = async (channel, event) => {
      if (channel !== CONFIG_CHANGE_CHANNEL) return;
      if (event.eventType === 'config-activated' && !settings) {
        settings = setLevel('TRACE'); // queued behind this hand-over, which takes 2.5 s
        await sleep(2500);
      } else if (event.eventType === 'logging-settings-changed') {
        await sleep(1000); // its own publish takes 1 s: done 3.5 s after it was queued
      }
    };
    expect((await activate(id)).data.success).toBe(true);
    const answer = await settings!;
    expect(answer.status).toBe(200);
    expect(answer.data.warning).toBeNull();
    expect(handOvers().at(-1).configData.api_config.platform.logging.defaultLevel).toBe('TRACE');
  }, 15000);
});

describe('without a CAP request', () => {
  it('an activation called with a plain object hands over at once', async () => {
    const id = await create('plain-call');
    const result = await configService.activateConfiguration({ data: { configId: id }, user: { id: 'system' } });
    expect(result.success).toBe(true);
    expect(configEvents().at(-1)).toMatchObject({ eventType: 'config-activated', configName: 'plain-call' });
  });
});

describe('what the caller is told', () => {
  it('is the same for activation, rollback and update, also when every publish fails', async () => {
    const good = await activate(await create('answer-ok'));
    expect(answerFields(good.data)).toEqual(['activatedAt', 'checksum', 'success', 'version']);

    mockValkey.mode = 'fail';
    mockValkey.published.length = 0;
    const activated = await activate(await create('answer-failing'));
    expect(activated.status).toBe(200);
    expect(activated.data.success).toBe(true);
    expect(answerFields(activated.data)).toEqual(answerFields(good.data));

    const rolledBack = await ok(POST(`${S}/rollbackConfiguration`, { reason: 'test' }, ADMIN));
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.data.success).toBe(true);
    expect(answerFields(rolledBack.data)).toEqual(['reason', 'rolledBackAt', 'rolledBackFrom', 'rolledBackTo', 'success']);

    const id = await create('answer-update');
    const row = await GET(`${S}/ApiConfigurations(ID=${id})`, ADMIN);
    during.activateOnUpdate = id;
    const updated = await ok(PATCH(`${S}/ApiConfigurations(ID=${id})`, { configData: JSON.stringify(document('ERROR')) },
      { ...ADMIN, headers: { 'If-Match': row.data['@odata.etag'] } }));
    expect(updated.status).toBe(200);
    expect(updated.data).toMatchObject({ ID: id, name: 'answer-update' });
    expect(configEvents()).toEqual([]);
  });
});
