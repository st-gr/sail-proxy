# Anthropic Beta Header Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop SAP AI Core HTTP 400 "invalid beta flag" failures by adding a configurable, hot-reloadable `anthropic.supported_beta_headers` allowlist for outbound `anthropic_beta` flags, make any future SAP 4xx rejection diagnosable via error-payload logging, self-heal at runtime by quarantining flags SAP rejects (in-memory, per model) so the next request succeeds, and make payload logging a pure `api_config.json` toggle (no `DEBUG` env var required).

**Architecture:** A new pure utility module (`betaFeatureFilter.ts`) owns parse/merge/filter logic and is unit-tested directly with no mocks. `configService` gains a `getSupportedBetaHeaders()` getter (reads dynamic config per call → hot-reloadable by construction, same as the existing `getExcludedBetaHeaders()`). `awsBedrockService.processBedrockRequest` replaces its inline beta-header logic with one call path that filters **all** sources of beta flags (client header, client body, `inject_beta_features`) through allowlist-then-denylist. Error catch blocks are fixed to actually emit `error.response.data` (today it is passed in the `Error`-typed third argument of `logger.error`, which serializes only `name/message/stack` — all `undefined` for a plain object, so the SAP error body is silently dropped) and to persist it via `payloadLogger.savePayload`. Finally, the two hard `DEBUG` env gates in front of payload logging (`payloadLogger.ts:144` and `debugRequestId` generation in `awsBedrockController.ts:41`) are removed so `logging.payload_logging_enabled` in `api_config.json` becomes the single live switch — shipped default `false`, so default behavior is unchanged.

**Tech Stack:** TypeScript, Express, Jest (`services/gateway/jest.config.json`), JSON Schema (admin config validation), pnpm workspace.

## Global Constraints

- **Live product — no default behavior change when `supported_beta_headers` is unset/empty.** Denylist-only deployments must behave byte-identically.
- **Hot-reloadable:** all new switches come from `configService.getConfig()` (dynamic config), never from env vars; no restart required.
- **`api_config.json` is stored in three synced copies.** Source of truth: `services/gateway/api_config.json`. Never hand-edit `services/admin/api_config.json` or `npm-dist/sail-proxy/src/templates/api_config.template.json` — the pre-commit hook (`cli-tools/pre-commit-checks.js` → `cli-tools/sync-api-config.js`) overwrites them from the gateway copy. Edit gateway, then run `node cli-tools/sync-api-config.js` after staging (or let the hook do it).
- **Commit messages: no Claude Code attribution.** Author is st-gr only; no `Co-Authored-By` / "Generated with Claude Code" footers.
- **Logger signature trap:** `logger.error(component, message, error?: Error, metadata?: any)` — the 3rd parameter is serialized as `{name, message, stack}` only. Arbitrary objects (like an Axios `error.response.data`) must go in the **4th** (metadata) parameter or they are dropped.
- Tests run from `services/gateway/`: `npm test -- --testPathPattern="<pattern>"` (wraps `cross-env NODE_ENV=test jest --config jest.config.json`).
- Typecheck: `cd services/gateway && npx tsc --noEmit -p tsconfig.json`.

## Background (verified against code on 2026-07-07)

- `services/gateway/src/services/awsBedrockService.ts:149-185` (`processBedrockRequest`): copies the client's `anthropic-beta` header into `processedRequestBody.anthropic_beta`, filtered **only** by the denylist `configService.getExcludedBetaHeaders()`. Then `inject_beta_features` from model config are appended **unfiltered**. A client body-supplied `anthropic_beta` array (when no header is present) passes through **completely unfiltered** today.
- Denylist source: `configService.ts:1096-1104` reads `api_config.anthropic.excluded_beta_headers` from dynamic config.
- Config file anthropic block: `services/gateway/api_config.json:1487-1493` (currently 3 excluded headers, including `thinking-token-count-2026-05-13` added in commit `e9e1e8d`).
- Admin schema: `services/admin/src/schemas/api-config-schema.json` — provider entries `anthropic`/`aws-bedrock` use `$defs/providerConfig` (line 371-408, `additionalProperties: true`; neither `excluded_beta_headers` nor `supported_beta_headers` is declared yet).
- Error handling: `awsBedrockService.ts:396` (native) and `:498` (emulated) pass `error.response.data` as the `Error`-typed 3rd arg of `logger.error` → dropped. Compare the correct pattern already used at `:1187`: `logger.error('AwsBedrockService', 'Error details:', undefined, { data: error.response.data })`.
- Existing test `services/gateway/test/beta-header-filtering.test.ts` tests a **local re-implementation** of the filter (lines 38-40), not production code. It also asserts the real config contains `prompt-caching-scope-2026-01-05`.
- Empirical evidence from `services/gateway/logs/payloads` (236 correlated requests, analyzed 2026-07-07 — see the table in Task 6): SAP accepts 8 distinct flags observed in live traffic and rejects `thinking-token-count-2026-05-13` (0/4, pre-denylist) and `structured-outputs-2025-12-15` (0/8 on 2026-07-06..07 — **failing in production right now**, missed by the current denylist). Claude Code also sporadically sends `fallback-credit-2026-06-01` (2×), never observed reaching SAP — support unknown, deliberately left off the allowlist (will be dropped, fail-safe).
- There is no `services/gateway/README.md`; the "Excluded Beta Headers" documentation lives in the repo-root `README.md` (~line 616).

## Semantics being implemented (single source of truth for all tasks)

