/**
 * Saving a configuration (an OData PATCH of ApiConfigurations - the config app's Save) recomputes
 * what createConfiguration stores with the document: the checksum and the validation result. An
 * invalid document is refused (400), like create refuses it, and so is a change to the active
 * configuration's document. A PATCH without configData cannot set the derived columns either.
 *
 * The handler reads the stored row through cds.run, which is stubbed here; the OData round trip
 * is test/integration/http/config-save-recompute-odata.test.ts.
 */
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MINIMAL_DEFAULT_CONFIG } from '../../../src/srv/minimal-default-config';

const cds = require('@sap/cds');
const configurationServiceFactory = require('../../../src/srv/config-service');

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

function withStreamingTimeout(streaming: number) {
  const config = JSON.parse(JSON.stringify(MINIMAL_DEFAULT_CONFIG));
  config.api_config.platform.timeouts.streaming = streaming;
  return config;
}

class Rejected extends Error {
  constructor(public status: number, public key: string, public args?: unknown[]) {
    super(key);
  }
}

function request(data: Record<string, unknown>) {
  return {
    data,
    params: [{ ID: data.ID }],
    reject: jest.fn((status: number, key: string, args?: unknown[]) => {
      throw new Rejected(status, key, args);
    })
  };
}

describe('saving a configuration recomputes its checksum and validation', () => {
  let service: { before: jest.Mock; on: jest.Mock; after: jest.Mock };
  let beforeUpdate: (req: any) => Promise<void>;
  let storedRow: Record<string, unknown> | undefined;
  let runSpy: jest.SpyInstance;

  beforeEach(() => {
    service = { before: jest.fn(), on: jest.fn(), after: jest.fn() };
    configurationServiceFactory(service);
    const registration = service.before.mock.calls.find(([event, entity]) => event === 'UPDATE' && entity === 'ApiConfigurations');
    expect(registration).toBeDefined();
    beforeUpdate = registration![2];
    storedRow = { isActive: false, configData: JSON.stringify(withStreamingTimeout(10000)) };
    runSpy = jest.spyOn(cds, 'run').mockImplementation(async () => storedRow);
  });

  afterEach(() => {
    runSpy.mockRestore();
  });

  it('sets the checksum exactly as create computes it, whatever the formatting', async () => {
    const config = withStreamingTimeout(45000);
    const pretty = request({ ID: 'c1', configData: JSON.stringify(config, null, 2) });
    const minified = request({ ID: 'c1', configData: JSON.stringify(config) });
    await beforeUpdate(pretty);
    await beforeUpdate(minified);
    expect(pretty.data.checksum).toBe(sha256(JSON.stringify(config)));
    expect(minified.data.checksum).toBe(pretty.data.checksum);
  });

  it('stores the warning of a low streaming timeout and clears it once the timeout is raised', async () => {
    const low = request({ ID: 'c1', configData: JSON.stringify(withStreamingTimeout(10000)) });
    await beforeUpdate(low);
    expect(low.data).toMatchObject({
      isValid: true,
      validationErrors: null,
      validationWarnings: JSON.stringify(['Streaming timeout is very low (< 30 seconds)'])
    });
    expect(typeof low.data.lastValidated).toBe('string');

    const raised = request({ ID: 'c1', configData: JSON.stringify(withStreamingTimeout(45000)) });
    await beforeUpdate(raised);
    expect(raised.data).toMatchObject({ isValid: true, validationErrors: null, validationWarnings: null });
  });

  it('refuses an invalid document with 400, carrying its validation errors', async () => {
    const req = request({ ID: 'c1', configData: JSON.stringify({ wrong_property: {} }) });
    await expect(beforeUpdate(req)).rejects.toMatchObject({ status: 400, key: 'CONFIG_SAVE_INVALID' });
    const [, , args] = req.reject.mock.calls[0];
    expect(String(args?.[0])).toMatch(/api_config/);
    expect(req.data.checksum).toBeUndefined();
  });

  it('refuses a document that is not JSON with 400', async () => {
    const req = request({ ID: 'c1', configData: '{ not json' });
    await expect(beforeUpdate(req)).rejects.toMatchObject({ status: 400, key: 'CONFIG_SAVE_INVALID_JSON' });
  });

  it('refuses changing the active configuration\'s document with 400', async () => {
    storedRow = { isActive: true, configData: JSON.stringify(withStreamingTimeout(10000)) };
    const req = request({ ID: 'c1', configData: JSON.stringify(withStreamingTimeout(45000)) });
    await expect(beforeUpdate(req)).rejects.toMatchObject({ status: 400, key: 'CONFIG_SAVE_ACTIVE' });
  });

  it('lets the active configuration\'s unchanged document through, however it is formatted', async () => {
    storedRow = { isActive: true, configData: JSON.stringify(withStreamingTimeout(10000)) };
    const req = request({ ID: 'c1', configData: JSON.stringify(withStreamingTimeout(10000), null, 2) });
    await beforeUpdate(req);
    expect(req.reject).not.toHaveBeenCalled();
    expect(req.data.isValid).toBe(true);
  });

  it('reads the stored row within the request (cds.run, keyed by the PATCHed ID)', async () => {
    const req = request({ ID: 'c1', configData: JSON.stringify(withStreamingTimeout(45000)) });
    await beforeUpdate(req);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runSpy.mock.calls[0][0])).toContain('c1');
  });

  it('a PATCH without configData leaves the document alone and cannot set the derived columns', async () => {
    const req = request({ ID: 'c1', description: 'renamed', checksum: 'forged', isValid: true, validationErrors: null, validationWarnings: null, lastValidated: '2020-01-01T00:00:00Z' });
    await beforeUpdate(req);
    expect(req.data).toEqual({ ID: 'c1', description: 'renamed' });
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe('only activation changes which configuration is active', () => {
  let beforeUpdate: (req: any) => Promise<void>;
  let runSpy: jest.SpyInstance;

  beforeEach(() => {
    const service = { before: jest.fn(), on: jest.fn(), after: jest.fn() };
    configurationServiceFactory(service);
    beforeUpdate = service.before.mock.calls.find(([event, entity]) => event === 'UPDATE' && entity === 'ApiConfigurations')![2];
    runSpy = jest.spyOn(cds, 'run').mockImplementation(async () => ({ isActive: false, configData: '{}' }));
  });

  afterEach(() => {
    runSpy.mockRestore();
  });

  it.each([
    ['isActive', { isActive: true }],
    ['isActive', { isActive: false, description: 'x' }],
    ['deployedAt', { deployedAt: '2026-01-01T00:00:00Z' }],
    ['deployedBy', { deployedBy: 'someone' }],
    ['isActive with a document', { isActive: false, configData: JSON.stringify(withStreamingTimeout(45000)) }]
  ])('refuses %s with 400', async (_label, fields) => {
    const req = request({ ID: 'c1', ...fields });
    await expect(beforeUpdate(req)).rejects.toMatchObject({ status: 400, key: 'CONFIG_SAVE_ACTIVATION_COLUMNS' });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('refuses a document on an UPDATE without a resolvable key', async () => {
    const req = { ...request({ configData: JSON.stringify(withStreamingTimeout(45000)) }), params: [] };
    await expect(beforeUpdate(req)).rejects.toMatchObject({ status: 400, key: 'CONFIG_SAVE_NO_KEY' });
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe('the after-UPDATE publisher', () => {
  let instance: any;
  let beforeUpdate: (req: any) => Promise<void>;
  let afterUpdate: (results: any, req: any) => Promise<void>;
  let row: Record<string, unknown>;
  let runSpy: jest.SpyInstance;
  let publish: jest.SpyInstance;

  beforeEach(() => {
    const service = { before: jest.fn(), on: jest.fn(), after: jest.fn() };
    instance = configurationServiceFactory(service);
    beforeUpdate = service.before.mock.calls.find(([event, entity]) => event === 'UPDATE' && entity === 'ApiConfigurations')![2];
    afterUpdate = service.after.mock.calls.find(([event, entity]) => event === 'UPDATE' && entity === 'ApiConfigurations')![2];
    // The stored row as the before handler reads it (inactive: its document may change) and as the
    // after handler reads it back (active: a service-level update of the active configuration).
    row = { ID: 'c1', name: 'n', version: '1', checksum: 'k', isActive: false, configData: JSON.stringify(withStreamingTimeout(10000)) };
    runSpy = jest.spyOn(cds, 'run').mockImplementation(async () => row);
    publish = jest.spyOn(instance, 'publishConfigurationEvent').mockResolvedValue(undefined);
  });

  afterEach(() => {
    runSpy.mockRestore();
    publish.mockRestore();
    jest.useRealTimers();
  });

  async function saved(fields: Record<string, unknown>) {
    const req = request({ ID: 'c1', ...fields });
    await beforeUpdate(req);
    row = { ...row, isActive: true };
    return req;
  }

  it('publishes config-changed when the document of an active configuration changed', async () => {
    const req = await saved({ configData: JSON.stringify(withStreamingTimeout(45000)) });
    await afterUpdate({ ID: 'c1' }, req);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'config-changed', configId: 'c1' }));
  });

  it('publishes nothing when the document did not change', async () => {
    await afterUpdate({ ID: 'c1' }, await saved({ description: 'renamed' }));
    await afterUpdate({ ID: 'c1' }, await saved({ configData: JSON.stringify(withStreamingTimeout(10000), null, 2) }));
    expect(publish).not.toHaveBeenCalled();
  });

  it('gives a hanging publish up after 3 s instead of holding the request', async () => {
    const req = await saved({ configData: JSON.stringify(withStreamingTimeout(45000)) });
    publish.mockImplementation(() => new Promise(() => undefined));
    jest.useFakeTimers();
    let settled = false;
    const done = afterUpdate({ ID: 'c1' }, req).then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(2900);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    await done;
    expect(settled).toBe(true);
  });
});

describe('the save refusals are translated (services/admin/_i18n/messages*.properties)', () => {
  const dir = path.resolve(__dirname, '../../../_i18n');
  const KEYS = ['CONFIG_SAVE_INVALID_JSON', 'CONFIG_SAVE_INVALID', 'CONFIG_SAVE_ACTIVE', 'CONFIG_SAVE_ACTIVATION_COLUMNS', 'CONFIG_SAVE_NO_KEY', 'CONFIG_CREATE_USE_ACTION'];

  function load(file: string): Map<string, string> {
    const entries = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)
      .filter((line: string) => line.trim() !== '' && !line.startsWith('#'))
      .map((line: string) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as [string, string]);
    return new Map(entries);
  }

  const defaults = load('messages.properties');

  it('the default bundle holds every key the service rejects with', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../src/srv/config-service.ts'), 'utf8');
    const used = Array.from(new Set((source.match(/'CONFIG_(?:SAVE|CREATE)_[A-Z_]+'/g) || []).map((k: string) => k.slice(1, -1)))).sort();
    expect(used).toEqual([...KEYS].sort());
    // The bundle is shared with other services' refusals (TEAM_*), so it holds at least these keys.
    expect([...defaults.keys()]).toEqual(expect.arrayContaining(KEYS));
  });

  it.each(['de', 'es', 'fr', 'it', 'nl', 'pt'])('%s has the same keys and placeholders, translated', (lang) => {
    const bundle = load(`messages_${lang}.properties`);
    expect([...bundle.keys()].sort()).toEqual([...defaults.keys()].sort());
    for (const [key, text] of defaults) {
      const translated = bundle.get(key)!;
      expect(translated.match(/\{\d+\}/g) ?? []).toEqual(text.match(/\{\d+\}/g) ?? []);
      expect(translated).not.toBe(text);
      if (KEYS.includes(key)) expect(translated).not.toMatch(/'/);
    }
  });

  // There is no Deactivate action: another configuration's activation (or Rollback) ends it.
  it.each(['', '_de', '_es', '_fr', '_it', '_nl', '_pt'])('messages%s: CONFIG_SAVE_ACTIVE names no Deactivate action', (suffix) => {
    const text = load(`messages${suffix}.properties`).get('CONFIG_SAVE_ACTIVE');
    expect(text).toBeDefined();
    expect(text).not.toMatch(/deactiv|deaktiv|desactiv|desactív|désactiv|disattiv|desativ/i);
  });
});

describe('creating a configuration over OData is refused', () => {
  it('rejects every CREATE with 400 CONFIG_CREATE_USE_ACTION', () => {
    const service = { before: jest.fn(), on: jest.fn(), after: jest.fn() };
    configurationServiceFactory(service);
    const registration = service.before.mock.calls.find(([event, entity]) => event === 'CREATE' && entity === 'ApiConfigurations');
    expect(registration).toBeDefined();
    const beforeCreate = registration![2];
    for (const payload of [{ name: 'n', configData: '{}' }, { name: 'n', isActive: true }, { name: 'n', checksum: 'forged', isValid: true }]) {
      expect(() => beforeCreate(request(payload))).toThrow(expect.objectContaining({ status: 400, key: 'CONFIG_CREATE_USE_ACTION' }));
    }
  });
});
