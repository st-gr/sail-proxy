import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type LoggerLib = typeof import('../../../libs/logger');

describe('shared logger reads platform.logging', () => {
  let dir: string;
  let warn: jest.SpyInstance;
  const savedLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-cfg-'));
    delete process.env.LOG_LEVEL;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
  });

  // Fresh module per test so the warn-once flags start clear.
  function load(apiConfig: unknown): { lib: LoggerLib; file: string } {
    const file = path.join(dir, 'api_config.json');
    fs.writeFileSync(file, JSON.stringify({ api_config: apiConfig }));
    let lib!: LoggerLib;
    jest.isolateModules(() => {
      lib = require('../../../libs/logger');
    });
    return { lib, file };
  }

  const make = (lib: LoggerLib, file: string) =>
    lib.createLogger({ configFilePath: file, enableFileLogging: false }) as any;

  const deprecations = () =>
    warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('platform.logging'));

  it('reads defaultLevel from platform.logging', () => {
    const { lib, file } = load({ platform: { logging: { defaultLevel: 'DEBUG' } } });
    const l = make(lib, file);
    expect(l.isLevelEnabled('Any', 'debug')).toBe(true);
    expect(l.isLevelEnabled('Any', 'trace')).toBe(false);
    expect(deprecations()).toHaveLength(0);
  });

  it('applies a component override over defaultLevel (level matched case-insensitively)', () => {
    const { lib, file } = load({
      platform: { logging: { defaultLevel: 'ERROR', components: { Foo: 'TrAcE' } } }
    });
    const l = make(lib, file);
    expect(l.isLevelEnabled('Foo', 'trace')).toBe(true);
    expect(l.isLevelEnabled('Bar', 'warn')).toBe(false);
  });

  it('lets a recognized LOG_LEVEL win over defaultLevel but not over a component entry', () => {
    process.env.LOG_LEVEL = 'Warn';
    const { lib, file } = load({
      platform: { logging: { defaultLevel: 'trace', components: { Foo: 'debug' } } }
    });
    const l = make(lib, file);
    expect(l.isLevelEnabled('Bar', 'info')).toBe(false);
    expect(l.isLevelEnabled('Bar', 'warn')).toBe(true);
    expect(l.isLevelEnabled('Foo', 'debug')).toBe(true);
  });

  it('ignores an unrecognized LOG_LEVEL and uses defaultLevel', () => {
    process.env.LOG_LEVEL = 'loud';
    const { lib, file } = load({ platform: { logging: { defaultLevel: 'debug' } } });
    expect(make(lib, file).isLevelEnabled('Any', 'debug')).toBe(true);
  });

  it('applies LOG_LEVEL when the config has no logging block', () => {
    process.env.LOG_LEVEL = 'error';
    const { lib, file } = load({ platform: {} });
    expect(make(lib, file).isLevelEnabled('Any', 'warn')).toBe(false);
  });

  it('honours log_folder_path', () => {
    const target = path.join(dir, 'custom-logs');
    const { lib, file } = load({ platform: { logging: { log_folder_path: target } } });
    const l = lib.createLogger({ configFilePath: file, enableFileLogging: true }) as any;
    expect(l.config.logFolderPath).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    l.close();
  });

  it('falls back to a legacy top-level logging block and warns once naming platform.logging', () => {
    const { lib, file } = load({ logging: { defaultLevel: 'debug', components: { Foo: 'error' } } });
    const l = make(lib, file);
    expect(l.isLevelEnabled('Any', 'debug')).toBe(true);
    expect(l.isLevelEnabled('Foo', 'warn')).toBe(false);
    l.reinitialize();
    make(lib, file);
    expect(deprecations()).toHaveLength(1);
    expect(deprecations()[0]).toMatch(/deprecated/i);
  });

  it('prefers platform.logging when both exist and warns once that the legacy block is ignored', () => {
    const { lib, file } = load({
      logging: { defaultLevel: 'trace', components: { Foo: 'trace' } },
      platform: { logging: { defaultLevel: 'error' } }
    });
    const l = make(lib, file);
    expect(l.isLevelEnabled('Any', 'warn')).toBe(false);
    expect(l.isLevelEnabled('Foo', 'trace')).toBe(false);
    l.reinitialize();
    expect(deprecations()).toHaveLength(1);
    expect(deprecations()[0]).toMatch(/ignored/i);
  });

  it('drops a removed component override when the configuration is reloaded', () => {
    const { lib, file } = load({ platform: { logging: { components: { Foo: 'trace' } } } });
    const l = make(lib, file);
    expect(l.isLevelEnabled('Foo', 'trace')).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ api_config: { platform: { logging: {} } } }));
    l.reinitialize();
    expect(l.isLevelEnabled('Foo', 'trace')).toBe(false);
  });

  it('falls back to info when a reload removes defaultLevel and LOG_LEVEL is unset', () => {
    const { lib, file } = load({ platform: { logging: { defaultLevel: 'debug' } } });
    const l = make(lib, file);
    expect(l.isLevelEnabled('Any', 'debug')).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ api_config: { platform: { logging: {} } } }));
    l.reinitialize();
    expect(l.isLevelEnabled('Any', 'debug')).toBe(false);
    expect(l.isLevelEnabled('Any', 'info')).toBe(true);
  });

  describe('shipped api_config files', () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    const shipped = [
      'services/gateway/api_config.json',
      'services/admin/api_config.json',
      'npm-dist/sail-proxy/src/templates/api_config.template.json'
    ];
    const schema = JSON.parse(fs.readFileSync(
      path.join(root, 'services/admin/src/schemas/api-config-schema.json'), 'utf8'));
    const findLogging = (o: any): any => {
      if (o && typeof o === 'object') {
        if (o.properties?.log_folder_path) return o;
        for (const v of Object.values(o)) { const r = findLogging(v); if (r) return r; }
      }
      return undefined;
    };
    const suggested: string[] = findLogging(schema).properties.components['x-keySuggestions'];

    it.each(shipped)('%s pins no component, so LOG_LEVEL=debug reaches every component', rel => {
      const file = path.join(root, rel);
      const logging = JSON.parse(fs.readFileSync(file, 'utf8')).api_config.platform.logging;
      process.env.LOG_LEVEL = 'debug';
      let lib!: LoggerLib;
      jest.isolateModules(() => { lib = require('../../../libs/logger'); });
      const l = make(lib, file);
      for (const c of [...suggested, ...Object.keys(logging.components ?? {})]) {
        expect(l.isLevelEnabled(c, 'debug')).toBe(true);
      }
      expect(Object.keys(logging.components ?? {}).filter(
        c => String(logging.components[c]).toLowerCase() === String(logging.defaultLevel).toLowerCase()
      )).toEqual([]);
    });
  });
});
