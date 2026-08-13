/**
 * Config coverage for the `file_search` *tool* block (`api_config.file_search.tool`),
 * as distinct from the raw `/vector_stores/{id}/search` REST config covered by
 * test/fileSearch/config.test.ts. Also pins the shipped `rewrite_query` default,
 * which this same change flips from `true` to `false` for both the tool and the
 * raw path.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { getDefaultLogger } from '@libs/logger';

import {
  getFileSearchToolConfig,
  resolveMaxSearchesPerRequest,
  resolveMaxNumResultsDefault,
  resolveToolEnabled,
} from '../src/services/configService';

describe('shipped api_config.json — rewrite_query', () => {
  it('defaults rewrite_query to false in the shipped config', () => {
    // Resolved from __dirname, not cwd: a relative fs.readFileSync('api_config.json')
    // depends on how Jest happens to be invoked, and would silently pass or
    // fail depending on the caller's working directory rather than this file.
    const configPath = path.join(__dirname, '..', 'api_config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.api_config.file_search.rewrite_query).toBe(false);
  });
});

describe('resolveMaxSearchesPerRequest', () => {
  it('passes a configured value through unchanged when it is within 1..10 (no clamping)', () => {
    expect(resolveMaxSearchesPerRequest(1)).toBe(1);
    expect(resolveMaxSearchesPerRequest(3)).toBe(3);
    expect(resolveMaxSearchesPerRequest(7)).toBe(7);
    expect(resolveMaxSearchesPerRequest(10)).toBe(10);
  });

  it('clamps a value below the minimum (1) back to the default of 3', () => {
    expect(resolveMaxSearchesPerRequest(0)).toBe(3);
    expect(resolveMaxSearchesPerRequest(-1)).toBe(3);
  });

  it('clamps a value above the maximum (10) back to the default of 3', () => {
    expect(resolveMaxSearchesPerRequest(11)).toBe(3);
    expect(resolveMaxSearchesPerRequest(1000)).toBe(3);
  });

  it('falls back to the default of 3 for non-integer or wrong-typed garbage', () => {
    for (const bad of [2.5, 'three', null, undefined, NaN]) {
      expect(resolveMaxSearchesPerRequest(bad as any)).toBe(3);
    }
  });
});

// A hand-edited api_config.json reaches this resolver unvalidated (the admin
// schema only bounds cockpit-activated configs), and per this codebase's own
// principle — see resolveMaxConcurrentWrites and
// test/fileSearch/teacherLoggingConfig.test.ts:24-25 — "a silent override of
// a tuning choice is its own defect." Warned at most once per offending
// value, since this resolver runs on the search path; a later change to a
// *different* offending value gets its own warning.
describe('resolveMaxSearchesPerRequest — clamp warning', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('warns exactly once for a given offending value, silent on repeats', () => {
    const warnSpy = jest.spyOn(getDefaultLogger(), 'warn');

    for (let i = 0; i < 5; i++) {
      expect(resolveMaxSearchesPerRequest(4242)).toBe(3);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][1]);
    expect(message).toContain('max_searches_per_request');
    expect(message).toContain('4242');
    expect(message).toMatch(/default/i);
  });

  it('warns again when the offending value changes to a different one', () => {
    resolveMaxSearchesPerRequest(9001); // establish a first offending value, pre-spy
    const warnSpy = jest.spyOn(getDefaultLogger(), 'warn');

    expect(resolveMaxSearchesPerRequest(9001)).toBe(3);
    expect(warnSpy).not.toHaveBeenCalled(); // same value, already warned

    expect(resolveMaxSearchesPerRequest(9002)).toBe(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][1])).toContain('9002');
  });

  it('does not warn for an in-range value', () => {
    const warnSpy = jest.spyOn(getDefaultLogger(), 'warn');
    expect(resolveMaxSearchesPerRequest(5)).toBe(5);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('resolveMaxNumResultsDefault', () => {
  it('passes a configured value through unchanged when it is within 1..50 (no clamping)', () => {
    expect(resolveMaxNumResultsDefault(1)).toBe(1);
    expect(resolveMaxNumResultsDefault(10)).toBe(10);
    expect(resolveMaxNumResultsDefault(50)).toBe(50);
  });

  it('falls back to the default of 10 for a value outside 1..50', () => {
    expect(resolveMaxNumResultsDefault(0)).toBe(10);
    expect(resolveMaxNumResultsDefault(-5)).toBe(10);
    expect(resolveMaxNumResultsDefault(51)).toBe(10);
    expect(resolveMaxNumResultsDefault(1e9)).toBe(10);
  });

  it('falls back to the default of 10 for non-integer or wrong-typed garbage', () => {
    for (const bad of [2.5, 'fifty', null, undefined, NaN]) {
      expect(resolveMaxNumResultsDefault(bad as any)).toBe(10);
    }
  });
});

describe('resolveToolEnabled', () => {
  it('passes a genuine boolean through unchanged', () => {
    expect(resolveToolEnabled(true)).toBe(true);
    expect(resolveToolEnabled(false)).toBe(false);
  });

  it('falls back to the default of true for anything that is not a genuine boolean', () => {
    for (const bad of ['true', 'false', 1, 0, null, undefined]) {
      expect(resolveToolEnabled(bad as any)).toBe(true);
    }
  });
});

// FILE_SEARCH_DEFAULTS backs getFileSearchConfig() only when api_config.file_search
// is absent entirely (an install predating the key). That arm — and every field
// on the constant, not just rewriteQuery — had zero coverage: the existing
// test/fileSearch/config.test.ts always reads the real shipped api_config.json,
// which always carries an explicit file_search block, so it exercises the
// per-field `f.x ?? d.x` fallbacks, never the top-level `if (!f) return
// FILE_SEARCH_DEFAULTS` return. Reverting FILE_SEARCH_DEFAULTS.rewriteQuery to
// `true` and running the full suite confirmed this: zero failures anywhere.
//
// One test for the whole object, not one per key: the fallback arm returns
// FILE_SEARCH_DEFAULTS as a single unit, so a single assertion pins every
// field in one shot at the cost of one test rather than twelve. The expected
// value is a hardcoded literal, not `FILE_SEARCH_DEFAULTS` itself — asserting
// `toEqual(FILE_SEARCH_DEFAULTS)` would compare the constant under test
// against itself, so any future edit to the constant would move both sides
// together and this test could never fail.
describe('getFileSearchConfig — fallback defaults (file_search block entirely absent)', () => {
  it('returns the full shipped-default object, matching every field including rewriteQuery=false', () => {
    withConfig({ api_config: {} }, (configService) => {
      expect(configService.getFileSearchConfig()).toEqual({
        enabled: true,
        embeddingModel: 'text-embedding-3-large',
        embeddingDimensions: 1536,
        rewriteQuery: false,
        rewriteQueryModel: 'gpt-4o-mini',
        hybrid: {
          rrfK: 60,
          lexicalEnabled: true,
          candidates: 50,
          rerank: { enabled: 'auto', model: 'cohere-reranker' },
        },
        chunking: { maxChunkSizeTokens: 800, chunkOverlapTokens: 400 },
        limits: { maxFileBytes: 33554432, maxTokensPerFile: 5000000, maxFilesPerStore: 10000 },
        ingestion: { concurrency: 4, extractTimeoutMs: 60000, maxRetries: 3 },
        blobStorage: {
          backend: 'db',
          localPath: '/var/lib/sail-proxy/blobs',
          s3: { bucket: '', prefix: 'sail-proxy/blobs', endpoint: '', region: '' },
        },
      });
    });
  });
});

describe('getFileSearchToolConfig', () => {
  it('returns the shipped tool defaults', () => {
    expect(getFileSearchToolConfig()).toEqual({
      enabled: true,
      maxSearchesPerRequest: 3,
      maxNumResultsDefault: 10,
    });
  });

  // The upgrading install: its api_config.json predates this release and has
  // no `file_search.tool` block at all (the shipped config always has one, so
  // the test above alone can never exercise this arm of the accessor).
  it('yields full tool defaults, not {}, when the tool block is absent entirely', () => {
    withConfig({ api_config: { file_search: {} } }, (configService) => {
      expect(configService.getFileSearchToolConfig()).toEqual({
        enabled: true,
        maxSearchesPerRequest: 3,
        maxNumResultsDefault: 10,
      });
    });
  });

  it('yields full tool defaults, not {}, when file_search itself is absent (pre-file_search install)', () => {
    withConfig({ api_config: {} }, (configService) => {
      expect(configService.getFileSearchToolConfig()).toEqual({
        enabled: true,
        maxSearchesPerRequest: 3,
        maxNumResultsDefault: 10,
      });
    });
  });

  it('reads through configured values, including a clamped max_searches_per_request', () => {
    withConfig({
      api_config: {
        file_search: {
          tool: { enabled: false, max_searches_per_request: 999, max_num_results_default: 25 },
        },
      },
    }, (configService) => {
      expect(configService.getFileSearchToolConfig()).toEqual({
        enabled: false,
        maxSearchesPerRequest: 3, // 999 is out of range -> clamped to the default
        maxNumResultsDefault: 25,
      });
    });
  });

  it('falls back to defaults for a non-boolean enabled and an out-of-range max_num_results_default', () => {
    // A hand-edited api_config.json reaches the gateway unvalidated by the
    // admin schema (that only bounds cockpit-activated configs), so both
    // fields must be checked here, not just max_searches_per_request.
    withConfig({
      api_config: {
        file_search: {
          tool: { enabled: 'yes', max_searches_per_request: 5, max_num_results_default: 1e9 },
        },
      },
    }, (configService) => {
      expect(configService.getFileSearchToolConfig()).toEqual({
        enabled: true, // 'yes' is not a boolean -> falls back to the default
        maxSearchesPerRequest: 5,
        maxNumResultsDefault: 10, // 1e9 is out of range -> falls back to the default
      });
    });
  });
});

/**
 * Runs `fn` against a fresh, isolated instance of configService whose
 * `getConfig()` resolves to `config` — by pointing CONFIG_FILE_PATH at a
 * temp file and re-requiring the module with `jest.resetModules()`.
 *
 * A `jest.spyOn(configService, 'getConfig')` would in fact be seen by
 * `getFileSearchToolConfig`'s internal call here (this project compiles with
 * `module: commonjs`, and TypeScript 5.9 emits same-module references to an
 * exported `const` arrow through the exports object — `(0,
 * exports.getConfig)()` — not through the local binding, so the spy is not
 * bypassed). This helper exists for a different reason: it exercises the
 * real `CONFIG_FILE_PATH` → disk-load path instead of stubbing `getConfig`
 * out, which is the more faithful way to prove an *upgrading install's*
 * on-disk config (no `tool` block at all) resolves to the shipped defaults.
 */
function withConfig(
  config: unknown,
  fn: (configService: typeof import('../src/services/configService')) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filesearch-tool-config-'));
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
