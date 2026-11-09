/**
 * usageFolding: the two named token-counting regimes.
 *
 * INCLUSIVE (foldInclusiveUsage) — raw input/prompt total already contains
 * the cached tokens; the cache categories must be SUBTRACTED before
 * recording full-rate input, or they get billed twice (admin's cost SQL
 * prices all four categories separately and ADDS them).
 *
 * EXCLUSIVE (foldExclusiveUsage) — prompt_tokens counts ONLY full-rate
 * tokens; cache read/write are separate line items that were never part of
 * that total, so they must be ADDED with no arithmetic on the prompt count.
 * Subtracting here is the historical bug: it shipped once, computed
 * max(0, 14 − 29004) = 0, and erased real tokens.
 *
 * Numbers below are the live measured captures cited in the functions' own
 * doc comments — see usageFolding.ts.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

import { createUsageMetrics } from '../src/utils/usageTracker';
import {
  foldInclusiveUsage, foldExclusiveUsage, noteExtraUsage, readCacheWriteTokens,
  cacheRegimeFor, cacheRegimeForUsage, foldOrchestrationUsageFor, fullRatePromptTokens, wholePromptTokens,
} from '../src/utils/usageFolding';

/**
 * readCacheWriteTokens: the shared real-name-first, legacy-fallback reader every read site
 * (usageFolding.ts, hostedTool/engine.ts, responsesController.ts) goes through. `cache_write_tokens`
 * is the real OpenAI/ChatGPT Responses API name (measured on real codex traffic and on our own
 * deployed path — see RESPONSES-API-COMPLIANCE.md); `cache_creation_tokens` is the legacy name
 * this gateway emitted and read until this fix.
 */
describe('readCacheWriteTokens', () => {
  it('reads the real API field name', () => {
    expect(readCacheWriteTokens({ cache_write_tokens: 29000 })).toBe(29000);
  });

  it('falls back to the legacy field name when the real one is absent', () => {
    expect(readCacheWriteTokens({ cache_creation_tokens: 17692 })).toBe(17692);
  });

  it('prefers the real field name when both are present', () => {
    expect(readCacheWriteTokens({ cache_write_tokens: 29000, cache_creation_tokens: 1 })).toBe(29000);
  });

  it('returns 0 for a missing details object, an empty one, or a non-number value', () => {
    expect(readCacheWriteTokens(undefined)).toBe(0);
    expect(readCacheWriteTokens({})).toBe(0);
    expect(readCacheWriteTokens({ cache_write_tokens: null })).toBe(0);
  });
});

describe('foldInclusiveUsage', () => {
  it('subtracts the cache-read tokens from the raw input total (native Responses bridge capture, 2026-08-07: prompt_tokens 16303, cache_creation_tokens 0, cached_tokens 16292)', () => {
    const metrics = createUsageMetrics();
    foldInclusiveUsage(metrics, 16303, 40, 0, 16292);
    expect(metrics.inputTokens).toBe(11);
    expect(metrics.outputTokens).toBe(40);
    expect(metrics.cacheCreationInputTokens).toBe(0);
    expect(metrics.cacheReadInputTokens).toBe(16292);
  });

  it('clamps full-rate input to 0 rather than going negative when cache tokens meet or exceed the raw total', () => {
    const metrics = createUsageMetrics();
    foldInclusiveUsage(metrics, 100, 10, 0, 150);
    expect(metrics.inputTokens).toBe(0);
    expect(metrics.inputTokens).toBeGreaterThanOrEqual(0);
    expect(metrics.cacheReadInputTokens).toBe(150);
  });
});