1. Collect candidate flags for invoke subpaths: client `anthropic-beta` header if present, **else** client body `anthropic_beta` (preserves today's header-overwrites-body precedence); then merge `modelDetails.inject_beta_features` (deduped, order-preserving).
2. If `supported_beta_headers` is present **and non-empty**: keep only flags in it (allowlist).
3. Then apply `excluded_beta_headers` (denylist) **plus the runtime quarantine for this model** (Task 8: flags SAP previously rejected with an "invalid beta flag" 400; in-memory, resets on restart) on top — a flag in any of these is dropped.
4. If the final list is empty, `anthropic_beta` is **not set** (and removed if the body carried one).
5. Allowlist absent or empty array ⇒ step 2 is skipped ⇒ current behavior, except that body-supplied and injected flags now also pass the denylist and quarantine (closes the misconfig loophole — spec item 2 — and gives denylist-only deployments self-healing too).

---

### Task 1: Pure beta-feature filter utility

**Files:**
- Create: `services/gateway/src/utils/betaFeatureFilter.ts`
- Test: `services/gateway/test/beta-feature-filter.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no imports).
- Produces (used verbatim by Tasks 3 and 6):
  - `interface BetaFilterOptions { supported: string[]; excluded: string[] }`
  - `parseAnthropicBetaHeader(headerValue: string | string[] | undefined): string[]`
  - `mergeBetaFeatures(...lists: string[][]): string[]`
  - `filterBetaFeatures(features: string[], options: BetaFilterOptions): string[]`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/beta-feature-filter.test.ts`:

```typescript
/**
 * Beta Feature Filter Tests
 *
 * Tests the pure filtering logic used by awsBedrockService to decide which
 * anthropic_beta flags are forwarded to SAP AI Core.
 *
 * Semantics:
 * - allowlist (supported): when non-empty, only listed flags survive
 * - denylist (excluded): always applied on top of the allowlist
 * - empty allowlist === allowlist absent === no allowlist filtering
 */
import { describe, it, expect } from '@jest/globals';
import {
  parseAnthropicBetaHeader,
  mergeBetaFeatures,
  filterBetaFeatures
} from '../src/utils/betaFeatureFilter';

describe('parseAnthropicBetaHeader', () => {
  it('parses a comma-separated string with whitespace', () => {
    expect(parseAnthropicBetaHeader('a-1, b-2 ,c-3')).toEqual(['a-1', 'b-2', 'c-3']);
  });

  it('parses an array of header values, splitting embedded commas', () => {
    expect(parseAnthropicBetaHeader(['a-1,b-2', 'c-3'])).toEqual(['a-1', 'b-2', 'c-3']);
  });

  it('returns [] for undefined or empty input', () => {
    expect(parseAnthropicBetaHeader(undefined)).toEqual([]);
    expect(parseAnthropicBetaHeader('')).toEqual([]);
    expect(parseAnthropicBetaHeader([])).toEqual([]);
  });

  it('drops empty segments from trailing/duplicate commas', () => {
    expect(parseAnthropicBetaHeader('a-1,,b-2,')).toEqual(['a-1', 'b-2']);
  });
});

describe('mergeBetaFeatures', () => {
  it('merges lists preserving order and deduplicating', () => {
    expect(mergeBetaFeatures(['a', 'b'], ['b', 'c'], ['a', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns [] when all lists are empty', () => {
    expect(mergeBetaFeatures([], [])).toEqual([]);
  });
});

describe('filterBetaFeatures', () => {
  const CLAUDE_CODE_FLAGS = [
    'claude-code-20250219',
    'context-1m-2025-08-07',
    'interleaved-thinking-2025-05-14',
    'thinking-token-count-2026-05-13',
    'context-management-2025-06-27',
    'effort-2025-11-24'
  ];

  it('denylist-only: behaves exactly like today (allowlist empty)', () => {
    const result = filterBetaFeatures(CLAUDE_CODE_FLAGS, {
      supported: [],
      excluded: ['thinking-token-count-2026-05-13']
    });
    expect(result).toEqual([
      'claude-code-20250219',
      'context-1m-2025-08-07',
      'interleaved-thinking-2025-05-14',
      'context-management-2025-06-27',
      'effort-2025-11-24'
    ]);
  });

  it('no lists configured: passthrough unchanged', () => {
    const result = filterBetaFeatures(CLAUDE_CODE_FLAGS, { supported: [], excluded: [] });
    expect(result).toEqual(CLAUDE_CODE_FLAGS);
  });

  it('allowlist filtering: only allowlisted flags survive', () => {
    const result = filterBetaFeatures(CLAUDE_CODE_FLAGS, {
      supported: ['context-1m-2025-08-07', 'interleaved-thinking-2025-05-14'],
      excluded: []
    });
    expect(result).toEqual(['context-1m-2025-08-07', 'interleaved-thinking-2025-05-14']);
  });

  it('allowlist + denylist: denylist wins over allowlist', () => {
    const result = filterBetaFeatures(CLAUDE_CODE_FLAGS, {
      supported: ['context-1m-2025-08-07', 'thinking-token-count-2026-05-13'],
      excluded: ['thinking-token-count-2026-05-13']
    });
    expect(result).toEqual(['context-1m-2025-08-07']);
  });

  it('returns [] when allowlist excludes everything', () => {
    const result = filterBetaFeatures(['unknown-flag-2026-01-01'], {
      supported: ['context-1m-2025-08-07'],
      excluded: []
    });
    expect(result).toEqual([]);
  });

  it('injected-feature scenario: injected flags are also subject to the allowlist', () => {
    // Simulates a misconfigured inject_beta_features reintroducing an unsupported flag
    const headerFlags = ['claude-code-20250219'];
    const injected = ['context-1m-2025-08-07', 'not-supported-by-sap-2026-01-01'];
    const merged = mergeBetaFeatures(headerFlags, injected);
    const result = filterBetaFeatures(merged, {
      supported: ['claude-code-20250219', 'context-1m-2025-08-07'],
      excluded: []
    });
    expect(result).toEqual(['claude-code-20250219', 'context-1m-2025-08-07']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/gateway && npm test -- --testPathPattern="beta-feature-filter"`
Expected: FAIL — `Cannot find module '../src/utils/betaFeatureFilter'`

- [ ] **Step 3: Write minimal implementation**

Create `services/gateway/src/utils/betaFeatureFilter.ts`:

```typescript
/**
 * Pure helpers for assembling and filtering anthropic_beta feature flags
 * before forwarding requests to SAP AI Core Bedrock deployments.
 *
 * Filtering semantics:
 * 1. Allowlist (supported): when non-empty, only listed flags survive.
 *    An empty/absent allowlist means "no allowlist filtering" (legacy behavior).
 * 2. Denylist (excluded): always applied on top of the allowlist result.
 *
 * @see api_config.json - anthropic.supported_beta_headers / anthropic.excluded_beta_headers
 */

export interface BetaFilterOptions {
  /** Allowlist from api_config.anthropic.supported_beta_headers; [] disables allowlist filtering */
  supported: string[];
  /** Denylist from api_config.anthropic.excluded_beta_headers */
  excluded: string[];
}

/**
 * Parse the raw anthropic-beta header value into a clean array of flags.
 * Accepts a comma-separated string, an array of values (each possibly
 * comma-separated), or undefined.
 */
export function parseAnthropicBetaHeader(headerValue: string | string[] | undefined): string[] {
  if (!headerValue) {
    return [];
  }
  const rawValues = Array.isArray(headerValue) ? headerValue : [headerValue];
  return rawValues
    .flatMap(value => String(value).split(','))
    .map(flag => flag.trim())
    .filter(Boolean);
}

/**
 * Merge multiple flag lists, preserving first-seen order and deduplicating.
 */
export function mergeBetaFeatures(...lists: string[][]): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const flag of list) {
      if (!merged.includes(flag)) {
        merged.push(flag);
      }
    }
  }
  return merged;
}

/**
 * Apply allowlist-then-denylist filtering to a list of beta flags.
 */
export function filterBetaFeatures(features: string[], options: BetaFilterOptions): string[] {
  let result = features;
  if (options.supported.length > 0) {
    result = result.filter(flag => options.supported.includes(flag));
  }
  if (options.excluded.length > 0) {
    result = result.filter(flag => !options.excluded.includes(flag));
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/gateway && npm test -- --testPathPattern="beta-feature-filter"`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/utils/betaFeatureFilter.ts services/gateway/test/beta-feature-filter.test.ts
git commit -m "feat(gateway): add pure beta-feature allowlist/denylist filter util"
```

---

### Task 2: `configService.getSupportedBetaHeaders()`

**Files:**
- Modify: `services/gateway/src/services/configService.ts:1104` (insert after `getExcludedBetaHeaders`) and `:1436` (default export list)
- Test: `services/gateway/test/beta-header-filtering.test.ts` (extend existing file)

**Interfaces:**
- Consumes: internal `getConfig()` (already in the module).
- Produces: `getSupportedBetaHeaders(): string[]` — returns `api_config.anthropic.supported_beta_headers` or `[]`; exported on the `configService` default object. Task 3 calls `configService.getSupportedBetaHeaders()`.

- [ ] **Step 1: Write the failing test**

In `services/gateway/test/beta-header-filtering.test.ts`, add after the `configService.getExcludedBetaHeaders` describe block (after line 35):

```typescript
  describe('configService.getSupportedBetaHeaders', () => {
    it('returns an array of strings (empty when the key is absent)', () => {
      const supported = configService.getSupportedBetaHeaders();
      expect(Array.isArray(supported)).toBe(true);
      supported.forEach(flag => expect(typeof flag).toBe('string'));
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/gateway && npm test -- --testPathPattern="beta-header-filtering"`
Expected: FAIL — `configService.getSupportedBetaHeaders is not a function` (TypeScript may fail compilation first with "Property 'getSupportedBetaHeaders' does not exist" — either failure mode is the expected red)

- [ ] **Step 3: Write minimal implementation**

In `services/gateway/src/services/configService.ts`, insert directly after the `getExcludedBetaHeaders` function (after line 1104):

```typescript
/**
 * Get supported (allowlisted) beta headers for Anthropic requests to SAP AI Core.
 * When non-empty, only these beta flags are forwarded; the excluded_beta_headers
 * denylist is still applied on top. Empty/absent means no allowlist filtering.
 * @returns Array of allowlisted beta header values
 */
export const getSupportedBetaHeaders = (): string[] => {
  try {
    const config = getConfig();
    return config?.api_config?.anthropic?.supported_beta_headers || [];
  } catch (error: any) {
    logger.error('ConfigService', `Error getting supported beta headers: ${error.message}`);
    return [];
  }
};
```

In the default export object (line 1436 area), add one line after `getExcludedBetaHeaders,`:

```typescript
  getExcludedBetaHeaders,
  getSupportedBetaHeaders,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/gateway && npm test -- --testPathPattern="beta-header-filtering"`
Expected: PASS (all existing tests + the new one)

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/services/configService.ts services/gateway/test/beta-header-filtering.test.ts
git commit -m "feat(gateway): add getSupportedBetaHeaders config getter (hot-reloadable)"
```

---

### Task 3: Wire allowlist filtering into `awsBedrockService`

**Files:**
- Modify: `services/gateway/src/services/awsBedrockService.ts:149-185` (inside `processBedrockRequest`) and the import block at the top (after line 12)

**Interfaces:**
- Consumes: `parseAnthropicBetaHeader`, `mergeBetaFeatures`, `filterBetaFeatures`, `BetaFilterOptions` from Task 1; `configService.getSupportedBetaHeaders()` from Task 2.
- Produces: no new exports — `processedRequestBody.anthropic_beta` is now the filtered result of header ∪ body ∪ injected flags, or absent when the result is empty.

**Behavior deltas to be aware of (all intentional, all fail-safe):**
- Injected `inject_beta_features` now pass through allowlist+denylist (spec item 2). With today's shipped config (denylist has no injected flag; allowlist unset) output is unchanged.
- Body-supplied `anthropic_beta` (used only when no header is present) is now filtered too; previously it bypassed the denylist entirely.
- If everything is filtered out, `anthropic_beta` is removed rather than sent as `[]`.

- [ ] **Step 1: Add the import**

In `services/gateway/src/services/awsBedrockService.ts`, after line 12 (`import { emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';`), add:

```typescript
import { parseAnthropicBetaHeader, mergeBetaFeatures, filterBetaFeatures } from '../utils/betaFeatureFilter';
```

- [ ] **Step 2: Replace the inline beta logic**

Replace lines 149-185 (from the comment `// Add anthropic_beta from header if present…` through the closing `}` of the `inject_beta_features` block, i.e. this exact current code):

```typescript
    // Add anthropic_beta from header if present (for beta features like extended thinking)
    const anthropicBetaHeader = options.headers['anthropic-beta'];
    if (anthropicBetaHeader && isInvokeSubpath) {
      // Bedrock expects anthropic_beta as an array of strings
      let betaFeatures = typeof anthropicBetaHeader === 'string'
        ? anthropicBetaHeader.split(',').map(s => s.trim())
        : Array.isArray(anthropicBetaHeader) ? anthropicBetaHeader : [];

      // Filter out unsupported beta headers based on configuration
      const excludedBetaHeaders = configService.getExcludedBetaHeaders();
      if (excludedBetaHeaders.length > 0) {
        const originalCount = betaFeatures.length;
        betaFeatures = betaFeatures.filter(feature => !excludedBetaHeaders.includes(feature));

        if (betaFeatures.length !== originalCount) {
          const filtered = originalCount - betaFeatures.length;
          logger.debug('AwsBedrockService', `Filtered ${filtered} unsupported beta feature(s): ${excludedBetaHeaders.filter(h => !betaFeatures.includes(h)).join(', ')}`);
        }
      }

      if (betaFeatures.length > 0) {
        processedRequestBody.anthropic_beta = betaFeatures;
        logger.debug('AwsBedrockService', `Adding anthropic_beta features: ${betaFeatures.join(', ')}`);
      }
    }
    // Inject model-specific beta features from configuration (e.g., context-1m for Opus/Sonnet 4.6)
    if (isInvokeSubpath && modelDetails.inject_beta_features && Array.isArray(modelDetails.inject_beta_features)) {
      if (!processedRequestBody.anthropic_beta) {
        processedRequestBody.anthropic_beta = [];
      }
      for (const feature of modelDetails.inject_beta_features) {
        if (!processedRequestBody.anthropic_beta.includes(feature)) {
          processedRequestBody.anthropic_beta.push(feature);
        }
      }
      logger.debug('AwsBedrockService', `Injected model-specific beta features: ${modelDetails.inject_beta_features.join(', ')}`);
    }
```

with:

```typescript
    // Assemble anthropic_beta for invoke subpaths from all sources, then filter
    // through the configured allowlist (supported_beta_headers) and denylist
    // (excluded_beta_headers) so no unsupported flag can reach SAP AI Core —
    // including flags injected via inject_beta_features or supplied in the body.
    if (isInvokeSubpath) {
      const headerFeatures = parseAnthropicBetaHeader(options.headers['anthropic-beta']);
      // Header takes precedence over a body-supplied anthropic_beta (legacy behavior);
      // body flags are now filtered too instead of passing through untouched.
      const bodyFeatures = headerFeatures.length === 0 && Array.isArray(processedRequestBody.anthropic_beta)
        ? processedRequestBody.anthropic_beta.map(String)
        : [];
      const injectedFeatures = Array.isArray(modelDetails.inject_beta_features)
        ? modelDetails.inject_beta_features.map(String)
        : [];

      const candidates = mergeBetaFeatures(headerFeatures, bodyFeatures, injectedFeatures);
      const filterOptions = {
        supported: configService.getSupportedBetaHeaders(),
        excluded: configService.getExcludedBetaHeaders()
      };
      const betaFeatures = filterBetaFeatures(candidates, filterOptions);

      const dropped = candidates.filter(feature => !betaFeatures.includes(feature));
      if (dropped.length > 0) {
        logger.debug('AwsBedrockService', `Filtered ${dropped.length} unsupported beta feature(s): ${dropped.join(', ')}`);
      }
      if (injectedFeatures.length > 0) {
        logger.debug('AwsBedrockService', `Injected model-specific beta features: ${injectedFeatures.join(', ')}`);
      }

      if (betaFeatures.length > 0) {
        processedRequestBody.anthropic_beta = betaFeatures;
        logger.debug('AwsBedrockService', `Adding anthropic_beta features: ${betaFeatures.join(', ')}`);
      } else {
        delete processedRequestBody.anthropic_beta;
      }
    }
```

- [ ] **Step 3: Typecheck and run the full gateway suite**

Run: `cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test`
Expected: typecheck clean; all suites PASS (the filter semantics themselves are covered by Task 1's tests against the same functions this code calls)

- [ ] **Step 4: Commit**

```bash
git add services/gateway/src/services/awsBedrockService.ts
git commit -m "feat(gateway): filter all anthropic_beta sources through allowlist/denylist"
```

---

### Task 4: Make SAP 4xx rejections diagnosable

**Files:**
- Modify: `services/gateway/src/services/awsBedrockService.ts:393-399` (native catch) and `:492-501` (emulated catch) — line numbers are pre-Task-3; after Task 3 the blocks shift by ~+8 lines. Locate them by searching for `SAP AI Core error response`.

**Interfaces:**
- Consumes: `payloadLogger.savePayload(requestId, stage, data, req?, res?)` (already imported); `debugRequestId`, `req`, `res` are in scope in both catch blocks (used at the `03_native_response_from_sap` / `03_emulated_response_from_sap` save sites above them).
- Produces: new payload-log stages `03_native_error_from_sap` and `03_emulated_error_from_sap`; SAP error bodies now appear in structured logs under `metadata.data`.

**Why:** `logger.error(component, message, error?: Error, metadata?: any)` serializes the 3rd argument as `{name, message, stack}` — for a plain Axios `error.response.data` object those are all `undefined`, so today the SAP error body (which names the rejected beta flag) is dropped from the logs.

- [ ] **Step 1: Fix the native catch block**

Replace (currently at `awsBedrockService.ts:393-399`):

```typescript
  } catch (error: any) {
    logger.error('AwsBedrockService', `Error in native request: ${error.message}`);
    if (error.response) {
      logger.error('AwsBedrockService', `SAP AI Core error response: ${error.response.status}`, error.response.data);
    }
    throw error;
  }
```

with:

```typescript
  } catch (error: any) {
    logger.error('AwsBedrockService', `Error in native request: ${error.message}`);
    if (error.response) {
      logger.error('AwsBedrockService', `SAP AI Core error response: ${error.response.status}`, undefined, { data: error.response.data });
      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '03_native_error_from_sap', {
          status: error.response.status,
          data: error.response.data
        }, req, res);
      }
    }
    throw error;
  }
```

- [ ] **Step 2: Fix the emulated catch block**

Replace (currently at `awsBedrockService.ts:492-501`):

```typescript
  } catch (error: any) {
    logger.error('AwsBedrockService', `Error in emulated request: ${error.message}`, error, {
      code: error.code,
      isTimeout: error.isAxiosError && error.code === 'ECONNABORTED'
    });
    if (error.response) {
      logger.error('AwsBedrockService', `SAP AI Core error response: ${error.response.status}`, error.response.data);
    }
    throw error;
  }
```

with:

```typescript
  } catch (error: any) {
    logger.error('AwsBedrockService', `Error in emulated request: ${error.message}`, error, {
      code: error.code,
      isTimeout: error.isAxiosError && error.code === 'ECONNABORTED'
    });
    if (error.response) {
      logger.error('AwsBedrockService', `SAP AI Core error response: ${error.response.status}`, undefined, { data: error.response.data });
      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '03_emulated_error_from_sap', {
          status: error.response.status,
          data: error.response.data
        }, req, res);
      }
    }
    throw error;
  }
```

(`savePayload` is internally gated on payload-logging config — after Task 7, solely on `logging.payload_logging_enabled` — so this adds zero overhead when disabled; it covers all `error.response` statuses — 4xx per the spec, and 5xx for free.)

- [ ] **Step 3: Typecheck and run the full gateway suite**

Run: `cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test`
Expected: typecheck clean; all suites PASS (this is wiring into logging paths that are env-gated; no unit test — behavior verified by inspection and typecheck, exercised at runtime only with `DEBUG=true`)

- [ ] **Step 4: Commit**

```bash
git add services/gateway/src/services/awsBedrockService.ts
git commit -m "fix(gateway): log and persist SAP AI Core error bodies on native/emulated failures"
```

---

### Task 5: Declare both beta-header keys in the admin config schema

**Files:**
- Modify: `services/admin/src/schemas/api-config-schema.json:371-408` (`$defs/providerConfig`)

**Interfaces:**
- Consumes: nothing.
- Produces: schema properties `supported_beta_headers` and `excluded_beta_headers` on `providerConfig` (inherited by `anthropic`, `aws-bedrock`, `openai`, `openrouter` provider blocks). Note `additionalProperties: true` means the admin already tolerates these keys — declaring them adds validation (must be an array of well-formed flag strings) and self-documentation.

- [ ] **Step 1: Add the two properties**

In `$defs/providerConfig.properties`, after the `"anthropic_bedrock_version"` property (line 374-377), add:

```json
        "excluded_beta_headers": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9._-]+$"
          }
        },
        "supported_beta_headers": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9._-]+$"
          }
        },
```

(Existing beta flags all match this pattern, e.g. `context-1m-2025-08-07`, `prompt-caching-scope-2026-01-05`.)

- [ ] **Step 2: Validate the schema is well-formed JSON and the shipped config validates**

Run: `node -e "JSON.parse(require('fs').readFileSync('services/admin/src/schemas/api-config-schema.json','utf8')); console.log('schema JSON ok')"`
Expected: `schema JSON ok`

If the admin service has schema-validation tests, run them: `cd services/admin && npm test 2>/dev/null || echo "no admin test suite — skipping"`
Expected: PASS or explicit skip message.

- [ ] **Step 3: Commit**

```bash
git add services/admin/src/schemas/api-config-schema.json
git commit -m "feat(admin): declare supported/excluded beta header keys in config schema"
```

---

### Task 6: Ship the allowlist in api_config.json + document it

**Files:**
- Modify: `services/gateway/api_config.json:1487-1493` (the `api_config.anthropic` block) — **source of truth**
- Modify: `README.md` (~line 616, "Excluded Beta Headers" section; there is no `services/gateway/README.md` — the config documentation lives in the repo-root README)
- Modify: `services/gateway/test/beta-header-filtering.test.ts` (tighten the Task 2 test now that the key exists)
- Auto-synced by `cli-tools/sync-api-config.js`: `services/admin/api_config.json`, `npm-dist/sail-proxy/src/templates/api_config.template.json`

**⚠️ Shipped-default decision (the one behavioral choice in this plan):** populate `supported_beta_headers` with the eight flags **empirically accepted by SAP AI Core**, derived from correlating 236 requests in `services/gateway/logs/payloads` (stage `02_native_request_to_sap` flag sets vs. presence of a `03_*response_from_sap` for the same request ID, analyzed 2026-07-07):

| Flag | Evidence |
|---|---|
| `claude-code-20250219` | accepted in 200+ requests |
| `context-1m-2025-08-07` | accepted in 150+ requests |
| `context-management-2025-06-27` | accepted in 200+ requests |
| `effort-2025-11-24` | accepted in 200+ requests |
| `interleaved-thinking-2025-05-14` | accepted in 200+ requests |
| `mid-conversation-system-2026-04-07` | accepted in 204 requests (sent by current Claude Code on nearly every request) |
| `afk-mode-2026-01-31` | accepted in 15 requests |
| `fine-grained-tool-streaming-2025-05-14` | accepted in 1 request |

Empirically **rejected** and therefore excluded from the allowlist: `structured-outputs-2025-12-15` (0 accepted / 8 sent on 2026-07-06..07 — the only differing flag vs. an otherwise-identical combo accepted 136×; this is an **active live failure today**) and `thinking-token-count-2026-05-13` (0/4 on 2026-06-24, pre-denylist — confirms commit `e9e1e8d`). `structured-outputs-2025-12-15` is additionally added to `excluded_beta_headers` so deployments that remove the allowlist stay protected.

This shipped default is behavior-identical for all observed *successful* traffic, fixes the currently-failing `structured-outputs` requests, and drops any *future* unknown Claude Code flag (fail-safe) instead of causing an HTTP 400 (fail-broken). Deployments that delete the key get pre-change behavior. If SAP adds support for a flag later, operators add it via the admin UI — hot-reloaded, no restart.

- [ ] **Step 1: Edit the gateway config (source of truth)**

In `services/gateway/api_config.json`, change the anthropic block (lines 1487-1493):

```json
    "anthropic": {
      "anthropic_bedrock_version": "bedrock-2023-05-31",
      "excluded_beta_headers": [
        "prompt-caching-scope-2026-01-05",
        "redact-thinking-2026-02-12",
        "thinking-token-count-2026-05-13"
      ],
```

to:

```json
    "anthropic": {
      "anthropic_bedrock_version": "bedrock-2023-05-31",
      "excluded_beta_headers": [
        "prompt-caching-scope-2026-01-05",
        "redact-thinking-2026-02-12",
        "thinking-token-count-2026-05-13",
        "structured-outputs-2025-12-15",
        "fallback-credit-2026-06-01"
      ],
      "supported_beta_headers": [
        "claude-code-20250219",
        "context-1m-2025-08-07",
        "interleaved-thinking-2025-05-14",
        "context-management-2025-06-27",
        "effort-2025-11-24",
        "mid-conversation-system-2026-04-07",
        "afk-mode-2026-01-31",
        "fine-grained-tool-streaming-2025-05-14"
      ],
```

(Keep the denylist: it protects deployments that remove the allowlist, and denylist-on-top-of-allowlist is the documented semantics.)

**Corroboration from AWS/Anthropic documentation (researched 2026-07-07):** Bedrock's Messages API accepts `anthropic_beta` as a request-body array and rejects unknown values with `400 invalid_request_error: "invalid beta flag"` — the exact failure this plan fixes. Documented-on-Bedrock flags in our allowlist: `context-1m-2025-08-07`, `effort-2025-11-24`, `interleaved-thinking-2025-05-14`, `context-management-2025-06-27`. `structured-outputs` is GA on Bedrock via `output_config` with **no** beta flag (which is why the flag string 400s), and mid-conversation system messages need **no** beta flag on Bedrock (Opus 4.8 only) — the `mid-conversation-system-2026-04-07` string is tolerated by our 4.x deployments per the payload logs. `fallback-credit-2026-06-01` is denylisted because Bedrock documents a *different* date variant (`fallback-credit-2026-06-09`), so the `-06-01` string Claude Code sends would be rejected. **⚠️ Acceptance is per Bedrock model version**: `claude-code-20250219` (and other client flags) are accepted by Claude ≤4.6 Bedrock models but rejected by `global.anthropic.claude-opus-4-7` (see anthropics/claude-code#49648) — when SAP deployments move to Opus 4.7+, revisit the allowlist via the admin UI (hot-reload, no restart).

- [ ] **Step 2: Tighten the configService test**

In `services/gateway/test/beta-header-filtering.test.ts`, inside the `configService.getSupportedBetaHeaders` describe block added in Task 2, add:

```typescript
    it('includes the shipped SAP AI Core allowlist entries', () => {
      const supported = configService.getSupportedBetaHeaders();
      expect(supported).toContain('context-1m-2025-08-07');
      expect(supported).toContain('claude-code-20250219');
    });
```

- [ ] **Step 3: Update the README**

In root `README.md`, replace the "Excluded Beta Headers" section (starting ~line 616 through the `**Default:** …` paragraph ~line 634) with:

```markdown
### Beta Header Filtering (Allowlist + Denylist)

Anthropic clients such as Claude Code send beta feature flags in the `anthropic-beta` header. SAP AI Core rejects the entire request with HTTP 400 "invalid beta flag" if it sees a flag its Anthropic deployments don't recognize. The gateway filters the outbound `anthropic_beta` array with two hot-reloadable settings under `api_config.anthropic` (no restart needed — changes apply on the next request):

```json
{
  "api_config": {
    "anthropic": {
      "supported_beta_headers": [
        "claude-code-20250219",
        "context-1m-2025-08-07",
        "interleaved-thinking-2025-05-14",
        "context-management-2025-06-27",
        "effort-2025-11-24",
        "mid-conversation-system-2026-04-07",
        "afk-mode-2026-01-31",
        "fine-grained-tool-streaming-2025-05-14"
      ],
      "excluded_beta_headers": [
        "prompt-caching-scope-2026-01-05",
        "redact-thinking-2026-02-12",
        "thinking-token-count-2026-05-13",
        "structured-outputs-2025-12-15",
        "fallback-credit-2026-06-01"
      ]
    }
  }
}
```

**`supported_beta_headers` (allowlist):** when present and non-empty, only these flags are forwarded — anything else (including flags injected via a model's `inject_beta_features` or supplied in the request body) is dropped. New, unknown Claude Code flags are therefore filtered out automatically instead of breaking requests. Remove the key (or set `[]`) to disable allowlist filtering.

**`excluded_beta_headers` (denylist):** always applied on top of the allowlist. A flag listed in both is dropped.

**Default:** the shipped allowlist contains the flags currently accepted by SAP AI Core Bedrock Anthropic deployments. If SAP adds support for a new beta feature, add its flag to `supported_beta_headers` via the admin UI.
```

- [ ] **Step 4: Validate, sync the three copies, and run tests**

```bash
node -e "JSON.parse(require('fs').readFileSync('services/gateway/api_config.json','utf8')); console.log('config JSON ok')"
git add services/gateway/api_config.json
node cli-tools/sync-api-config.js
cd services/gateway && npm test -- --testPathPattern="beta"
```

Expected: `config JSON ok`; sync reports `✓ Synced` for admin + npm-dist and stages them; both beta test suites PASS.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/api_config.json services/admin/api_config.json npm-dist/sail-proxy/src/templates/api_config.template.json README.md services/gateway/test/beta-header-filtering.test.ts
git commit -m "feat(config): ship anthropic supported_beta_headers allowlist for SAP AI Core"
```

---

### Task 7: Make payload logging a pure api_config.json toggle (drop the DEBUG env gates)

**Files:**
- Modify: `services/gateway/src/utils/payloadLogger.ts:126-147` (remove DEBUG gate, add `isPayloadLoggingEnabled` export)
- Modify: `services/gateway/src/controllers/awsBedrockController.ts:1-11` (import) and `:41-42` (debugRequestId generation)
- Modify: `services/gateway/src/controllers/anthropicController.ts:724-727` (`saveSSEStreamToFile` gate)
- Modify: `README.md:974` (`DEBUG` env var description) and the "Beta Header Filtering" area (payload-logging note)
- Test: `services/gateway/test/payload-logger-config-toggle.test.ts`

**Interfaces:**
- Consumes: `payloadLogger.getLoggingConfig()` (module-internal, already reads dynamic config per call).
- Produces: `isPayloadLoggingEnabled(): boolean` exported from `payloadLogger.ts` — used by `awsBedrockController` and `anthropicController` (both re-evaluate per request → hot-reloadable).

**Why:** `savePayload` currently requires `process.env.DEBUG === 'true'` (`payloadLogger.ts:144`) **and** on the Bedrock path `debugRequestId` is only generated when `DEBUG === 'true'` (`awsBedrockController.ts:41`) — so `logging.payload_logging_enabled` alone can never activate payload logging, and Task 4's SAP error dumps are dead on any deployment without `DEBUG`. After this task, `payload_logging_enabled` in `api_config.json` is the single switch, flipped live via the admin UI.

**Behavior deltas (intentional):**
- `payload_logging_enabled: true` in config now writes payload files even without `DEBUG=true` in env. Shipped default is `false` (`api_config.json:23`), so default deployments are unchanged. The env var `PAYLOAD_LOGGING_ENABLED` still overrides config in both directions (`payloadLogger.ts:60-67`) — operators can hard-pin it off.
- `DEBUG`'s other effects (error details in HTTP responses, simulated timeout, hardcoded AWS test credentials) are **not** touched — they stay env-gated.
- SSE stream file dumps in `anthropicController.saveSSEStreamToFile` switch from the DEBUG gate to the same config switch, so all payload-file writers obey one flag.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/payload-logger-config-toggle.test.ts`:

```typescript
/**
 * Payload logging must be togglable purely via api_config.json
 * (logging.payload_logging_enabled) with no DEBUG env var required.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

const mockGetConfig = jest.fn();
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => mockGetConfig() },
  getConfig: () => mockGetConfig(),
}));

jest.mock('../src/config/unifiedAuthConfig', () => ({
  isStandaloneMode: () => true,
}));

jest.mock('fs', () => ({
  ...(jest.requireActual('fs') as object),
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

import * as fs from 'fs';
import { savePayload, isPayloadLoggingEnabled } from '../src/utils/payloadLogger';

const configWithPayloadLogging = (enabled: boolean) => ({
  api_config: { logging: { log_folder_path: './logs', payload_logging_enabled: enabled } },
});

describe('payload logging config toggle (no DEBUG env required)', () => {
  const originalDebug = process.env.DEBUG;
  const originalPayloadEnv = process.env.PAYLOAD_LOGGING_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DEBUG;
    delete process.env.PAYLOAD_LOGGING_ENABLED;
  });

  afterEach(() => {
    if (originalDebug === undefined) delete process.env.DEBUG; else process.env.DEBUG = originalDebug;
    if (originalPayloadEnv === undefined) delete process.env.PAYLOAD_LOGGING_ENABLED; else process.env.PAYLOAD_LOGGING_ENABLED = originalPayloadEnv;
  });

  it('writes a payload file when config enables it and DEBUG is unset', () => {
    mockGetConfig.mockReturnValue(configWithPayloadLogging(true));
    savePayload('req-1', '00_test_stage', { hello: 'world' });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when config disables it', () => {
    mockGetConfig.mockReturnValue(configWithPayloadLogging(false));
    savePayload('req-2', '00_test_stage', { hello: 'world' });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('env PAYLOAD_LOGGING_ENABLED=false still hard-disables despite config true', () => {
    process.env.PAYLOAD_LOGGING_ENABLED = 'false';
    mockGetConfig.mockReturnValue(configWithPayloadLogging(true));
    savePayload('req-3', '00_test_stage', { hello: 'world' });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('isPayloadLoggingEnabled reflects the dynamic config per call (hot reload)', () => {
    mockGetConfig.mockReturnValue(configWithPayloadLogging(false));
    expect(isPayloadLoggingEnabled()).toBe(false);
    mockGetConfig.mockReturnValue(configWithPayloadLogging(true));
    expect(isPayloadLoggingEnabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/gateway && npm test -- --testPathPattern="payload-logger-config-toggle"`
Expected: FAIL — `isPayloadLoggingEnabled` is not exported, and the first test fails because `savePayload` returns early on the DEBUG check (`writeFileSync` never called).

- [ ] **Step 3: Modify payloadLogger.ts**

In `services/gateway/src/utils/payloadLogger.ts`, replace (lines 126-147):

```typescript
// Enhanced payload logger with headers and HTTP method support
export const savePayload = (
  requestId: string | number, 
  stage: string, 
  data: any, 
  req?: Request, 
  res?: Response
): void => {
  const currentDebugEnv = process.env.DEBUG;
  const { payloadLoggingEnabled } = getLoggingConfig();
  
  // Skip debug logging for disabled payload logging to avoid log noise at INFO level
  if (!payloadLoggingEnabled) {
    return;
  }
  
  logger.debug('PayloadLogger', `Enhanced save called for requestId: ${requestId}, stage: ${stage}, DEBUG_ENV: '${currentDebugEnv}', PAYLOAD_LOGGING_ENABLED: ${payloadLoggingEnabled}`);
  
  if (currentDebugEnv !== 'true') {
    logger.debug('PayloadLogger', `Skipping enhanced save, process.env.DEBUG is not the string 'true'.`);
    return;
  }
  
```

with:

```typescript
/**
 * Whether payload logging is currently enabled. Re-reads the dynamic config
 * on every call (with the PAYLOAD_LOGGING_ENABLED env override applied), so
 * an api_config.json change takes effect on the next request — no restart.
 */
export const isPayloadLoggingEnabled = (): boolean => {
  return getLoggingConfig().payloadLoggingEnabled;
};

// Enhanced payload logger with headers and HTTP method support
export const savePayload = (
  requestId: string | number, 
  stage: string, 
  data: any, 
  req?: Request, 
  res?: Response
): void => {
  const { payloadLoggingEnabled } = getLoggingConfig();
  
  // Skip debug logging for disabled payload logging to avoid log noise at INFO level
  if (!payloadLoggingEnabled) {
    return;
  }
  
  logger.debug('PayloadLogger', `Enhanced save called for requestId: ${requestId}, stage: ${stage}, PAYLOAD_LOGGING_ENABLED: ${payloadLoggingEnabled}`);
  
```

- [ ] **Step 4: Modify awsBedrockController.ts**

Add to the import block (after line 11, `import { createUsageMetrics, ... } from '../utils/usageTracker';`):

```typescript
import { isPayloadLoggingEnabled } from '../utils/payloadLogger';
```

Replace (lines 41-42):

```typescript
  const debugRequestId = process.env.DEBUG === 'true' ? uuidv4() : undefined;
  req.debugRequestId = debugRequestId;
```

with:

```typescript
  // Generate a debug request ID whenever payload logging can occur — via the
  // legacy DEBUG env or the dynamic config switch (hot-reloadable per request).
  const payloadLoggingActive = process.env.DEBUG === 'true' || isPayloadLoggingEnabled();
  const debugRequestId = payloadLoggingActive ? (req.debugRequestId || uuidv4()) : undefined;
  req.debugRequestId = debugRequestId;
```

- [ ] **Step 5: Modify anthropicController.ts saveSSEStreamToFile gate**

Replace (line 725):

```typescript
  if (!requestId || !process.env.DEBUG || process.env.DEBUG !== 'true') {
    return;
  }
```

with:

```typescript
  if (!requestId || !payloadLogger.isPayloadLoggingEnabled()) {
    return;
  }
```

(`payloadLogger` is already imported in this file — it is used at line 179.)

- [ ] **Step 6: Update the README**

In root `README.md`, replace line 974:

```markdown
- `DEBUG` - Set to `true` for verbose logging (e.g., `DEBUG=true`) that also activates a hard coded AWS API Key, see claude code example.
```

with:

```markdown
- `DEBUG` - Set to `true` for verbose logging (e.g., `DEBUG=true`) that also activates a hard coded AWS API Key, see claude code example. Payload logging no longer requires `DEBUG` — it is controlled by `api_config.logging.payload_logging_enabled` (hot-reloadable via the admin UI; the `PAYLOAD_LOGGING_ENABLED` env var, if set, overrides the config in both directions).
```

- [ ] **Step 7: Run test to verify it passes, then run the full suite**

Run: `cd services/gateway && npm test -- --testPathPattern="payload-logger-config-toggle" && npx tsc --noEmit -p tsconfig.json && npm test`
Expected: new suite PASS (4 tests); typecheck clean; full suite PASS.

- [ ] **Step 8: Commit**

```bash
git add services/gateway/src/utils/payloadLogger.ts services/gateway/src/controllers/awsBedrockController.ts services/gateway/src/controllers/anthropicController.ts services/gateway/test/payload-logger-config-toggle.test.ts README.md
git commit -m "feat(gateway): make payload logging a pure api_config toggle without DEBUG env"
```

---

### Task 8: Runtime quarantine — self-heal on "invalid beta flag" 400s

**Files:**
- Create: `services/gateway/src/services/betaFlagQuarantine.ts`
- Modify: `services/gateway/src/services/awsBedrockService.ts` — import block; the Task 3 filtering block in `processBedrockRequest`; the two non-streaming catch blocks (as left by Task 4); the two **streaming** catch blocks at `handleNativeStreamingRequest` (~line 1178) and `handleEmulatedStreamingRequest` (~line 1591)
- Test: `services/gateway/test/beta-flag-quarantine.test.ts`

**Interfaces:**
- Consumes: `mergeBetaFeatures` / `filterBetaFeatures` from Task 1; the filtering block shape from Task 3; the catch-block shape from Task 4.
- Produces: `betaFlagQuarantine` module with `getQuarantinedFlags(modelId)`, `quarantineFlags(modelId, flags)`, `isInvalidBetaFlagError(status, errorData)`, `resolveRejectedFlags(errorData, sentFlags)`, `recordBetaFlagRejection(modelId, errorData, sentFlags)`, `clearQuarantine()`.

**Behavior:** When SAP/Bedrock rejects a request with HTTP 400 whose body indicates a beta-flag problem, the flags that were sent are quarantined **in memory, keyed by modelId** (Bedrock's acceptance differs per model version — see the Task 6 corroboration note). The filtering step subtracts quarantined flags on every subsequent request, so the next request succeeds without operator action or restart. If the error body names specific flags (first-party-style errors do), only those are quarantined; Bedrock's bare `"invalid beta flag"` names none, so all sent flags are quarantined for that model — aggressive, but it guarantees the next request goes through, and config-driven filtering still applies first. The quarantine is process-local and resets on pod restart; a `warn` log tells operators to promote the flags to `anthropic.excluded_beta_headers` (admin UI, hot-reloaded) for a permanent fix. There is **no same-request retry** — clients (Claude Code) retry failed requests themselves, and the retry then succeeds. This also works on denylist-only deployments with no allowlist configured.

**Why the streaming catch blocks too:** the streaming handlers write an SSE error and do **not** rethrow, so a 400 on a streaming request never reaches the outer catch blocks — and streaming is the dominant path (173 of 222 responses in the payload-log analysis). All four catch sites have `modelId` and `requestBody` in scope.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/beta-flag-quarantine.test.ts`:

```typescript
/**
 * Runtime beta-flag quarantine tests.
 *
 * When SAP AI Core returns HTTP 400 "invalid beta flag", the flags sent on
 * that request are quarantined in memory (per model) so subsequent requests
 * omit them and succeed.
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
}));

import {
  getQuarantinedFlags,
  quarantineFlags,
  isInvalidBetaFlagError,
  resolveRejectedFlags,
  recordBetaFlagRejection,
  clearQuarantine,
} from '../src/services/betaFlagQuarantine';
import { filterBetaFeatures, mergeBetaFeatures } from '../src/utils/betaFeatureFilter';

const BEDROCK_ERROR = { type: 'error', error: { type: 'invalid_request_error', message: 'invalid beta flag' } };
const FIRST_PARTY_ERROR = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'Unexpected value(s) `structured-outputs-2025-12-15` for the `anthropic-beta` header.' },
};

describe('betaFlagQuarantine', () => {
  beforeEach(() => clearQuarantine());

  it('starts empty and isolates quarantine per model', () => {
    expect(getQuarantinedFlags('model-a')).toEqual([]);
    quarantineFlags('model-a', ['flag-2026-01-01']);
    expect(getQuarantinedFlags('model-a')).toEqual(['flag-2026-01-01']);
    expect(getQuarantinedFlags('model-b')).toEqual([]);
  });

  it('detects Bedrock-style invalid beta flag 400s', () => {
    expect(isInvalidBetaFlagError(400, BEDROCK_ERROR)).toBe(true);
    expect(isInvalidBetaFlagError(400, FIRST_PARTY_ERROR)).toBe(true);
  });

  it('ignores non-400s and unrelated 400s', () => {
    expect(isInvalidBetaFlagError(429, BEDROCK_ERROR)).toBe(false);
    expect(isInvalidBetaFlagError(400, { error: { message: 'max_tokens is required' } })).toBe(false);
    expect(isInvalidBetaFlagError(undefined, BEDROCK_ERROR)).toBe(false);
  });

  it('quarantines only the named flag when the error names one', () => {
    const sent = ['claude-code-20250219', 'structured-outputs-2025-12-15'];
    expect(resolveRejectedFlags(FIRST_PARTY_ERROR, sent)).toEqual(['structured-outputs-2025-12-15']);
  });

  it('quarantines all sent flags when the error names none (Bedrock)', () => {
    const sent = ['claude-code-20250219', 'effort-2025-11-24'];
    expect(resolveRejectedFlags(BEDROCK_ERROR, sent)).toEqual(sent);
  });

  it('recordBetaFlagRejection stores flags retrievable for filtering', () => {
    recordBetaFlagRejection('anthropic--claude-4.7-opus--deployed', BEDROCK_ERROR, ['claude-code-20250219']);
    expect(getQuarantinedFlags('anthropic--claude-4.7-opus--deployed')).toEqual(['claude-code-20250219']);
  });

  it('subsequent request drops quarantined flags via the standard filter chain', () => {
    recordBetaFlagRejection('model-a', BEDROCK_ERROR, ['bad-flag-2026-01-01']);
    const result = filterBetaFeatures(['good-flag-2025-01-01', 'bad-flag-2026-01-01'], {
      supported: [],
      excluded: mergeBetaFeatures([], getQuarantinedFlags('model-a')),
    });
    expect(result).toEqual(['good-flag-2025-01-01']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/gateway && npm test -- --testPathPattern="beta-flag-quarantine"`
Expected: FAIL — `Cannot find module '../src/services/betaFlagQuarantine'`

- [ ] **Step 3: Create the quarantine module**

Create `services/gateway/src/services/betaFlagQuarantine.ts`:

```typescript
/**
 * In-memory quarantine for anthropic_beta flags rejected by SAP AI Core.
 *
 * When SAP (AWS Bedrock behind it) rejects a request with HTTP 400
 * "invalid beta flag", the flags that were sent are quarantined for that
 * model so subsequent requests omit them and succeed. Keyed by modelId
 * because Bedrock's flag acceptance differs per model version.
 *
 * Process-local and reset on restart — a self-healing stopgap, not
 * configuration. Operators should promote quarantined flags to
 * anthropic.excluded_beta_headers (admin UI, hot-reloaded) permanently.
 */
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

const quarantinedByModel = new Map<string, Set<string>>();

// Matches Anthropic beta flag tokens (name + date suffix) inside an error
// body, e.g. "claude-code-20250219" or "context-1m-2025-08-07".
const FLAG_PATTERN = /[a-z0-9][a-z0-9-]*-20\d{2}(?:-\d{2}){0,2}/g;

export function getQuarantinedFlags(modelId: string): string[] {
  return Array.from(quarantinedByModel.get(modelId) ?? []);
}

export function quarantineFlags(modelId: string, flags: string[]): void {
  if (flags.length === 0) {
    return;
  }
  const set = quarantinedByModel.get(modelId) ?? new Set<string>();
  for (const flag of flags) {
    set.add(flag);
  }
  quarantinedByModel.set(modelId, set);
}

export function clearQuarantine(): void {
  quarantinedByModel.clear();
}

function serializeErrorData(errorData: any): string {
  if (typeof errorData === 'string') {
    return errorData;
  }
  try {
    return JSON.stringify(errorData) ?? '';
  } catch {
    return '';
  }
}

/**
 * Whether an upstream error response is a beta-flag rejection.
 */
export function isInvalidBetaFlagError(status: number | undefined, errorData: any): boolean {
  if (status !== 400) {
    return false;
  }
  return /invalid beta flag|anthropic[-_]beta/i.test(serializeErrorData(errorData));
}

/**
 * Flags to quarantine: those explicitly named in the error body when present
 * (first-party-style errors name them), else all flags that were sent
 * (Bedrock's bare "invalid beta flag" names none).
 */
export function resolveRejectedFlags(errorData: any, sentFlags: string[]): string[] {
  if (sentFlags.length === 0) {
    return [];
  }
  const named = (serializeErrorData(errorData).match(FLAG_PATTERN) ?? [])
    .filter(flag => sentFlags.includes(flag));
  return named.length > 0 ? Array.from(new Set(named)) : [...sentFlags];
}

/**
 * Record a beta-flag rejection so subsequent requests for this model omit
 * the offending flags. Returns the quarantined flags.
 */
export function recordBetaFlagRejection(modelId: string, errorData: any, sentFlags: string[]): string[] {
  const rejected = resolveRejectedFlags(errorData, sentFlags);
  quarantineFlags(modelId, rejected);
  logger.warn('BetaFlagQuarantine',
    `Quarantined ${rejected.length} beta flag(s) for model ${modelId} after upstream 400: ${rejected.join(', ')}. ` +
    `Subsequent requests omit them (in-memory, resets on restart). ` +
    `Add them to anthropic.excluded_beta_headers via the admin UI to make this permanent.`);
  return rejected;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/gateway && npm test -- --testPathPattern="beta-flag-quarantine"`
Expected: PASS (7 tests)

- [ ] **Step 5: Wire the quarantine into the filter chain**

In `services/gateway/src/services/awsBedrockService.ts`, add to the import block (next to the Task 3 import):

```typescript
import * as betaFlagQuarantine from './betaFlagQuarantine';
```

In the Task 3 filtering block in `processBedrockRequest`, replace:

```typescript
      const filterOptions = {
        supported: configService.getSupportedBetaHeaders(),
        excluded: configService.getExcludedBetaHeaders()
      };
```

with:

```typescript
      const filterOptions = {
        supported: configService.getSupportedBetaHeaders(),
        // Config denylist plus flags quarantined at runtime after upstream
        // "invalid beta flag" 400s for this model (see betaFlagQuarantine).
        excluded: mergeBetaFeatures(
          configService.getExcludedBetaHeaders(),
          betaFlagQuarantine.getQuarantinedFlags(modelId)
        )
      };
```

- [ ] **Step 6: Hook all four upstream catch sites**

In each of the four catch blocks, insert the same detection snippet **inside the existing `if (error.response)` guard** (for the streaming handlers, add an `if (error.response)` wrapper if none exists at the insertion point):

```typescript
      const sentBetaFlags: string[] = Array.isArray(requestBody?.anthropic_beta)
        ? requestBody.anthropic_beta.map(String)
        : [];
      if (sentBetaFlags.length > 0
          && betaFlagQuarantine.isInvalidBetaFlagError(error.response.status, error.response.data)) {
        betaFlagQuarantine.recordBetaFlagRejection(modelId, error.response.data, sentBetaFlags);
      }
```

The four sites (locate by searching, line numbers drift after Tasks 3-4, all have `modelId` and `requestBody` in scope from the handler's destructured options):
1. `handleNativeSubpath` catch — search `Error in native request:` (after Task 4's `logger.error(..., { data: error.response.data })` line).
2. `handleEmulatedSubpath` catch — search `Error in emulated request:` (same placement).
3. `handleNativeStreamingRequest` catch — search `Error in native streaming:` (this catch writes an SSE error and does not rethrow, so the outer catch never sees it).
4. `handleEmulatedStreamingRequest` catch — search `Error establishing emulated stream:` (same).

- [ ] **Step 7: Typecheck and run the full gateway suite**

Run: `cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test`
Expected: typecheck clean; all suites PASS.

- [ ] **Step 8: Commit**

```bash
git add services/gateway/src/services/betaFlagQuarantine.ts services/gateway/src/services/awsBedrockService.ts services/gateway/test/beta-flag-quarantine.test.ts
git commit -m "feat(gateway): quarantine beta flags rejected upstream so retries self-heal"
```

---

### Task 9: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full gateway suite + typecheck**

```bash
cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: typecheck clean, all suites PASS.

- [ ] **Step 2: Behavioral spot-check of the shipped config against the captured failure**

```bash
cd services/gateway && npx ts-node -r tsconfig-paths/register --transpile-only -e "
const { parseAnthropicBetaHeader, mergeBetaFeatures, filterBetaFeatures } = require('./src/utils/betaFeatureFilter');
const cfg = JSON.parse(require('fs').readFileSync('./api_config.json','utf8')).api_config.anthropic;
const captured = 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,effort-2025-11-24,mid-conversation-system-2026-04-07,structured-outputs-2025-12-15';
const out = filterBetaFeatures(mergeBetaFeatures(parseAnthropicBetaHeader(captured)), { supported: cfg.supported_beta_headers || [], excluded: cfg.excluded_beta_headers || [] });
console.log('forwarded flags:', out);
if (out.includes('thinking-token-count-2026-05-13') || out.includes('structured-outputs-2025-12-15')) { throw new Error('SAP-rejected flag leaked'); }
if (!out.includes('mid-conversation-system-2026-04-07')) { throw new Error('SAP-accepted flag was wrongly dropped'); }
console.log('OK: captured failing payload now yields only supported flags');
"
```

Expected: `forwarded flags: [ 'claude-code-20250219', 'context-1m-2025-08-07', 'interleaved-thinking-2025-05-14', 'context-management-2025-06-27', 'effort-2025-11-24', 'mid-conversation-system-2026-04-07' ]` then `OK: …`.

- [ ] **Step 3: Confirm the three config copies are identical**

```bash
md5 -q services/gateway/api_config.json services/admin/api_config.json npm-dist/sail-proxy/src/templates/api_config.template.json
```

Expected: three identical hashes.

- [ ] **Step 4: Hot-reload sanity note (manual, optional in a live environment)**

With the gateway running: flip `supported_beta_headers` via the admin UI (e.g. remove `effort-2025-11-24`), send one Claude Code request, and confirm the gateway debug log shows the flag being filtered — no restart. Then, with `DEBUG` unset in env, flip `logging.payload_logging_enabled` to `true`, send one request, and confirm payload files appear under `logs/payloads/` (and stop appearing when flipped back). This validates spec item 5 and the Task 7 config toggle end-to-end.

To validate the Task 8 quarantine end-to-end: via the admin UI, temporarily add the known-rejected flag `structured-outputs-2025-12-15` to `supported_beta_headers` **and** remove it from `excluded_beta_headers`, then send two Claude Code requests that carry that flag. Expected: the first request fails with the SAP 400 and the gateway logs `BetaFlagQuarantine ... Quarantined 1 beta flag(s)` (or all sent flags if SAP's error names none); the second request succeeds because the quarantined flag is dropped. Restore the config afterwards.

---

## Out of scope (explicitly)

- Debug **log levels** (`libs/logger` component levels) stay file/env-bound — a dynamic config change still doesn't reach them; only payload logging becomes config-toggleable (Task 7).
- `DEBUG`'s non-payload effects (error details in HTTP responses, simulated timeout path, hardcoded AWS test credentials, verbose debug lines in ~11 files) remain env-gated and unchanged.
- No changes to streaming error handlers at `awsBedrockService.ts:1185-1192` / `:1598-1611` (they already log `error.response.data` correctly via the metadata parameter).
- No renaming/removal of existing `excluded_beta_headers` entries.
