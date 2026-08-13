/**
 * Pure-resolver coverage for resolvePromptCachingSupport (order: per-model
 * flag → provider flag → provider === 'anthropic' default, with NO
 * version/family heuristic inside the Anthropic tier — see
 * src/utils/promptCachingSupport.ts), plus configService.getSupportsPromptCaching
 * layered config lookup, following the same pattern as
 * test/responses-eligibility.test.ts and test/filesearch-tool-config.test.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, jest } from '@jest/globals';
import { resolvePromptCachingSupport } from '../src/utils/promptCachingSupport';

describe('resolvePromptCachingSupport', () => {
  it('defaults anthropic models to true with no flags set', () => {
    expect(resolvePromptCachingSupport({ provider: 'anthropic' })).toBe(true);
  });

  it('defaults non-anthropic models to false with no flags set', () => {
    expect(resolvePromptCachingSupport({ provider: 'openai' })).toBe(false);
    expect(resolvePromptCachingSupport({ provider: 'perplexity' })).toBe(false);
  });

  it('defaults to false when provider is undefined', () => {
    expect(resolvePromptCachingSupport({})).toBe(false);
  });

  it('per-model flag wins over the anthropic default, in both directions', () => {
    expect(resolvePromptCachingSupport({ provider: 'anthropic', modelFlag: false })).toBe(false);
    expect(resolvePromptCachingSupport({ provider: 'openai', modelFlag: true })).toBe(true);
  });

  it('the config-exception scenario: an anthropic model config-flagged off stays off', () => {
    // e.g. claude-3-haiku — the owner's design keeps this kind of exception in
    // config (modelFlag), not as a version/family heuristic in code.
    expect(resolvePromptCachingSupport({ provider: 'anthropic', modelFlag: false })).toBe(false);
  });

  it('provider flag wins over the default, and loses to the model flag', () => {
    expect(resolvePromptCachingSupport({ provider: 'openai', providerFlag: true })).toBe(true);
    expect(resolvePromptCachingSupport({ provider: 'anthropic', providerFlag: false })).toBe(false);
    expect(resolvePromptCachingSupport({ provider: 'anthropic', providerFlag: false, modelFlag: true })).toBe(true);
  });

  it('model flag wins by boolean typeof, not truthiness, over a conflicting provider flag', () => {
    // A regression to `opts.modelFlag ? ... : ...` (or `||`-style truthiness)
    // would treat `modelFlag: false` as "unset" and fall through to the
    // provider flag, silently flipping this case.
    expect(resolvePromptCachingSupport({ provider: 'openai', modelFlag: false, providerFlag: true })).toBe(false);
    expect(resolvePromptCachingSupport({ provider: 'openai', modelFlag: true, providerFlag: false })).toBe(true);
  });
});

describe('configService.getSupportsPromptCaching', () => {
  it('resolves a provider-level flag', () => {
    withConfig({
      api_config: { anthropic: { supports_prompt_caching: false } },
    }, (configService) => {
      expect(configService.getSupportsPromptCaching('anthropic')).toBe(false);
    });
  });

  it('a per-model flag overrides the provider-level flag', () => {
    withConfig({
      api_config: {
        anthropic: { supports_prompt_caching: true },
        model_list_changes: {
          'anthropic--claude-3-haiku': { supports_prompt_caching: false },
        },
      },
    }, (configService) => {
      expect(configService.getSupportsPromptCaching('anthropic', 'anthropic--claude-3-haiku')).toBe(false);
      // A sibling model with no override still sees the provider-level flag.
      expect(configService.getSupportsPromptCaching('anthropic', 'anthropic--claude-4.8-opus')).toBe(true);
    });
  });

  it('returns undefined when neither provider nor model has a flag configured', () => {
    withConfig({ api_config: {} }, (configService) => {
      expect(configService.getSupportsPromptCaching('anthropic', 'anthropic--claude-4.8-opus')).toBeUndefined();
      expect(configService.getSupportsPromptCaching()).toBeUndefined();
    });
  });
});

/**
 * Runs `fn` against a fresh, isolated instance of configService whose
 * `getConfig()` resolves to `config` — by pointing CONFIG_FILE_PATH at a
 * temp file and re-requiring the module with `jest.resetModules()`.
 * Mirrors the identically-named helper in test/filesearch-tool-config.test.ts.
 */
function withConfig(
  config: unknown,
  fn: (configService: typeof import('../src/services/configService')) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-caching-support-'));
  const configPath = path.join(dir, 'api_config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));

  const prevConfigFilePath = process.env.CONFIG_FILE_PATH;
  const prevStandalone = process.env.GATEWAY_STANDALONE;
  process.env.CONFIG_FILE_PATH = configPath;
  process.env.GATEWAY_STANDALONE = 'true';

  jest.resetModules();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const freshConfigService = require('../src/services/configService');
    fn(freshConfigService);
  } finally {
    if (prevConfigFilePath === undefined) delete process.env.CONFIG_FILE_PATH;
    else process.env.CONFIG_FILE_PATH = prevConfigFilePath;
    if (prevStandalone === undefined) delete process.env.GATEWAY_STANDALONE;
    else process.env.GATEWAY_STANDALONE = prevStandalone;
    jest.resetModules();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