describe('foldExclusiveUsage', () => {
  it('leaves prompt_tokens untouched and records the cache-CREATION line item (chat/completions capture: prompt_tokens 14, cache_creation 29004)', () => {
    const metrics = createUsageMetrics();
    foldExclusiveUsage(metrics, 14, 5, 29004, 0);
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.outputTokens).toBe(5);
    expect(metrics.cacheCreationInputTokens).toBe(29004);
    expect(metrics.cacheReadInputTokens).toBe(0);
  });

  it('leaves prompt_tokens untouched and records the cache-READ line item (chat/completions capture: prompt_tokens 14, cached_tokens 29004)', () => {
    const metrics = createUsageMetrics();
    foldExclusiveUsage(metrics, 14, 5, 0, 29004);
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.outputTokens).toBe(5);
    expect(metrics.cacheCreationInputTokens).toBe(0);
    expect(metrics.cacheReadInputTokens).toBe(29004);
  });

  it('records plain input/output when both cache detail fields are zero', () => {
    const metrics = createUsageMetrics();
    foldExclusiveUsage(metrics, 14, 5, 0, 0);
    expect(metrics.inputTokens).toBe(14);
    expect(metrics.outputTokens).toBe(5);
    expect(metrics.cacheCreationInputTokens).toBe(0);
    expect(metrics.cacheReadInputTokens).toBe(0);
  });
});

/**
 * noteExtraUsage: the hosted-tool continuation loop's own accumulator (T4b).
 *
 * `req.__responsesExtraUsage` is fed OpenAI-INCLUSIVE usage — native deployment
 * frames are inclusive by OpenAI's own semantics, and bridge continuation
 * frames are always post-`translateUsage`, which normalizes SAP's exclusive
 * counting into the same inclusive shape before the engine ever sees it — so
 * one normalization here is correct for both callers.
 */
describe('noteExtraUsage', () => {
  it('bills only the full-rate remainder for a round over a cached prefix (21,292-token cache read, 14 full-rate)', () => {
    const req: any = { __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 } };
    noteExtraUsage(req, {
      input_tokens: 21306,
      output_tokens: 8,
      input_tokens_details: { cached_tokens: 21292, cache_creation_tokens: 0 },
    });
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 14,
      output_tokens: 8,
      cache_creation_tokens: 0,
      cache_read_tokens: 21292,
    });
  });

  it('counts the REAL Responses API cache-write field, cache_write_tokens — the regression this fix addresses (previously read as 0)', () => {
    const req: any = { __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 } };
    noteExtraUsage(req, {
      input_tokens: 30000,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 29000 },
    });
    // Before the fix, `cache_write_tokens` was not read at all, so creationTokens stayed 0,
    // fullRateInput was max(0, 30000 - 0 - 0) = 30000, and the accumulator's cache_creation_tokens
    // key stayed 0 too. The fix must produce 1000 and 29000 respectively.
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 1000,
      output_tokens: 50,
      cache_creation_tokens: 29000,
      cache_read_tokens: 0,
    });
  });

  it('prefers cache_write_tokens over a legacy cache_creation_tokens on the same object', () => {
    const req: any = { __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 } };
    noteExtraUsage(req, {
      input_tokens: 30000,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 29000, cache_creation_tokens: 1 },
    });
    expect(req.__responsesExtraUsage.cache_creation_tokens).toBe(29000);
  });

  it('degrades to raw input when the round carries no input_tokens_details (today\'s pre-split behaviour)', () => {
    const req: any = { __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 } };
    noteExtraUsage(req, { input_tokens: 100, output_tokens: 20 });
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
  });

  it('does not throw when a plugin has replaced the accumulator with a 2-field literal', () => {
    const req: any = { __responsesExtraUsage: { input_tokens: 5, output_tokens: 1 } };
    expect(() => noteExtraUsage(req, {
      input_tokens: 21306,
      output_tokens: 8,
      input_tokens_details: { cached_tokens: 21292 },
    })).not.toThrow();
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 5 + 14,
      output_tokens: 1 + 8,
      cache_creation_tokens: 0,
      cache_read_tokens: 21292,
    });
  });

  it('clamps PER ROUND, not clamp-on-sum — the codex steady state where one round\'s cache exceeds that round\'s input', () => {
    const req: any = { __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 } };

    // Round A: a cached-prefix read. Full-rate remainder = max(0, 21306 - 21292 - 0) = 14.
    noteExtraUsage(req, {
      input_tokens: 21306, output_tokens: 8,
      input_tokens_details: { cached_tokens: 21292, cache_creation_tokens: 0 },
    });
    // Round B: a fresh cache-WRITE turn (no read this round). Full-rate remainder =
    // max(0, 30000 - 0 - 29000) = 1000.
    noteExtraUsage(req, {
      input_tokens: 30000, output_tokens: 50,
      input_tokens_details: { cached_tokens: 0, cache_creation_tokens: 29000 },
    });

    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 1014,     // 14 + 1000
      output_tokens: 58,      // 8 + 50
      cache_creation_tokens: 29000,
      cache_read_tokens: 21292,
    });

    // Why per-round clamping is load-bearing, not a style choice: take a variant where
    // ONE round's cache count exceeds THAT round's raw input (e.g. a round whose
    // input_tokens undercounts relative to cached_tokens for whatever upstream reason).
    // Round X: input 100, cached 200 -> per-round remainder max(0, 100-200) = 0.
    // Round Y: input 100, cached 0   -> per-round remainder 100.
    // Correct (per-round then sum):      0 + 100 = 100.
    // Wrong (sum-then-clamp):  raw sum 200, cached sum 200 -> max(0, 200-200) = 0.
    // Clamp-on-sum silently erases the 100 real full-rate tokens round Y actually cost —
    // exactly the historical `foldExclusiveUsage` bug this design deliberately avoids by
    // never summing raw numbers across rounds before clamping. Exercised for real below,
    // not just asserted in prose: the numbers above are exactly what this test drives.
  });

  it('the variant above, executed: per-round clamping preserves round Y\'s 100 real tokens that clamp-on-sum would erase', () => {
    const req: any = { __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 } };

    // Round X: cache count (200) exceeds this round's own raw input (100). Per-round
    // remainder clamps to max(0, 100 - 200) = 0 — this round contributes nothing to
    // input_tokens, only its 200 to cache_read_tokens.
    noteExtraUsage(req, {
      input_tokens: 100, output_tokens: 1,
      input_tokens_details: { cached_tokens: 200, cache_creation_tokens: 0 },
    });
    // Round Y: no cache activity at all. Per-round remainder is the full 100.
    noteExtraUsage(req, { input_tokens: 100, output_tokens: 1 });

    // Correct: 0 (round X, clamped) + 100 (round Y) = 100. A clamp-on-sum implementation
    // would instead sum the RAW remainders first — (100 - 200) + (100 - 0) = 0 — and
    // clamp that single number to 0, silently erasing round Y's 100 real full-rate
    // tokens. This is exactly the assertion a mutation moving the clamp to the fold site
    // (summing before clamping instead of clamping every round) must fail.
    expect(req.__responsesExtraUsage.input_tokens).toBe(100);
    expect(req.__responsesExtraUsage.cache_read_tokens).toBe(200);
  });
});

