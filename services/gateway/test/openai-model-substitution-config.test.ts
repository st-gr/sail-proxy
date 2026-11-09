/**
 * providers.openai / providers.perplexity substitute_models on the OpenAI-shaped
 * routes, read through the real configService against real config files, the way
 * test/google-provider-config.test.ts proves the google list.
 *
 * Before this fix neither list had a reader: a GPT-4 -> o1 rename reached SAP AI
 * Core as GPT-4. The shipped configs carried exactly that pair as an inert sample;
 * it was dropped once renames started to apply (last case below), so the rename
 * cases bring their own config with the same two entries.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_CONFIG as GATEWAY_DEFAULT_CONFIG } from '../src/services/defaultConfig';
import { MINIMAL_DEFAULT_CONFIG } from '../../admin/src/srv/minimal-default-config';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SHIPPED_CONFIGS = [
  'services/gateway/api_config.json',
  'services/admin/api_config.json',
  'npm-dist/sail-proxy/src/templates/api_config.template.json',
];
let tmpDir: string;
let SAMPLE_CONFIG: string;

function writeConfig(name: string, contents: unknown): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
  return file;
}

/** Loads the middleware (and so configService) fresh against the given config file. */
function middlewareFor(configFile: string) {
  jest.resetModules();
  process.env.CONFIG_FILE_PATH = configFile;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/middlewares/modelSubstitution').substituteOpenAICompatibleModel;
}

/** Runs the middleware on a body and returns the model it leaves behind. */
function modelAfter(middleware: any, body: any): string {
  const req: any = { body };
  const next = jest.fn();
  middleware(req, {}, next);
  expect(next).toHaveBeenCalledTimes(1);
  return req.body.model;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-model-substitution-'));
  SAMPLE_CONFIG = writeConfig('sample.json', {
    api_config: {
      providers: {
        openai: { substitute_models: [{ from: 'GPT-4', to: 'o1' }, { from: 'GPT-3.5', to: 'GPT-4' }] },
        anthropic: { substitute_models: [{ from: 'claude-3-5-haiku-20241022', to: 'anthropic--claude-4.5-haiku--deployed' }] },
      },
    },
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.CONFIG_FILE_PATH;
  jest.resetModules();
});

describe('model renames on the OpenAI-shaped routes', () => {
  it('applies a providers.openai rename GPT-4 -> o1', () => {
    const substitute = middlewareFor(SAMPLE_CONFIG);
    expect(modelAfter(substitute, { model: 'GPT-4', messages: [] })).toBe('o1');
  });

  it('renames once: GPT-3.5 -> GPT-4 does not chain on to o1', () => {
    const substitute = middlewareFor(SAMPLE_CONFIG);
    expect(modelAfter(substitute, { model: 'GPT-3.5', messages: [] })).toBe('GPT-4');
  });

  it('leaves an unmatched model unchanged', () => {
    const substitute = middlewareFor(SAMPLE_CONFIG);
    expect(modelAfter(substitute, { model: 'gpt-4.1', messages: [] })).toBe('gpt-4.1');
  });

  it('matches exactly, case included', () => {
    const substitute = middlewareFor(SAMPLE_CONFIG);
    expect(modelAfter(substitute, { model: 'gpt-4', messages: [] })).toBe('gpt-4');
  });

  it('does not read another provider\'s list (an anthropic rename stays inert here)', () => {
    const substitute = middlewareFor(SAMPLE_CONFIG);
    // providers.anthropic renames claude-3-5-haiku-20241022 in the fixture.
    expect(modelAfter(substitute, { model: 'claude-3-5-haiku-20241022', messages: [] }))
      .toBe('claude-3-5-haiku-20241022');
  });

  it('applies a providers.perplexity rename', () => {
    const substitute = middlewareFor(writeConfig('perplexity.json', {
      api_config: { providers: { perplexity: { substitute_models: [{ from: 'web-answers', to: 'sonar-pro' }] } } },
    }));
    expect(modelAfter(substitute, { model: 'web-answers', messages: [] })).toBe('sonar-pro');
  });

  it('consults openai before perplexity when both lists name the same model', () => {
    const substitute = middlewareFor(writeConfig('both.json', {
      api_config: {
        providers: {
          openai: { substitute_models: [{ from: 'shared-alias', to: 'gpt-4.1' }] },
          perplexity: { substitute_models: [{ from: 'shared-alias', to: 'sonar' }] },
        },
      },
    }));
    expect(modelAfter(substitute, { model: 'shared-alias', messages: [] })).toBe('gpt-4.1');
  });

  it('passes a body without a string model through untouched', () => {
    const substitute = middlewareFor(SAMPLE_CONFIG);
    const req: any = { body: { messages: [] } };
    const next = jest.fn();
    substitute(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body).toEqual({ messages: [] });
  });

  it('ships no openai or perplexity renames in any shipped or fallback config', () => {
    const configs: Array<[string, any]> = [
      ...SHIPPED_CONFIGS.map((rel): [string, any] => [rel, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))]),
      ['gateway DEFAULT_CONFIG', GATEWAY_DEFAULT_CONFIG],
      ['admin MINIMAL_DEFAULT_CONFIG', MINIMAL_DEFAULT_CONFIG],
    ];
    for (const [rel, config] of configs) {
      const providers = config.api_config.providers;
      for (const provider of ['openai', 'perplexity']) {
        expect({ rel, provider, renames: providers[provider]?.substitute_models ?? [] })
          .toEqual({ rel, provider, renames: [] });
      }
    }
  });
});
