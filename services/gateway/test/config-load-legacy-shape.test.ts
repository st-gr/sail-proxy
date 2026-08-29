/**
 * The config-file LOAD path is the quiet half of the old-shape problem: an
 * old-flat-layout api_config.json parses, caches, and used to be announced with
 * a plain `logger.info`. Every reader of a moved section then finds nothing, so
 * observability.siem, observability.pseudonymization and platform.security all
 * disengage while the operator believes they are on.
 *
 * Two behaviours, deliberately different:
 *
 * - Standalone (the npm-dist surface, no Admin Service and no UI to notice
 *   through): index.ts refuses to bind the listener and exits non-zero.
 * - Everywhere else: log the error on every load and KEEP SERVING. That branch
 *   also serves the Admin-Service fallback and loadConfig is lazy, so throwing
 *   would convert a transient admin outage into per-request 500s; and swapping
 *   in DEFAULT_CONFIG would turn an inert config into actively wrong model
 *   routing.
 *
 * The standalone half is additionally verified end-to-end against the real
 * npm-dist CLI; see the follow-ups report.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { legacyShapeErrorForFile } from '../src/utils/legacyConfigShape';

const OLD_SHAPE = {
  api_config: {
    timeouts: { default: 600000, streaming: 600000 },
    siem: { enabled: true, sinks: [] },
    pseudonymization: { enabled: true },
    security: { enabled: true },
  },
};

const NEW_SHAPE = {
  api_config: {
    platform: { timeouts: { default: 600000, streaming: 600000 } },
    observability: { siem: { enabled: true, sinks: [] } },
  },
};

let tmpDir: string;

function writeConfig(name: string, contents: unknown): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  return file;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-config-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('legacyShapeErrorForFile', () => {
  it('names every offending section and its new home', () => {
    const result = legacyShapeErrorForFile(writeConfig('old.json', OLD_SHAPE));

    expect(result).not.toBeNull();
    expect(result!.sections.sort()).toEqual(['pseudonymization', 'security', 'siem', 'timeouts']);
    expect(result!.moved_sections).toEqual({
      timeouts: 'platform.timeouts',
      siem: 'observability.siem',
      pseudonymization: 'observability.pseudonymization',
      security: 'platform.security',
    });
    expect(result!.message).toContain('timeouts -> platform.timeouts');
    expect(result!.message).toContain('siem -> observability.siem');
    // The operator's actual risk, stated in the message rather than implied.
    expect(result!.message).toContain('NOT in effect');
  });

  it('is silent on a new-shape file', () => {
    expect(legacyShapeErrorForFile(writeConfig('new.json', NEW_SHAPE))).toBeNull();
  });

  it('is silent on an absent, unparseable or non-object file', () => {
    // None of these are this check's business; the load path has its own
    // handling and must not be pre-empted by a bogus shape verdict.
    expect(legacyShapeErrorForFile(path.join(tmpDir, 'does-not-exist.json'))).toBeNull();
    expect(legacyShapeErrorForFile(writeConfig('broken.json', '{ not json'))).toBeNull();
    expect(legacyShapeErrorForFile(writeConfig('empty.json', {}))).toBeNull();
    expect(legacyShapeErrorForFile(writeConfig('array.json', { api_config: [] }))).toBeNull();
  });
});

describe('non-standalone load of an old-shape file', () => {
  const errors: string[] = [];

  beforeAll(() => {
    jest.resetModules();
    errors.length = 0;

    jest.doMock('@libs/logger', () => ({
      getDefaultLogger: () => ({
        error: (_component: string, message: string) => { errors.push(message); },
        warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
      }),
    }));
    // Non-standalone, and no VALKEY_URL, so loadConfig reaches the file branch.
    // Only isStandaloneMode is overridden - the module's other exports are used
    // by configService's own import graph and must stay real.
    jest.doMock('../src/config/unifiedAuthConfig', () => ({
      ...jest.requireActual('../src/config/unifiedAuthConfig'),
      isStandaloneMode: () => false,
    }));

    process.env.CONFIG_FILE_PATH = writeConfig('non-standalone.json', OLD_SHAPE);
    delete process.env.VALKEY_URL;
  });

  afterAll(() => {
    delete process.env.CONFIG_FILE_PATH;
    jest.dontMock('@libs/logger');
    jest.dontMock('../src/config/unifiedAuthConfig');
    jest.resetModules();
  });

  it('logs the mapping and still serves the config it read', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const configService = require('../src/services/configService').default;
    const config = configService.getConfig();

    // Kept loading: the caller gets the file's own contents...
    expect(config.api_config.timeouts).toEqual({ default: 600000, streaming: 600000 });
    // ...and specifically NOT DEFAULT_CONFIG, whose stub substitutions would be
    // actively wrong model routing rather than merely inert settings.
    expect(config.api_config.providers?.openai?.substitute_models).toBeUndefined();

    const reported = errors.filter((message) => message.includes('old flat api_config layout'));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('timeouts -> platform.timeouts');
    expect(reported[0]).toContain('siem -> observability.siem');
    expect(reported[0]).toContain('pseudonymization -> observability.pseudonymization');
    expect(reported[0]).toContain('security -> platform.security');
  });
});

describe('standalone bootstrap guard', () => {
  const gatewayRoot = path.resolve(__dirname, '..');

  function bootGateway(configFile: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require('child_process');
    return spawnSync(
      'npx',
      ['tsx', path.join(gatewayRoot, 'src', 'index.ts')],
      {
        cwd: gatewayRoot,
        encoding: 'utf8',
        timeout: 60000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          GATEWAY_STANDALONE: 'true',
          CONFIG_FILE_PATH: configFile,
          VALKEY_URL: '',
          PORT: '0',
        },
      }
    );
  }

  it('exits non-zero with the mapping instead of binding the listener', () => {
    const result = bootGateway(writeConfig('bootstrap-old.json', OLD_SHAPE));
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('old flat api_config layout');
    expect(output).toContain('timeouts -> platform.timeouts');
    expect(output).toContain('siem -> observability.siem');
    expect(output).toContain('pseudonymization -> observability.pseudonymization');
    expect(output).toContain('security -> platform.security');
    // Never reached the listener.
    expect(output).not.toContain('Server listening on');
  }, 90000);
});
