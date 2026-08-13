/**
 * Characterization test for awsBedrockService's cache_control filter (B2, fix round 1
 * for a B3-review Critical).
 *
 * `shouldFilterCacheControl` originally read `modelDetails.supports_prompt_caching ===
 * false` directly. B2 first routed it through `resolvePromptCachingSupport(...) ===
 * false` (src/utils/promptCachingSupport.ts), which infers a provider-based default when
 * no config flag is set. That inference is the bug this fix removes from this site:
 * `cachingProvider` traces to modelService.ts's `provider || 'unknown'` catalog-merge
 * fallback, so a RUNNING deployment whose backing foundation-model entry has dropped out
 * of the live SAP catalog resolves as provider `'unknown'` — which the resolver's default
 * then turns into `false`, silently stripping Claude Code's own cache_control from a real
 * Anthropic model. This site now checks the EXPLICIT config flags directly (model tier or
 * provider tier), never the resolver's inferred default:
 *
 *  1. This service serves Anthropic-native models exclusively. With no config flags at
 *     all, nothing strips — byte-identical to the original code's behaviour on an unset
 *     field (`undefined === false` was already false).
 *  2. An explicit config `false` (e.g. claude-3-haiku) still strips. Unchanged.
 *  3. NEW: a model whose provider resolves to `'unknown'` (or empty) via catalog drift,
 *     with no config flags, does NOT strip. This is the case the Critical found broken —
 *     identity inference must never trigger a strip.
 *  4. A hypothetical non-Anthropic model with no config flags — B2 had this strip
 *     (the resolver's `provider !== 'anthropic'` default). That is now REVERSED by
 *     design: this site no longer asks what the model's inferred identity is at all,
 *     only whether an operator explicitly flagged it `false`. No flag, no strip, for any
 *     provider.
 *
 * Mocking style follows test/beta-flag-quarantine-wiring.test.ts: the real
 * `processBedrockRequest` native (invoke) path, with axios.post as the observation point.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
  createSafePreview: jest.fn(() => ''),
  createHeadersPreview: jest.fn(() => ''),
}));

const mockPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...args: any[]) => (mockPost as any)(...args),
  },
}));

// Per-test knob: which provider modelService reports for `test-model`.
let modelOwner: string | undefined;
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: jest.fn(() => Promise.resolve({
      id: 'test-model',
      executableId: 'aws-bedrock',
      deploymentUrl: 'http://mock-sap/x',
      anthropic_version: 'bedrock-2023-05-31',
      subpaths_native: ['invoke'],
      owned_by: modelOwner,
    })),
    getAuthToken: jest.fn().mockResolvedValue('tok' as never),
  },
}));

// Per-test knobs standing in for api_config.json's model_list_changes / provider flags.
let modelFlag: boolean | undefined;
let providerFlag: boolean | undefined;
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportedBetaHeaders: () => [],
    getExcludedBetaHeaders: () => [],
    getTimeout: () => 1000,
    getConfig: () => ({}),
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap' }),
    getSupportsPromptCaching: (provider?: string, modelName?: string) => (
      modelName ? modelFlag : (provider ? providerFlag : undefined)
    ),
  },
}));

jest.mock('../src/services/rateLimitManager', () => ({
  __esModule: true,
  default: {
    checkAndApplyDelay: jest.fn().mockResolvedValue(0 as never),
    recordSuccess: jest.fn(),
    isRateLimitError: jest.fn(() => false),
    recordRateLimit: jest.fn().mockResolvedValue(undefined as never),
  },
}));

jest.mock('../src/utils/usageTracker', () => ({
  __esModule: true,
  emitUsageEvent: jest.fn(),
  updateTokenCounts: jest.fn(),
}));

jest.mock('../src/services/pluginExecutor', () => ({
  __esModule: true,
  executeAfterPlugins: jest.fn(async (_req: any, _res: any, data: any) => data),
  executeStreamPlugins: jest.fn(async (_req: any, _res: any, chunk: any) => chunk),
}));

import processBedrockRequestModule from '../src/services/awsBedrockService';

const { processBedrockRequest } = processBedrockRequestModule as any;

function buildOptions(requestBody: any) {
  return {
    modelId: 'test-model',
    originalModelId: 'test-model',
    subpath: 'invoke',
    requestBody,
    headers: {},
    debugRequestId: '',
    req: {} as any,
    res: {} as any,
  };
}

function bodyWithCacheControl() {
  return {
    max_tokens: 1,
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
    ],
  };
}

describe('awsBedrockService: cache_control filter (B2 characterization)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: { ok: true } } as never);
    modelOwner = 'Anthropic';
    modelFlag = undefined;
    providerFlag = undefined;
  });

  it('an Anthropic model with no config flags at all keeps cache_control — unchanged', async () => {
    modelOwner = 'Anthropic';
    modelFlag = undefined;
    providerFlag = undefined;

    await processBedrockRequest(buildOptions(bodyWithCacheControl()));

    const sentBody = mockPost.mock.calls[0][1] as any;
    expect(sentBody.system[0]).toHaveProperty('cache_control');
    expect(sentBody.messages[0].content[0]).toHaveProperty('cache_control');
  });

  it('an explicit config false (e.g. claude-3-haiku) still strips cache_control — unchanged', async () => {
    modelOwner = 'Anthropic';
    modelFlag = false;
    providerFlag = undefined;

    await processBedrockRequest(buildOptions(bodyWithCacheControl()));

    const sentBody = mockPost.mock.calls[0][1] as any;
    expect(sentBody.system[0]).not.toHaveProperty('cache_control');
    expect(sentBody.messages[0].content[0]).not.toHaveProperty('cache_control');
  });

  it('a model whose provider resolves to "unknown" via catalog drift, with no config flags, does NOT strip cache_control — the case the B3-review Critical found broken', async () => {
    // Stands in for modelService.ts's `provider || 'unknown'` fallback: a RUNNING
    // deployment whose backing foundation-model entry has dropped out of the live SAP
    // catalog. Pre-fix, this fed into resolvePromptCachingSupport's provider-based
    // default (`'unknown' !== 'anthropic'` -> false -> strip), silently stripping
    // Claude Code's own cache_control from what is, in reality, an Anthropic model.
    modelOwner = 'unknown';
    modelFlag = undefined;
    providerFlag = undefined;

    await processBedrockRequest(buildOptions(bodyWithCacheControl()));

    const sentBody = mockPost.mock.calls[0][1] as any;
    expect(sentBody.system[0]).toHaveProperty('cache_control');
    expect(sentBody.messages[0].content[0]).toHaveProperty('cache_control');
  });

  it('a non-Anthropic model with no config flags does NOT strip cache_control — reversed from B2: no flag means no strip, for any provider', async () => {
    // B2 had this case strip, via the resolver's `provider !== 'anthropic'` default.
    // This site no longer consults inferred identity at all — only an explicit
    // config `false` (model or provider tier) strips.
    modelOwner = 'SomeOtherProvider';
    modelFlag = undefined;
    providerFlag = undefined;

    await processBedrockRequest(buildOptions(bodyWithCacheControl()));

    const sentBody = mockPost.mock.calls[0][1] as any;
    expect(sentBody.system[0]).toHaveProperty('cache_control');
    expect(sentBody.messages[0].content[0]).toHaveProperty('cache_control');
  });
});
