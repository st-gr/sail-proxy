/**
 * One info line says where pseudonymization is enforced, written whenever a loaded configuration
 * changes that and not otherwise. A logging-only event takes the light path and writes nothing.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export {};

const CHANNEL = 'sap-llm-gateway:config-changed';
const info = jest.fn();
let configService: any;
let tmpDir: string | undefined;

const mk = (enabled: boolean): any => ({
  api_config: {
    observability: { pseudonymization: { enabled } },
    hooks: { defaults: { openai: { pseudonymization: { enabled: true } } } },
    platform: { logging: { defaultLevel: 'INFO', components: {} } },
  },
});
const ON = mk(true);
const OFF = mk(false);
const withLevel = (cfg: any, level: string): any => {
  const copy = structuredClone(cfg);
  copy.api_config.platform.logging.defaultLevel = level;
  return copy;
};
const ON_LINE = 'Pseudonymization is enforced for endpoints openai.';
const OFF_LINE = 'Pseudonymization is switched off (observability.pseudonymization.enabled is not true). Overruled: endpoints openai.';

const event = (eventType: string, configData: any) => ({ eventType, configId: 'c1', configName: 'n', version: '1', checksum: 'x', configData });
const activated = (cfg: any) => event('config-activated', cfg);
const logging = (cfg: any) => event('logging-settings-changed', cfg);
const send = (e: unknown): Promise<void> => configService.handleValkeyEvent(CHANNEL, JSON.stringify(e));
const lines = (): string[] => info.mock.calls.filter((c) => c[0] === 'pseudonymization').map((c) => c[1] as string);

const load = (): void => {
  jest.resetModules();
  info.mockClear();
  const quiet = { info, warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), reinitialize: jest.fn(), applyLoggingConfig: jest.fn() };
  jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quiet }));
  jest.doMock('../src/services/modelService', () => ({
    __esModule: true,
    default: { clearAllCaches: jest.fn(), getModels: jest.fn(async () => ({ object: 'list', data: [] })) },
  }));
  jest.doMock('../src/clients/adminServiceClient', () => ({ adminServiceClient: null }));
  jest.dontMock('../src/services/configService');
  configService = require('../src/services/configService');
};

beforeEach(load);
afterEach(() => {
  delete process.env.CONFIG_FILE_PATH;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('the pseudonymization status line', () => {
  it('an activation writes the line once', async () => {
    await send(activated(ON));
    expect(lines()).toEqual([ON_LINE]);
  });

  it('repeatPseudonymizationState writes the current line once more (for the log shipper that starts later)', async () => {
    await send(activated(ON));
    configService.repeatPseudonymizationState();
    expect(lines()).toEqual([ON_LINE, ON_LINE]);
  });

  it('repeatPseudonymizationState writes nothing before a configuration is loaded', () => {
    configService.repeatPseudonymizationState();
    expect(lines()).toEqual([]);
  });

  it('the same state again writes nothing', async () => {
    await send(activated(ON));
    await send(activated({ ...ON, api_config: { ...ON.api_config, providers: { p: 2 } } }));
    expect(lines()).toHaveLength(1);
  });

  it('a switch change writes the new line once', async () => {
    await send(activated(ON));
    await send(activated(OFF));
    expect(lines()[1]).toBe(OFF_LINE);
    expect(lines()).toHaveLength(2);
  });

  it('a logging-only event writes nothing', async () => {
    await send(activated(ON));
    await send(logging(withLevel(ON, 'DEBUG')));
    expect(lines()).toHaveLength(1);
  });

  it('updateConfig (the standalone config routes) writes the line for a changed switch', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudo-line-'));
    process.env.CONFIG_FILE_PATH = path.join(tmpDir, 'api_config.json');
    load();
    await send(activated(ON));
    await configService.updateConfig(OFF);
    expect(lines()).toHaveLength(2);
  });

  it('a configuration loaded from the file writes the line', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudo-line-'));
    const file = path.join(tmpDir, 'api_config.json');
    fs.writeFileSync(file, JSON.stringify(OFF));
    process.env.CONFIG_FILE_PATH = file;
    load();
    configService.getConfig();
    expect(lines()).toEqual([OFF_LINE]);
  });
});
