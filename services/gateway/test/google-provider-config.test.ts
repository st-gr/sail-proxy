/**
 * Task 2 of the Gemini route plan: the google provider gets the same
 * substitution wiring every other provider already has, plus a service-auth
 * entry for the /google route.
 *
 * configService.getSubstitutedModel reads providers.<name>.substitute_models
 * through providerConfig(), which is gated on the internal PROVIDER_KEYS list
 * - a provider absent from that list is invisible to every reader keyed off
 * it, substitution included, no matter what the config file says. Proven here
 * with a real fixture file and a fresh module load (the pattern
 * test/config-load-legacy-shape.test.ts uses), not a mocked config object, so
 * this exercises the real providerConfig() gate rather than a stand-in for it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

let tmpDir: string;

function writeConfig(name: string, contents: unknown): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
  return file;
}

/** Loads configService fresh against the given fixture file. */
function configServiceFor(configFile: string) {
  jest.resetModules();
  process.env.CONFIG_FILE_PATH = configFile;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/services/configService').default;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-provider-config-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.CONFIG_FILE_PATH;
  jest.resetModules();
});

describe('configService.getSubstitutedModel for the google provider', () => {
  it('substitutes a model named in providers.google.substitute_models', () => {
    const configFile = writeConfig('with-substitution.json', {
      api_config: {
        providers: {
          google: {
            substitute_models: [
              { from: 'gemini-1.5-flash', to: 'gemini-3.5-flash--deployed' },
            ],
          },
        },
      },
    });

    const configService = configServiceFor(configFile);

    expect(configService.getSubstitutedModel('google', 'gemini-1.5-flash')).toBe('gemini-3.5-flash--deployed');
  });

  it('returns the input unchanged when the substitution list is empty', () => {
    const configFile = writeConfig('empty-list.json', {
      api_config: {
        providers: {
          google: {
            substitute_models: [],
          },
        },
      },
    });

    const configService = configServiceFor(configFile);

    expect(configService.getSubstitutedModel('google', 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
  });
});

describe('serviceConfigurations.google', () => {
  it('names the google service, for the /google route\'s unified-auth entry', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { serviceConfigurations } = require('../src/services/unifiedAuthProxyService');
    expect(serviceConfigurations.google.serviceName).toBe('google');
  });
});