/**
 * The regime of an SAP orchestration `usage` object is a property of the MODEL FAMILY behind
 * orchestration, not of the endpoint: Claude reports `prompt_tokens` EXCLUSIVE of the cache
 * counts (cache-probe-result.md, 2026-08-07), gpt-4.1-nano reports it INCLUSIVE, OpenAI's own
 * convention (probe of 2026-09-30: prompt_tokens 1978 flat while cached_tokens went
 * 0 -> 1792). Every orchestration fold site goes through `foldOrchestrationUsageFor`, so the
 * choice is made in one place.
 */
describe('cacheRegimeFor / foldOrchestrationUsageFor', () => {
  it('Claude names are exclusive, whatever form the name arrives in', () => {
    for (const name of [
      'anthropic--claude-4.8-opus', 'anthropic--claude-4.5-sonnet', 'claude-opus-4-8',
      'claude-sonnet-4-5-20250929', 'anthropic/claude-sonnet-4', 'ANTHROPIC--CLAUDE-4-OPUS',
    ]) {
      expect(cacheRegimeFor(name)).toBe('exclusive');
    }
  });

  it('OpenAI-family and every other (unmeasured) family is inclusive, as is a missing name', () => {
    for (const name of ['gpt-4.1-nano', 'gpt-4.1', 'gpt-5-mini', 'o3', 'o4-mini', 'gemini-2.5-pro', 'mistralai--mistral-large-instruct', undefined, '']) {
      expect(cacheRegimeFor(name)).toBe('inclusive');
    }
  });

  it('gpt-4.1-nano read turn (live probe numbers): full-rate input is prompt - cached, cache billed once', () => {
    const m: any = createUsageMetrics();
    foldOrchestrationUsageFor('gpt-4.1-nano', m, 1978, 1, 0, 1792);
    expect(m.inputTokens).toBe(186);
    expect(m.outputTokens).toBe(1);
    expect(m.cacheReadInputTokens).toBe(1792);
    expect(m.cacheCreationInputTokens).toBe(0);
  });

  it('inclusive source with a cache write: input = max(0, prompt - cached - creation)', () => {
    const m: any = createUsageMetrics();
    foldOrchestrationUsageFor('gpt-5-mini', m, 1000, 3, 300, 600);
    expect(m.inputTokens).toBe(100);
    expect(m.cacheCreationInputTokens).toBe(300);
    expect(m.cacheReadInputTokens).toBe(600);
  });

  it('Claude with the same raw numbers keeps the exclusive fold: nothing subtracted', () => {
    const m: any = createUsageMetrics();
    foldOrchestrationUsageFor('anthropic--claude-4.8-opus', m, 1978, 1, 0, 1792);
    expect(m.inputTokens).toBe(1978);
    expect(m.cacheReadInputTokens).toBe(1792);
  });

  it('fullRatePromptTokens / wholePromptTokens convert SAP prompt_tokens to each convention per model', () => {
    expect(fullRatePromptTokens('gpt-4.1-nano', 1978, 0, 1792)).toBe(186);
    expect(fullRatePromptTokens('anthropic--claude-4.8-opus', 14, 500, 29004)).toBe(14);
    expect(wholePromptTokens('gpt-4.1-nano', 1978, 0, 1792)).toBe(1978);
    expect(wholePromptTokens('anthropic--claude-4.8-opus', 14, 500, 29004)).toBe(29518);
  });
});

