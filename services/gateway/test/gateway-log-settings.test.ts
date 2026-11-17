import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { gatewayLogSettings } from '../src/services/configService';

const DEFAULTS = { enabled: true, retentionHours: 48, maxEntries: 2000000, minLevel: 'INFO' };
const withBlock = (gateway_log: any) => ({ api_config: { observability: { gateway_log } } });

describe('gatewayLogSettings', () => {
  it('gives the defaults for a configuration without the block', () => {
    expect(gatewayLogSettings({})).toEqual(DEFAULTS);
    expect(gatewayLogSettings(undefined)).toEqual(DEFAULTS);
    expect(gatewayLogSettings({ api_config: { observability: {} } })).toEqual(DEFAULTS);
  });

  it('stores the log for a configuration without the block, and keeps a block that says enabled: false off', () => {
    expect(gatewayLogSettings({}).enabled).toBe(true);
    expect(gatewayLogSettings(withBlock({ retention_hours: 12 })).enabled).toBe(true);
    expect(gatewayLogSettings(withBlock({ enabled: false })).enabled).toBe(false);
  });

  it('reads the block', () => {
    expect(gatewayLogSettings(withBlock({ enabled: true, retention_hours: 12, max_entries: 500, min_level: 'warn' })))
      .toEqual({ enabled: true, retentionHours: 12, maxEntries: 500, minLevel: 'WARN' });
  });

  it('keeps 0 as 0', () => {
    expect(gatewayLogSettings(withBlock({ retention_hours: 0, max_entries: 0 }))).toMatchObject({ retentionHours: 0, maxEntries: 0 });
  });

  it('gives the default for a value of the wrong type', () => {
    expect(gatewayLogSettings(withBlock({ enabled: 'yes', retention_hours: '12', max_entries: null, min_level: 3 }))).toEqual(DEFAULTS);
    expect(gatewayLogSettings(withBlock('on'))).toEqual(DEFAULTS);
  });

  it('upper-cases min_level and gives INFO for an unknown name', () => {
    expect(gatewayLogSettings(withBlock({ min_level: 'debug' })).minLevel).toBe('DEBUG');
    expect(gatewayLogSettings(withBlock({ min_level: 'LOUD' })).minLevel).toBe('INFO');
  });
});

describe('gatewayLogSettings on the shipped configuration', () => {
  it('reads the block of the shipped api_config.json: stored log on, 48 hours, 2,000,000 entries, INFO', () => {
    const shipped = JSON.parse(readFileSync(join(__dirname, '..', 'api_config.json'), 'utf8'));
    expect(shipped.api_config.observability.gateway_log).toEqual({ enabled: true, retention_hours: 48, max_entries: 2000000, min_level: 'INFO' });
    expect(gatewayLogSettings(shipped)).toEqual(DEFAULTS);
  });
});

describe("the log shipper's settings while no configuration has arrived", () => {
  const ENV = ['VALKEY_URL', 'ADMIN_SERVICE_URL', 'UNIFIED_TOKEN_SYSTEM_ENABLED', 'GATEWAY_STANDALONE'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; });
  afterEach(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    jest.restoreAllMocks();
  });

  it('are "not enabled yet", read without logging and without throwing (getConfig would do both, every second)', () => {
    // A gateway of Docker or Kyma that waits for the admin service's first configuration.
    Object.assign(process.env, { VALKEY_URL: 'redis://127.0.0.1:1', ADMIN_SERVICE_URL: 'http://admin.example.org', UNIFIED_TOKEN_SYSTEM_ENABLED: 'true' });
    delete process.env.GATEWAY_STANDALONE;
    let config!: typeof import('../src/services/configService');
    jest.isolateModules(() => { config = require('../src/services/configService'); });
    const consoleCalls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(config.getCachedConfig()).toBeUndefined();
    for (let i = 0; i < 3; i++) expect(config.logShipperSettings()).toEqual({ enabled: false, minLevel: 'INFO' });
    for (const spy of [...consoleCalls, stderr, stdout]) expect(spy).not.toHaveBeenCalled();
  });
});

describe('the admin service reads the same block the same way', () => {
  // The gateway decides what it ships from this block, the admin how long it keeps the entries
  // and what the Logs page shows as the configuration's value. Each service has its own reader
  // (review finding 2026-11-12: copied by hand); this pins the two to each other, so a default
  // changed in one file fails here until the other follows.
  const fs = require('fs');
  const path = require('path');
  const read = (relative: string): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', relative), 'utf8');
  const reader = (source: string): string => {
    const start = source.indexOf('export function gatewayLogSettings(');
    const end = source.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end + 2);
  };
  const levelList = (source: string, name: string): string => (source.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`)) || [])[1];
  const gateway = read('services/gateway/src/services/configService.ts');
  const admin = read('services/admin/src/services/gatewayLogIngest.ts');

  it('with the same code', () => {
    expect(reader(admin).replace(/\bLEVELS\b/g, 'GATEWAY_LOG_LEVELS')).toBe(reader(gateway));
  });

  it('and the same list of levels', () => {
    expect(levelList(gateway, 'GATEWAY_LOG_LEVELS')).toBeDefined();
    expect(levelList(admin, 'LEVELS')).toBe(levelList(gateway, 'GATEWAY_LOG_LEVELS'));
  });
});
