/**
 * Boot with a stalled SAP list. On a Valkey install the gateway waits for its configuration
 * event, then publishes the model list for the admin's Model Library, which reads the token and
 * the foundation-model list from SAP. A stalled list must neither hold up the configuration
 * (startup continues) nor leave that startup publish hanging: it fails within the list bound and
 * the next configuration event tries again. Valkey is an in-memory fake; SAP is a local server
 * that stalls (test/fakeSapServer.ts).
 */
import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { EventEmitter } from 'events';
import { startFakeSapServer, FakeSapServer } from './fakeSapServer';

const ATTEMPT_MS = 250;
const CONFIG_CHANNEL = 'sap-llm-gateway:config-changed';
const STARTUP_CHANNEL = 'sap-llm-gateway:service-ready';

class FakeValkey extends EventEmitter {
  static instances: FakeValkey[] = [];
  subscribed: string[] = [];
  published: string[] = [];
  constructor() {
    super();
    FakeValkey.instances.push(this);
  }
  async subscribe(channel: string) { this.subscribed.push(channel); return 1; }
  async publish(channel: string) { this.published.push(channel); return 0; }
  async set() { return 'OK'; }
  async quit() { return 'OK'; }
  disconnect() { /* nothing to close */ }
}

let server: FakeSapServer;
const savedEnv = { ...process.env };

beforeAll(async () => {
  server = await startFakeSapServer([{ kind: 'json', body: { access_token: 'tok', expires_in: 3600 } }, { kind: 'stall' }]);
});

afterAll(async () => {
  process.env = savedEnv;
  await server.close();
});

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 20); });
  }
  return condition();
}

describe('boot with a stalled SAP list', () => {
  it('receives its configuration and finishes the startup model-list publish within the list bound', async () => {
    jest.resetModules();
    Object.assign(process.env, {
      GATEWAY_STANDALONE: 'false',
      UNIFIED_TOKEN_SYSTEM_ENABLED: 'true',
      VALKEY_URL: 'redis://127.0.0.1:1',
      ADMIN_SERVICE_URL: 'http://127.0.0.1:1',
      SAP_AI_CORE_URL: server.url,
      AUTH_URL: `${server.url}/oauth/token`,
      CLIENT_ID: 'id',
      CLIENT_SECRET: 'secret',
    });
    delete process.env.CONFIG_CHANGE_CHANNEL;
    jest.doMock('iovalkey', () => FakeValkey);

    /* eslint-disable @typescript-eslint/no-var-requires */
    require('../src/utils/sapRequest').__setSapTimingForTests({
      listAttemptMs: ATTEMPT_MS, tokenAttemptMs: ATTEMPT_MS, retryJitterMinMs: 5, retryJitterMaxMs: 10,
    });
    const { getDefaultLogger } = require('@libs/logger');
    const configService = require('../src/services/configService');
    /* eslint-enable @typescript-eslint/no-var-requires */
    const errors: string[] = [];
    jest.spyOn(getDefaultLogger(), 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
      return undefined as any;
    });

    const ready = configService.getConfigAsync();
    // The gateway asks the admin for its configuration once it listens for the answer.
    expect(await until(() => FakeValkey.instances.some((v) => v.published.includes(STARTUP_CHANNEL)), 2_000)).toBe(true);
    const subscriber = FakeValkey.instances.find((v) => v.subscribed.includes(CONFIG_CHANNEL))!;
    const startedAt = Date.now();
    subscriber.emit('message', CONFIG_CHANNEL, JSON.stringify({
      eventType: 'config-updated', configId: 'c1', configName: 'test', version: 1,
      configData: { api_config: {} },
    }));

    await expect(ready).resolves.toEqual({ api_config: {} });
    // Unbounded before: the publish waited on the stalled list forever. The bound is loose because
    // the event handler also reloads the plugin modules first, which is slow on a loaded machine.
    const published = await until(
      () => errors.some((e) => e.includes('Failed to publish model list after config update')), 15_000);

    expect(published).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(server.requests.map((r) => r.url)).toEqual([
      '/oauth/token', '/v2/lm/scenarios/foundation-models/models', '/v2/lm/scenarios/foundation-models/models',
    ]);

    await configService.closeValkeyConnections();
  });
});