/**
 * Amazon Nova behind SAP orchestration is EXCLUSIVE, like Claude (re-probe of 2026-09-30,
 * amazon--nova-lite with a `cache_control` checkpoint): the write turn reported prompt_tokens 7
 * with cache_creation_tokens 9811 (total_tokens 9822), the read turn prompt_tokens 7 with
 * cached_tokens 9811. Folded inclusive, max(0, 7 - 9811) = 0 dropped the whole uncached tail.
 */
/**
 * The remaining re-probe measurements of 2026-09-30, pinned as billed numbers under the SAP model
 * names (usage blocks from `03_sap_response_raw`). Gemini is the only Gemini regime pin: a future
 * name key that swept it into the exclusive list would fail here.
 */
describe('measured regimes of the 2026-09-30 re-probe', () => {
  it('gpt-5-nano (INCLUSIVE): prompt 1982 flat, cached 0 -> 1920 bills 62 + cache read 1920', () => {
    const cold: any = createUsageMetrics();
    foldOrchestrationUsageFor('gpt-5-nano', cold, 1982, 1, 0, 0);
    expect(cold).toMatchObject({ inputTokens: 1982, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    const hit: any = createUsageMetrics();
    foldOrchestrationUsageFor('gpt-5-nano', hit, 1982, 1, 0, 1920);
    expect(hit).toMatchObject({ inputTokens: 62, cacheReadInputTokens: 1920, cacheCreationInputTokens: 0 });
  });

  it('gemini-2.5-flash-lite (INCLUSIVE): prompt 2062 flat, cached 0 -> 2034 bills 28 + cache read 2034', () => {
    expect(cacheRegimeFor('gemini-2.5-flash-lite')).toBe('inclusive');
    const cold: any = createUsageMetrics();
    foldOrchestrationUsageFor('gemini-2.5-flash-lite', cold, 2062, 1, 0, 0);
    expect(cold).toMatchObject({ inputTokens: 2062, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    const hit: any = createUsageMetrics();
    foldOrchestrationUsageFor('gemini-2.5-flash-lite', hit, 2062, 1, 0, 2034);
    expect(hit).toMatchObject({ inputTokens: 28, cacheReadInputTokens: 2034, cacheCreationInputTokens: 0 });
  });

  it('anthropic--claude-4.5-haiku (EXCLUSIVE): 13 + cache write 11266, then 13 + cache read 11266', () => {
    const write: any = createUsageMetrics();
    foldOrchestrationUsageFor('anthropic--claude-4.5-haiku', write, 13, 4, 11266, 0);
    expect(write).toMatchObject({ inputTokens: 13, cacheCreationInputTokens: 11266, cacheReadInputTokens: 0 });
    const read: any = createUsageMetrics();
    foldOrchestrationUsageFor('anthropic--claude-4.5-haiku', read, 13, 4, 0, 11266);
    expect(read).toMatchObject({ inputTokens: 13, cacheReadInputTokens: 11266, cacheCreationInputTokens: 0 });
  });
});

describe('Amazon Nova and the prompt-smaller-than-cache safety net', () => {
  it('Nova names are exclusive in every form they arrive in', () => {
    for (const name of ['amazon--nova-lite', 'amazon--nova-micro', 'amazon--nova-pro', 'amazon--nova-lite--deployed', 'amazon.nova-lite-v1:0', 'us.amazon.nova-pro-v1:0']) {
      expect(cacheRegimeFor(name)).toBe('exclusive');
    }
  });

  it('Nova write turn (probe numbers): bills input 7 and cache write 9811', () => {
    const m: any = createUsageMetrics();
    foldOrchestrationUsageFor('amazon--nova-lite', m, 7, 4, 9811, 0);
    expect(m.inputTokens).toBe(7);
    expect(m.outputTokens).toBe(4);
    expect(m.cacheCreationInputTokens).toBe(9811);
    expect(m.cacheReadInputTokens).toBe(0);
  });

  it('Nova read turn (probe numbers): bills input 7 and cache read 9811', () => {
    const m: any = createUsageMetrics();
    foldOrchestrationUsageFor('amazon--nova-lite', m, 7, 4, 0, 9811);
    expect(m.inputTokens).toBe(7);
    expect(m.cacheReadInputTokens).toBe(9811);
    expect(m.cacheCreationInputTokens).toBe(0);
  });

  it('Nova read turn converts to both conventions: full-rate 7, whole prompt 9818', () => {
    expect(fullRatePromptTokens('amazon--nova-lite', 7, 0, 9811)).toBe(7);
    expect(wholePromptTokens('amazon--nova-lite', 7, 0, 9811)).toBe(9818);
  });

  it('safety net: an unlisted model whose prompt is smaller than its cache is folded exclusive', () => {
    // Inclusive means prompt_tokens >= cached + creation by definition, so 7 < 9811 can only be
    // an exclusive source, whatever the name says.
    expect(cacheRegimeFor('some--new-model')).toBe('inclusive');
    expect(cacheRegimeForUsage('some--new-model', 7, 0, 9811)).toBe('exclusive');
    const m: any = createUsageMetrics();
    foldOrchestrationUsageFor('some--new-model', m, 7, 4, 0, 9811);
    expect(m.inputTokens).toBe(7);
    expect(m.cacheReadInputTokens).toBe(9811);
    expect(fullRatePromptTokens('some--new-model', 7, 0, 9811)).toBe(7);
    expect(wholePromptTokens('some--new-model', 7, 0, 9811)).toBe(9818);
    // A cache write counts toward the comparison too.
    expect(cacheRegimeForUsage('some--new-model', 7, 9811, 0)).toBe('exclusive');
  });

  it('safety net: an inclusive usage (prompt >= cached + creation) stays inclusive', () => {
    expect(cacheRegimeForUsage('gpt-4.1-nano', 1978, 0, 1792)).toBe('inclusive');
    expect(cacheRegimeForUsage('gpt-5-mini', 900, 300, 600)).toBe('inclusive');   // equal: still inclusive
    const m: any = createUsageMetrics();
    foldOrchestrationUsageFor('gpt-4.1-nano', m, 1978, 1, 0, 1792);
    expect(m.inputTokens).toBe(186);
    expect(wholePromptTokens('gpt-4.1-nano', 1978, 0, 1792)).toBe(1978);
  });

  it('safety net never turns a Claude usage inclusive', () => {
    expect(cacheRegimeForUsage('anthropic--claude-4.8-opus', 29518, 0, 14)).toBe('exclusive');
  });
});
