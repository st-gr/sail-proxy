/**
 * The plugin executor's forced-pseudonymization backstop reads the per-model force flag at the end
 * of every hook chain that has no pseudonymization plugin, and that read resolves the served model
 * through the anthropic substitutions. It is a settings lookup, not a substitution of the request,
 * so it logs no "Substituting model" line; a caller that substitutes still does.
 *
 * Real configService against a fixture file (the google-provider-config.test.ts pattern).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const infos: string[] = [];
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), debug: jest.fn(), trace: jest.fn(),
    info: (_component: string, message: string) => { infos.push(message); },
  }),
}));

let tmpDir: string;
let configFile: string;

function load() {
  jest.resetModules();
  process.env.CONFIG_FILE_PATH = configFile;
  return {
    configService: require('../src/services/configService').default,
    forcedRun: require('../src/plugins/pseudonymization/forcedRun'),
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-substitution-quiet-'));
  configFile = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    api_config: {
      providers: { anthropic: { substitute_models: [{ from: 'claude-example', to: 'anthropic--claude-example--deployed' }] } },
      models: { overrides: { 'anthropic--claude-example--deployed': { pseudonymization: { enabled: true, method: 'pseudonymization' } } } },
    },
  }));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CONFIG_FILE_PATH;
  jest.resetModules();
});

beforeEach(() => { infos.length = 0; });

const substitutionLines = () => infos.filter((m) => m.startsWith('Substituting model'));

it('a substituting caller still logs the substitution', () => {
  const { configService } = load();
  expect(configService.getSubstitutedModel('anthropic', 'claude-example')).toBe('anthropic--claude-example--deployed');
  expect(substitutionLines()).toHaveLength(1);
});

it('quiet: the same answer without the line', () => {
  const { configService } = load();
  infos.length = 0;
  expect(configService.getSubstitutedModel('anthropic', 'claude-example', { quiet: true })).toBe('anthropic--claude-example--deployed');
  expect(substitutionLines()).toHaveLength(0);
});

it('readForceSource resolves the substituted model\'s force flag without logging a substitution', () => {
  const { forcedRun } = load();
  infos.length = 0;
  const source = forcedRun.readForceSource({ body: { model: 'claude-example' }, __endpoint: 'anthropic' });
  expect(source).toEqual(expect.objectContaining({ source: 'model' }));
  expect(substitutionLines()).toHaveLength(0);
});
