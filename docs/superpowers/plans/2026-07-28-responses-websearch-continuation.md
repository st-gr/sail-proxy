# Web-Search Continuation + Content-Type Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the emulated hosted `web_search` behave like the real thing — the model answers from the search results instead of the client receiving a raw result dump — and stop charset-suffixed `Content-Type` clients from bypassing PII masking.

**Architecture:** After a search completes, the gateway extends the conversation with the model's `function_call` and a `function_call_output` carrying the results, then calls the deployment again so the model writes the answer. Non-streaming loops in the after handler; streaming opens a second SSE call and splices its frames into the live stream. Separately, `matchHeader` learns to compare media types so `application/json; charset=utf-8` is recognised as JSON.

**Tech Stack:** TypeScript, Express 4, axios, Jest. SAP AI Core deployments serving the OpenAI Responses API; Perplexity `sonar-pro` for search.

## Global Constraints

- **Live product.** Absent config must mean unchanged behavior. Chat-completions, Anthropic and AWS Bedrock must not regress. Task 1 changes matching used by every endpoint.
- **Plugin ordering is load-bearing.** `pseudonymizationPlugin` is index 0 in every hook array so the query reaching Perplexity is masked, and it patches `res.write` first so the web-search interceptor wraps it. Never reorder.
- **The search query must never leave the process unmasked.** `remaskSearchQuery(req, query)` is applied before every `executeWebSearch` call. Search *results* are public web content and go to the deployment unmasked; that is deliberate.
- **The search cap is a termination guarantee.** It must never be configurable to zero, negative, absent or absurd — those fall back to the default of 3.
- The **plugin** logger (`utils.logger`) is `(message, meta?)`. The gateway logger is `logger.error(component, message, error?: Error, metadata?: any)` — 3rd param `Error`-typed, silently drops plain objects.
- **Three `api_config.json` copies must stay md5-identical**: `services/gateway/api_config.json` (source of truth), `services/admin/api_config.json`, `npm-dist/sail-proxy/src/templates/api_config.template.json`. Sync with `git add services/gateway/api_config.json && node cli-tools/sync-api-config.js` from the worktree root. Never hand-edit the latter two.
- Commit messages carry **no Claude or Co-Authored-By attribution**. Author is st-gr.
- Baseline: **583 tests / 49 suites** green, `npx tsc --noEmit -p tsconfig.json` clean, both run from `services/gateway`. No pre-existing test may fail.

---

## File Structure

| File | Responsibility |
|---|---|
| `services/gateway/src/services/pluginLoader.ts` (modify) | `matchHeader` compares media type when the definition carries no parameters |
| `services/gateway/src/plugins/webSearch/searchCap.ts` (new) | Pure: validate/clamp the configured cap |
| `services/gateway/src/services/configService.ts` (modify) | `getWebSearchMaxSearches()` accessor |
| `services/gateway/src/plugins/webSearch/continuation.ts` (new) | Pure: build the follow-up request `input` |
| `services/gateway/src/controllers/responsesController.ts` (modify) | Stash the upstream call context; add continuation usage to the metrics |
| `services/gateway/src/plugins/responsesWebSearchPlugin.ts` (modify) | Non-streaming loop (Task 5) and streaming splice (Task 6) |
| `services/gateway/api_config.json` (+2 synced copies) | `web_search.max_searches_per_request`; 18 `webSearchPlugin` entries gated on `header:contentTypeJson` |

---

### Task 1: Media-type matching for `Content-Type`

Closes a PII gap that predates the web-search work: `matchHeader` uses strict equality, so a client sending `application/json; charset=utf-8` matches no `header:contentTypeJson` hook and gets **no masking on any endpoint**.

**Files:**
- Modify: `services/gateway/src/services/pluginLoader.ts` (the `matchHeader` function, ~line 322)
- Modify: `services/gateway/api_config.json` (+ sync 2 copies)
- Test: `services/gateway/test/plugin-loader-header-match.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Behavior change only.

- [ ] **Step 1: Write the failing test**

`matchAll` (the only exported matcher) reads hook definitions from `configService.getConfig()` and memoises them in `global.matcherCache`, so it is awkward to unit-test directly. Follow the repo's established split — a pure helper tested exhaustively, plus one test of the real path against the **shipped** config, exactly as `test/unsupported-params-config.test.ts` does for `getUnsupportedParams`.

Create `services/gateway/test/plugin-loader-header-match.test.ts`:

```typescript
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import { headerValueMatches } from '../src/services/pluginLoader';

describe('headerValueMatches', () => {
  it('matches a bare application/json', () => {
    expect(headerValueMatches('application/json', 'application/json')).toBe(true);
  });

  it('matches when the client appends a charset parameter', () => {
    expect(headerValueMatches('application/json; charset=utf-8', 'application/json')).toBe(true);
  });

  it('ignores parameter spacing and case', () => {
    expect(headerValueMatches('Application/JSON;charset=UTF-8', 'application/json')).toBe(true);
    expect(headerValueMatches('  application/json  ; x=1', 'application/json')).toBe(true);
  });

  it('does not match a different media type', () => {
    expect(headerValueMatches('text/plain', 'application/json')).toBe(false);
    expect(headerValueMatches('application/json-patch+json', 'application/json')).toBe(false);
    expect(headerValueMatches('application/jsonx', 'application/json')).toBe(false);
  });

  it('keeps exact-match semantics when the expected value itself has parameters', () => {
    expect(headerValueMatches('application/json; charset=utf-8', 'application/json; charset=utf-8')).toBe(true);
    expect(headerValueMatches('application/json', 'application/json; charset=utf-8')).toBe(false);
  });
});
```

Add a second file, `services/gateway/test/plugin-loader-content-type.test.ts`, proving the real path against the shipped config — same shape as `test/unsupported-params-config.test.ts`:

```typescript
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import { matchAll } from '../src/services/pluginLoader';

const reqWith = (contentType: string): any => ({ headers: { 'content-type': contentType }, body: {} });

describe('matchAll — header:contentTypeJson against the shipped config', () => {
  it('matches a charset-suffixed content type', () => {
    expect(matchAll(reqWith('application/json; charset=utf-8'), ['header:contentTypeJson'])).toBe(true);
  });

  it('still matches a bare content type', () => {
    expect(matchAll(reqWith('application/json'), ['header:contentTypeJson'])).toBe(true);
  });

  it('does not match a non-JSON content type', () => {
    expect(matchAll(reqWith('text/plain'), ['header:contentTypeJson'])).toBe(false);
  });
});
```

Note `matchAll` memoises hook definitions in `global.matcherCache` keyed by rule id. That is harmless here (one rule id, one definition), but do not add tests to this file that need two different definitions for the same id.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --testPathPattern=plugin-loader-header-match
```

Expected: FAIL — `headerValueMatches` is not exported. (Write both files now; the second one will pass only after Step 3.)

- [ ] **Step 3: Implement media-type comparison**

Add the pure helper above `matchHeader`, exported so it can be tested without mocking config:

```typescript
/** Media type of a header value: everything before the first `;`, trimmed, lowercased. */
function mediaType(value: string): string {
  const semi = value.indexOf(';');
  return (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
}

/**
 * Compare a request header against a hook definition's `equals`.
 *
 * An expected value carrying no parameters compares on media type alone: clients
 * routinely append `; charset=utf-8` (OkHttp, .NET JsonContent, older axios), and the
 * strict equality this replaces silently excluded them — which, for
 * `header:contentTypeJson`, meant those requests bypassed pseudonymization on every
 * endpoint. An expected value that deliberately spells out parameters keeps exact-match
 * semantics, so a definition can still pin a charset when it means to.
 */
export function headerValueMatches(actual: string, expected: string): boolean {
  if (expected.includes(';')) return actual === expected;
  return mediaType(actual) === mediaType(expected);
}
```

Then use it in `matchHeader`:

```typescript
  if (hookDef.equals !== undefined) {
    return headerValueMatches(String(headerValue), String(hookDef.equals));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=plugin-loader-header-match
```

Expected: PASS — 5 in the helper file, 3 in the shipped-config file.

- [ ] **Step 5: Gate the 18 `webSearchPlugin` hook entries on content type**

In `services/gateway/api_config.json`, every hook entry whose `callback.id` is `webSearchPlugin` currently has `"match": ["tools:hasWebSearch"]`. Change each to:

```json
              "match": ["header:contentTypeJson", "tools:hasWebSearch"]
```

`match` arrays are AND (`matchesRules` returns false on the first non-match), so this **narrows**: masking and web search can no longer diverge. Leave the `responsesWebSearchPlugin` entries alone — they already carry both.

Verify the count before and after with a script rather than by eye:

```bash
python3 -c "
import json
d=json.load(open('services/gateway/api_config.json'))
n=0
def walk(o):
    global n
    if isinstance(o,dict):
        cb=o.get('callback') or {}
        if cb.get('id')=='webSearchPlugin':
            n+=1
            assert o.get('match')==['header:contentTypeJson','tools:hasWebSearch'], o.get('match')
        for v in o.values(): walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
walk(d)
print('webSearchPlugin entries gated:', n)
"
```

Expected: `18`.

- [ ] **Step 6: Sync the three config copies**

```bash
cd /Users/grundmanns/Documents/repos/project   # or the worktree root
git add services/gateway/api_config.json
node cli-tools/sync-api-config.js
md5 -q services/gateway/api_config.json \
       services/admin/api_config.json \
       npm-dist/sail-proxy/src/templates/api_config.template.json
```

Expected: three identical hashes.

- [ ] **Step 7: Full suite and commit**

```bash
cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 51 suites, 591 tests (583 + 5 + 3). No pre-existing test may fail. If one does, it likely asserted the old strict-equality behavior — read it, and if it encodes the bug, update it and say so explicitly in your report.

```bash
git add services/gateway/src/services/pluginLoader.ts \
        services/gateway/test/plugin-loader-header-match.test.ts \
        services/gateway/test/plugin-loader-content-type.test.ts \
        services/gateway/api_config.json services/admin/api_config.json \
        npm-dist/sail-proxy/src/templates/api_config.template.json
git commit -m "fix(gateway): match Content-Type on media type so charset clients are masked"
```

---

### Task 2: Configurable search cap

**Files:**
- Modify: `services/gateway/src/services/configService.ts`
- Modify: `services/gateway/api_config.json` (+ sync 2 copies)
- Test: `services/gateway/test/websearch-cap-config.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export const getWebSearchMaxSearches: () => number` — also on the default-export object, like its neighbours.

- [ ] **Step 1: Write the failing test**

The accessors in `configService.ts` call that module's own exported `getConfig()`, so they cannot be unit-tested by mocking a collaborator. The repo's convention (`test/unsupported-params-config.test.ts`) is to exercise the real accessor against the **shipped** `api_config.json` and to put the input-validation logic in a pure helper tested directly. Do the same: the clamping lives in a pure exported function, the accessor just reads config and delegates.

Create `services/gateway/test/websearch-cap-config.test.ts`:

```typescript
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import { resolveMaxWebSearches, DEFAULT_MAX_WEB_SEARCHES } from '../src/plugins/webSearch/searchCap';
import configService from '../src/services/configService';

describe('resolveMaxWebSearches', () => {
  it('accepts an in-range integer', () => {
    expect(resolveMaxWebSearches(1)).toBe(1);
    expect(resolveMaxWebSearches(5)).toBe(5);
    expect(resolveMaxWebSearches(10)).toBe(10);
  });

  it('falls back to the default rather than disabling the bound', () => {
    for (const bad of [0, -1, 11, 99, 1.5, 'many', null, undefined, {}, NaN, Infinity]) {
      expect(resolveMaxWebSearches(bad as any)).toBe(DEFAULT_MAX_WEB_SEARCHES);
    }
  });

  it('defaults to 3', () => {
    expect(DEFAULT_MAX_WEB_SEARCHES).toBe(3);
  });
});

describe('configService.getWebSearchMaxSearches', () => {
  it('resolves the value shipped in api_config.json', () => {
    expect(configService.getWebSearchMaxSearches()).toBe(3);
  });
});
```

The cap accessor is the only consumer, so the pure helper lives beside the other web-search modules rather than in `configService`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --testPathPattern=websearch-cap-config
```

Expected: FAIL — neither `../src/plugins/webSearch/searchCap` nor `getWebSearchMaxSearches` exists yet.

- [ ] **Step 3: Implement the accessor**

Create `services/gateway/src/plugins/webSearch/searchCap.ts`:

```typescript
/**
 * How many hosted web searches one request may perform before the gateway stops
 * continuing the turn.
 *
 * Each search costs a Perplexity call plus a full deployment round trip, so this is a
 * cost control as well as the continuation loop's termination guarantee — which is why
 * an out-of-range, zero, negative, fractional or non-numeric value falls back to the
 * default instead of being honoured. The bound must never be configurable away.
 *
 * Pure: no I/O, no config access. configService reads the value and delegates here.
 *
 * @see api_config.json - web_search.max_searches_per_request
 */

export const DEFAULT_MAX_WEB_SEARCHES = 3;
const MIN_MAX_WEB_SEARCHES = 1;
const MAX_MAX_WEB_SEARCHES = 10;

export function resolveMaxWebSearches(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_MAX_WEB_SEARCHES;
  if (value < MIN_MAX_WEB_SEARCHES || value > MAX_MAX_WEB_SEARCHES) return DEFAULT_MAX_WEB_SEARCHES;
  return value;
}
```

`Number.isInteger` already rejects `NaN`, `Infinity` and fractions, so no separate guard is needed for those.

Then add the accessor next to `getSupportsResponsesApi` in `configService.ts`, matching the shape of its neighbours (note they call this module's own exported `getConfig()`):

```typescript
/**
 * Cap on hosted web searches per request. Absent config yields the built-in default,
 * so installs whose api_config.json predates the key are unaffected.
 *
 * @see plugins/webSearch/searchCap.ts - the validation rules
 */
export const getWebSearchMaxSearches = (): number => {
  try {
    const config = getConfig();
    return resolveMaxWebSearches(config?.api_config?.web_search?.max_searches_per_request);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting the web search cap: ${error.message}`);
    return DEFAULT_MAX_WEB_SEARCHES;
  }
};
```

Import `resolveMaxWebSearches` and `DEFAULT_MAX_WEB_SEARCHES` from `../plugins/webSearch/searchCap`. Export the accessor individually **and** add `getWebSearchMaxSearches` to the default-export object at the bottom of the file, next to `getUnsupportedParams`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=websearch-cap-config
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Ship the key and sync**

Add a top-level `web_search` block to `services/gateway/api_config.json`, as a sibling of the existing `pseudonymization` block inside `api_config`:

```json
    "web_search": {
      "max_searches_per_request": 3
    },
```

Then:

```bash
cd /Users/grundmanns/Documents/repos/project   # or the worktree root
git add services/gateway/api_config.json
node cli-tools/sync-api-config.js
md5 -q services/gateway/api_config.json services/admin/api_config.json \
       npm-dist/sail-proxy/src/templates/api_config.template.json
```

Expected: three identical hashes.

Also declare the key in `services/admin/src/schemas/api-config-schema.json` beside the other top-level blocks: an object with `max_searches_per_request` as `{"type":"integer","minimum":1,"maximum":10}`.

- [ ] **Step 6: Full suite and commit**

```bash
cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 52 suites, 595 tests (591 + 4).

```bash
git add services/gateway/src/services/configService.ts \
        services/gateway/src/plugins/webSearch/searchCap.ts \
        services/gateway/test/websearch-cap-config.test.ts \
        services/gateway/api_config.json services/admin/api_config.json \
        npm-dist/sail-proxy/src/templates/api_config.template.json \
        services/admin/src/schemas/api-config-schema.json
git commit -m "feat(gateway): make the web-search cap configurable"
```

---

### Task 3: Continuation input builder (pure)

**Files:**
- Create: `services/gateway/src/plugins/webSearch/continuation.ts`
- Test: `services/gateway/test/websearch-continuation.test.ts`

**Interfaces:**
- Consumes: `SearchResult` from `./searchExecutor`.
- Produces:
  - `export function normalizeInputToItems(input: any): any[]`
  - `export function buildFunctionCallOutput(callId: string, results: SearchResult[]): any`
  - `export function buildContinuationInput(originalInput: any, outputItems: any[], callId: string, results: SearchResult[]): any[]`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/websearch-continuation.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import {
  normalizeInputToItems,
  buildFunctionCallOutput,
  buildContinuationInput,
} from '../src/plugins/webSearch/continuation';

const RESULTS = [
  { title: 'Node releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'LTS list', content: 'Node 22 is Active LTS', date: 'July 2026' },
] as any;

const FN_CALL = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"node lts"}' };
const REASONING = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' };

describe('normalizeInputToItems', () => {
  it('wraps a bare string prompt as a user message item', () => {
    expect(normalizeInputToItems('hello there')).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello there' }] },
    ]);
  });

  it('returns an item array unchanged', () => {
    const items = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    expect(normalizeInputToItems(items)).toEqual(items);
  });

  it('returns an empty array for null or undefined', () => {
    expect(normalizeInputToItems(undefined)).toEqual([]);
    expect(normalizeInputToItems(null)).toEqual([]);
  });
});

describe('buildFunctionCallOutput', () => {
  it('pairs the output to the call by call_id and carries the results', () => {
    const out = buildFunctionCallOutput('call_1', RESULTS);

    expect(out.type).toBe('function_call_output');
    expect(out.call_id).toBe('call_1');
    const parsed = JSON.parse(out.output);
    expect(parsed.results[0].url).toBe('https://nodejs.org/en/about/previous-releases');
    expect(parsed.results[0].title).toBe('Node releases');
  });

  it('serialises an empty result set without throwing', () => {
    expect(JSON.parse(buildFunctionCallOutput('call_1', []).output)).toEqual({ results: [] });
  });
});

describe('buildContinuationInput', () => {
  it('concatenates original input, the model output, and the function_call_output', () => {
    const input = buildContinuationInput('find the lts', [REASONING, FN_CALL], 'call_1', RESULTS);

    expect(input.map((i: any) => i.type)).toEqual([
      'message', 'reasoning', 'function_call', 'function_call_output',
    ]);
    expect(input[0].content[0].text).toBe('find the lts');
    expect(input[3].call_id).toBe('call_1');
  });

  it('preserves reasoning encrypted_content verbatim so the model keeps its chain of thought', () => {
    const input = buildContinuationInput('q', [REASONING, FN_CALL], 'call_1', RESULTS);
    expect(input[1]).toEqual(REASONING);
  });

  it('keeps an item-array original input in place', () => {
    const original = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    const input = buildContinuationInput(original, [FN_CALL], 'call_1', RESULTS);

    expect(input[0]).toEqual(original[0]);
    expect(input.map((i: any) => i.type)).toEqual(['message', 'function_call', 'function_call_output']);
  });

  it('does not mutate the caller\'s arrays', () => {
    const original = [{ type: 'message', role: 'user', content: [] }];
    const output = [FN_CALL];
    buildContinuationInput(original, output, 'call_1', RESULTS);

    expect(original).toHaveLength(1);
    expect(output).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --testPathPattern=websearch-continuation
```

Expected: FAIL — `Cannot find module '../src/plugins/webSearch/continuation'`.

- [ ] **Step 3: Write the implementation**

Create `services/gateway/src/plugins/webSearch/continuation.ts`:

```typescript
/**
 * Build the follow-up request that lets the model answer from the search results.
 *
 * A native hosted `web_search` runs inside the turn: the model calls it, the provider
 * executes it, and the SAME model turn then writes the answer. Emulating it by handing
 * the client a formatted result list ends the turn early — the model never sees what
 * was found. So after a search the gateway extends the conversation and calls the
 * deployment again.
 *
 * The route runs with `store: false`, so the deployment holds no state: a continuation
 * has to carry the whole conversation — the original input, everything the model just
 * produced (reasoning included, or it loses its chain of thought), the function_call,
 * and the function_call_output with the results.
 *
 * Pure: no I/O, no config, no logging.
 */
import { SearchResult } from './searchExecutor';

/**
 * Responses accepts `input` as either a bare string or an item array. A continuation
 * always needs the array form, so a string prompt is wrapped as the user message it
 * stands for.
 */
export function normalizeInputToItems(input: any): any[] {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
  }
  return [];
}

/** The tool result item the model reads, paired to its call by `call_id`. */
export function buildFunctionCallOutput(callId: string, results: SearchResult[]): any {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify({
      results: (results || []).map(r => ({
        title: r.title, url: r.url, snippet: r.snippet, content: r.content, date: r.date,
      })),
    }),
  };
}

/**
 * Original input + the model's output so far + the tool result.
 *
 * Output items are copied through verbatim — including `reasoning` items and their
 * `encrypted_content` — because the deployment expects the turn replayed exactly as it
 * produced it. Returns a new array; the caller's arrays are never mutated.
 */
export function buildContinuationInput(
  originalInput: any,
  outputItems: any[],
  callId: string,
  results: SearchResult[]
): any[] {
  return [
    ...normalizeInputToItems(originalInput),
    ...(Array.isArray(outputItems) ? outputItems : []),
    buildFunctionCallOutput(callId, results),
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=websearch-continuation
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/plugins/webSearch/continuation.ts \
        services/gateway/test/websearch-continuation.test.ts
git commit -m "feat(gateway): add the web-search continuation input builder"
```

---

### Task 4: Controller stash and continuation usage

The plugin cannot call the deployment without the URL, auth headers and timeout the controller resolved, and the usage of those extra calls must reach the same usage event.

**Files:**
- Modify: `services/gateway/src/controllers/responsesController.ts`
- Test: `services/gateway/test/responses-controller.test.ts` (extend — do not rewrite existing cases)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, on the request object, for Tasks 5 and 6:
  - `(req as any).__responsesUpstream = { url: string; headers: Record<string,string>; timeoutMs: number; payload: any }`
  - `(req as any).__responsesExtraUsage = { input_tokens: number; output_tokens: number }` — the plugin **accumulates** onto this; the controller reads it after the plugin chain and adds it to the metrics.

- [ ] **Step 1: Write the failing tests**

Append to `services/gateway/test/responses-controller.test.ts`:

```typescript
describe('responsesController — continuation support', () => {
  it('stashes the upstream call context for the plugin, on the non-streaming path', async () => {
    const { req, res } = makeNonStreamingRequest();   // reuse this file's existing helper
    await handleResponses(req, res, jest.fn() as any);

    const stash = (req as any).__responsesUpstream;
    expect(stash).toBeDefined();
    expect(stash.url).toContain('/responses');
    expect(stash.headers.Authorization).toMatch(/^Bearer /);
    expect(typeof stash.timeoutMs).toBe('number');
    expect(stash.payload.model).toBe('gpt-5.3-codex');       // upstream name, not the --deployed alias
  });

  it('adds continuation usage reported by the plugin to the usage event', async () => {
    const { req, res } = makeNonStreamingRequest();
    // The plugin accumulates onto this while the after-chain runs.
    (req as any).__responsesExtraUsage = { input_tokens: 40, output_tokens: 7 };

    await handleResponses(req, res, jest.fn() as any);

    // primary call usage in this file's fixture is 228 / 11
    expect(lastUsageEvent().tokens.input).toBe(268);
    expect(lastUsageEvent().tokens.output).toBe(18);
  });
});
```

Read the existing file first: reuse its request/mock helpers and its usage-event capture rather than inventing new ones, and match the fixture's real token numbers. If the helpers are named differently, use the real names — the numbers above assume the file's existing 228/11 fixture; if it differs, adjust and say so in your report.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --testPathPattern=responses-controller
```

Expected: FAIL — `__responsesUpstream` is undefined, and the usage totals are 228/11.

- [ ] **Step 3: Stash the context and sum the usage**

In `handleResponses`, immediately after `headers` is built and **before** the streaming branch, add:

```typescript
    // The web-search plugin continues the turn with a second deployment call after it
    // runs a search; it needs exactly what we resolved here. `payload` is the OUTBOUND
    // body — alias swapped, unsupported params stripped, renames applied — so a
    // continuation inherits every transformation this call had.
    (req as any).__responsesUpstream = {
      url,
      headers,
      timeoutMs: configService.getTimeout(isStreaming),
      payload,
    };
```

Then, on the non-streaming path, after `executeAfterPlugins` has run and before `emitUsageEvent`, fold in whatever the plugin accumulated:

```typescript
    const extra = (req as any).__responsesExtraUsage;
    if (extra && (extra.input_tokens || extra.output_tokens)) {
      updateTokenCounts(usageMetrics, extra.input_tokens || 0, extra.output_tokens || 0);
    }
```

Note the ordering constraint: `executeAfterPlugins` must run **before** the usage event is emitted, so the plugin's accumulation is visible. If the current code emits usage before the after-plugins, move the `emitUsageEvent` call after them and say so in your report — that is a real ordering fix, not incidental.

Apply the same fold in `forwardStream`'s `finish('end')` path, after its usage extraction.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=responses-controller
```

Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Full suite and commit**

```bash
npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 52 suites, 597 tests (595 + 2).

```bash
git add services/gateway/src/controllers/responsesController.ts \
        services/gateway/test/responses-controller.test.ts
git commit -m "feat(gateway): expose the upstream call context and continuation usage"
```

---

### Task 5: Non-streaming continuation loop

**Files:**
- Modify: `services/gateway/src/plugins/responsesWebSearchPlugin.ts` (the `afterHandler`, ~line 520)
- Test: `services/gateway/test/responses-websearch-plugin.test.ts` (extend)

**Interfaces:**
- Consumes: `buildContinuationInput` (Task 3); `getWebSearchMaxSearches` (Task 2); `__responsesUpstream` / `__responsesExtraUsage` (Task 4).
- Produces: no new exports.

**Behavior.** For each `web_search` `function_call` in the response: run the search with the re-masked query, emit a `web_search_call` item, build the continuation, POST it, and repeat on the new response. The client receives the accumulated `web_search_call` items followed by the final response's output, with every raw `web_search` `function_call` removed. Bounded by `getWebSearchMaxSearches()`.

- [ ] **Step 1: Write the failing tests**

Append to `services/gateway/test/responses-websearch-plugin.test.ts` (this file already mocks `webSearch/searchExecutor`; add an axios mock alongside it, and mock `configService.getWebSearchMaxSearches`):

```typescript
describe('responsesWebSearchPlugin — continuation', () => {
  beforeEach(() => {
    mockExecuteWebSearch.mockReset(); mockExecuteWebSearch.mockResolvedValue(RESULTS);
    mockPost.mockReset();
    mockMaxSearches.mockReturnValue(3);
  });

  function reqWithUpstream(body: any = {}): any {
    return {
      body: { input: 'what is the node lts?', ...body },
      [REWROTE_FLAG_KEY]: true,
      __responsesUpstream: {
        url: 'https://sap.example/deployments/d1/responses',
        headers: { Authorization: 'Bearer t' },
        timeoutMs: 1000,
        payload: { model: 'gpt-5.3-codex', input: 'what is the node lts?' },
      },
    };
  }

  it('calls the deployment again so the model answers from the results', async () => {
    const req = reqWithUpstream();
    mockPost.mockResolvedValue({ data: {
      output: [{ type: 'message', id: 'msg_2', role: 'assistant', status: 'completed',
                 content: [{ type: 'output_text', text: 'Node 22 is the current LTS.', annotations: [] }] }],
      usage: { input_tokens: 40, output_tokens: 7 },
    } });

    const out = await after({ req, upstreamResponse: {
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"node lts"}' }],
    }, utils });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe('https://sap.example/deployments/d1/responses');
    expect(body.model).toBe('gpt-5.3-codex');
    expect(body.input[body.input.length - 1]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });

    expect(out.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(out.output[1].content[0].text).toBe('Node 22 is the current LTS.');
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('accumulates continuation usage onto the request', async () => {
    const req = reqWithUpstream();
    mockPost.mockResolvedValue({ data: { output: [{ type: 'message', content: [] }], usage: { input_tokens: 40, output_tokens: 7 } } });

    await after({ req, upstreamResponse: {
      output: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' }],
    }, utils });

    expect(req.__responsesExtraUsage).toEqual({ input_tokens: 40, output_tokens: 7 });
  });

  it('loops for a second search and stops at the configured cap', async () => {
    mockMaxSearches.mockReturnValue(2);
    const req = reqWithUpstream();
    const searchCall = (id: string) => ({ type: 'function_call', call_id: id, name: 'web_search', arguments: '{"query":"q"}' });
    mockPost
      .mockResolvedValueOnce({ data: { output: [searchCall('call_2')], usage: { input_tokens: 1, output_tokens: 1 } } })
      .mockResolvedValueOnce({ data: { output: [searchCall('call_3')], usage: { input_tokens: 1, output_tokens: 1 } } });

    const out = await after({ req, upstreamResponse: { output: [searchCall('call_1')] }, utils });

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(2);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(out.output.filter((i: any) => i.type === 'web_search_call')).toHaveLength(2);
    // the cap stopped the loop with a call still outstanding: it must not leak
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('returns the pre-continuation response when the continuation call fails', async () => {
    const req = reqWithUpstream();
    mockPost.mockRejectedValue(new Error('deployment 500'));

    const out = await after({ req, upstreamResponse: {
      output: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' }],
    }, utils });

    expect(out.output[0].type).toBe('web_search_call');
    expect(out.output[0].status).toBe('failed');
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('passes through untouched when the upstream context is missing', async () => {
    const req: any = { body: {}, [REWROTE_FLAG_KEY]: true };   // no __responsesUpstream
    const upstreamResponse = { output: [{ type: 'function_call', call_id: 'c', name: 'web_search', arguments: '{"query":"q"}' }] };

    const out = await after({ req, upstreamResponse, utils });

    expect(mockPost).not.toHaveBeenCalled();
    expect(out.output.some((i: any) => i.type === 'web_search_call')).toBe(true);   // still no raw call leaked
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });
});
```

`REWROTE_FLAG_KEY` is the literal string `'__responsesWebSearchRewritten'` — the plugin's module-private `REWROTE_FLAG`. Declare it as a const at the top of the describe block.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --testPathPattern=responses-websearch-plugin
```

Expected: FAIL — no continuation call is made; the output is `['web_search_call','message']` where the message is the formatted dump.

- [ ] **Step 3: Rewrite the after handler**

Replace the body of `afterHandler` (keeping the `REWROTE_FLAG` guard and the outer try/catch exactly as they are) with the loop:

```typescript
    const maxSearches = configService.getWebSearchMaxSearches();
    const upstream = (req as any).__responsesUpstream;

    let current = upstreamResponse;
    const searchItems: any[] = [];
    let searches = 0;

    while (searches < maxSearches) {
      const call = (current?.output || []).find(isWebSearchFunctionCall);
      if (!call) break;

      const query = parseQueryFromArguments(call.arguments);
      const searchQuery = remaskSearchQuery(req, query);
      if (searchQuery !== query) {
        pluginLogger.info('Re-masked the web_search query before dispatching it to the search provider');
      }

      let results: SearchResult[] = [];
      let status: 'completed' | 'failed' = 'completed';
      try {
        results = await executeWebSearch(searchQuery, pluginLogger);
      } catch (error: any) {
        status = 'failed';
        pluginLogger.error(`Web search failed for "${searchQuery}": ${error.message}`);
      }
      searches += 1;

      // Without the upstream context we cannot continue the turn; fall back to handing
      // the results to the client as a message, which is at least well-formed.
      if (!upstream || !upstream.url) {
        searchItems.push(buildWebSearchCallItem(query, syntheticId('ws'), status));
        searchItems.push(buildSearchMessageItem(results, query, syntheticId('msg')));
        current = { ...current, output: (current.output || []).filter((i: any) => !isWebSearchFunctionCall(i)) };
        break;
      }

      searchItems.push(buildWebSearchCallItem(query, syntheticId('ws'), status));

      const continuationInput = buildContinuationInput(req.body?.input, current.output || [], call.call_id, results);
      let next: any;
      try {
        const resp = await axios.post(
          upstream.url,
          { ...upstream.payload, input: continuationInput },
          { headers: upstream.headers, timeout: upstream.timeoutMs }
        );
        next = resp.data;
      } catch (error: any) {
        pluginLogger.error(`Web-search continuation call failed: ${error.message}`);
        searchItems[searchItems.length - 1] = buildWebSearchCallItem(query, syntheticId('ws'), 'failed');
        current = { ...current, output: (current.output || []).filter((i: any) => !isWebSearchFunctionCall(i)) };
        break;
      }

      const u = next?.usage;
      if (u) {
        const acc = (req as any).__responsesExtraUsage || { input_tokens: 0, output_tokens: 0 };
        acc.input_tokens += u.input_tokens || 0;
        acc.output_tokens += u.output_tokens || 0;
        (req as any).__responsesExtraUsage = acc;
      }
      current = next;
    }

    if (searches >= maxSearches && (current?.output || []).some(isWebSearchFunctionCall)) {
      pluginLogger.warn(`Reached the web-search cap of ${maxSearches} for this request; stopping the continuation loop`);
    }

    // Any web_search function_call still present (cap reached, or a failed continuation)
    // must never reach the client: its output_item events were already replaced by a
    // web_search_call, so a surviving raw call is an item with no matching events.
    const finalOutput = (current?.output || []).filter((i: any) => !isWebSearchFunctionCall(i));
    return { ...current, output: [...searchItems, ...finalOutput] };
```

Add the imports this needs at the top of the file: `axios` from `'axios'`, `configService` from `'../services/configService'`, and `buildContinuationInput` from `'./webSearch/continuation'`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=responses-websearch-plugin
```

Expected: PASS, including every pre-existing case in the file. One pre-existing case asserted the old dump behavior (`['web_search_call','message']` from a single response with no continuation) — it now needs an upstream stash and a mocked continuation. Update it, and say so explicitly in your report.

- [ ] **Step 5: Full suite and commit**

```bash
npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 52 suites, 602 tests (597 + 5).

```bash
git add services/gateway/src/plugins/responsesWebSearchPlugin.ts \
        services/gateway/test/responses-websearch-plugin.test.ts
git commit -m "feat(gateway): continue the turn so the model answers from search results"
```

---

### Task 6: Streaming continuation splice

The hardest task. Today `runSearch` injects a synthetic `message` item carrying the result dump. It must instead open a **second streaming call** and splice its frames into the live stream.

**Files:**
- Modify: `services/gateway/src/plugins/responsesWebSearchPlugin.ts` (the interceptor, ~lines 150-400)
- Test: `services/gateway/test/responses-websearch-stream.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Task 5, plus the existing interceptor state (`pendingSearches`, `queue`, `flushIfIdle`, `emitRaw`, `emitTerminal`, `suppressed`, `pendingBlocksByIndex`, `completedByCallId`, `substituteOutput`).
- Produces: no new exports.

**Frame contract.**
1. Call #1's `web_search` `function_call` frames stay suppressed, as now.
2. Call #1's terminal frame (`response.completed` / `.incomplete` / `.failed`) is **held** while a continuation is pending — it is not the client's final frame.
3. After the search, emit `response.output_item.added` + `.done` for the `web_search_call` at the suppressed index.
4. Open call #2 with `stream: true` and the continuation input. From its frames: **drop** `response.created` and `response.in_progress`; add `indexOffset` to every `output_index`; pass the rest through.
5. Call #2's terminal frame becomes the client's, with `response.output` prefixed by the accumulated `web_search_call` items and `usage` summed across all calls.
6. If call #2 emits another `web_search` `function_call`, repeat from 1, bounded by `getWebSearchMaxSearches()`.

- [ ] **Step 1: Write the failing tests**

Append to `services/gateway/test/responses-websearch-stream.test.ts`. Add an axios mock returning a fake stream; a small helper turns an array of frames into a Readable:

```typescript
import { Readable } from 'stream';

function upstreamStream(frames: any[]): any {
  return { data: Readable.from(frames.map(f => `data: ${JSON.stringify(f)}\n\n`)) };
}

describe('responsesWebSearchPlugin — streaming continuation', () => {
  beforeEach(() => {
    mockExecuteWebSearch.mockReset(); mockExecuteWebSearch.mockResolvedValue(RESULTS);
    mockPost.mockReset();
    mockMaxSearches.mockReturnValue(3);
  });

  it('splices the continuation stream in place of the result dump', async () => {
    const res = mockRes();
    const req: any = {
      body: { stream: true, input: 'node lts?', tools: [{ type: 'web_search' }] },
      __responsesUpstream: { url: 'https://sap.example/d1/responses', headers: {}, timeoutMs: 1000, payload: { model: 'm', input: 'node lts?' } },
    };
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.created', response: { id: 'resp_2' } },
      { type: 'response.in_progress' },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_2', delta: 'Node 22.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.completed', response: { id: 'resp_2', output: [{ type: 'message', id: 'msg_2' }], usage: { input_tokens: 40, output_tokens: 7 } } },
    ]));

    await before({ req, res, utils });

    res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }));
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"node lts"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"node lts"}' } }));
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1', output: [], usage: { input_tokens: 10, output_tokens: 2 } } }));
    await settleAll();

    const f = frames(res.written);
    const types = f.map(x => x.type);

    expect(types.filter(t => t === 'response.created')).toHaveLength(1);       // call #2's dropped
    expect(types.filter(t => t === 'response.in_progress')).toHaveLength(0);
    expect(types.filter(t => t === 'response.completed')).toHaveLength(1);     // only the final one
    expect(types).toContain('response.output_text.delta');

    const added = f.filter(x => x.type === 'response.output_item.added').map(x => x.item.type);
    expect(added).toEqual(['web_search_call', 'message']);

    const completed = f[f.length - 1];
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(completed.response.usage.input_tokens).toBe(50);   // 10 + 40
    expect(completed.response.usage.output_tokens).toBe(9);   // 2 + 7
  });

  it('offsets continuation output_index past the items already sent', async () => {
    const res = mockRes();
    const req: any = {
      body: { stream: true, input: 'q', tools: [{ type: 'web_search' }] },
      __responsesUpstream: { url: 'u', headers: {}, timeoutMs: 1000, payload: {} },
    };
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm' } },
      { type: 'response.completed', response: { output: [], usage: {} } },
    ]));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.completed', response: { output: [], usage: {} } }));
    await settleAll();

    const added = frames(res.written).filter(x => x.type === 'response.output_item.added');
    expect(added.map(x => x.output_index)).toEqual([2, 3]);   // web_search_call at 2, continuation message after it
  });

  it('falls back to the result message when the continuation call fails', async () => {
    const res = mockRes();
    const req: any = {
      body: { stream: true, input: 'q', tools: [{ type: 'web_search' }] },
      __responsesUpstream: { url: 'u', headers: {}, timeoutMs: 1000, payload: {} },
    };
    mockPost.mockRejectedValue(new Error('deployment 500'));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.completed', response: { output: [], usage: {} } }));
    await settleAll();

    const f = frames(res.written);
    expect(f.some(x => x.type === 'response.output_text.delta')).toBe(true);   // the dump, as a fallback
    expect(f.filter(x => x.type === 'response.completed')).toHaveLength(1);
    expect(res.ended).toBe(true);
  });

  it('never leaves the stream open when the continuation rejects', async () => {
    const res = mockRes();
    const req: any = {
      body: { stream: true, input: 'q', tools: [{ type: 'web_search' }] },
      __responsesUpstream: { url: 'u', headers: {}, timeoutMs: 1000, payload: {} },
    };
    mockPost.mockRejectedValue(new Error('boom'));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.end();
    await settleAll();

    expect(res.ended).toBe(true);
  });
});
```

`settleAll` is a helper that drains pending microtasks and stream reads — add `const settleAll = () => new Promise(r => setTimeout(r, 10));` beside the existing `settle` helper.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --testPathPattern=responses-websearch-stream
```

Expected: FAIL — no continuation call; the injected `message` still carries the dump; two `response.completed` frames.

- [ ] **Step 3: Implement the splice**

In `installResponsesWebSearchInterceptor`, add state beside the existing declarations:

```typescript
  let indexOffset = 0;                                 // added to continuation output_index values
  let maxIndexSeen = -1;                               // highest index the client has been sent
  let heldTerminal: { frame: any; rawBlock: string } | null = null;
  let searchesRun = 0;
  const accumulatedSearchItems: any[] = [];            // web_search_call items, in order
  const accumulatedUsage = { input_tokens: 0, output_tokens: 0 };
```

Track `maxIndexSeen` wherever a frame carrying an `output_index` is emitted, and add the terminal-hold: in `emitTerminal`, when a search or continuation is outstanding, store into `heldTerminal` and return instead of writing.

Replace `runSearch`'s message-item construction with a continuation:

```typescript
  const runSearchAndContinue = async (index: number, query: string, callId: string): Promise<void> => {
    try {
      const searchQuery = remaskSearchQuery(req, query);
      let results: SearchResult[] = [];
      let status: 'completed' | 'failed' = 'completed';
      try {
        results = await executeWebSearch(searchQuery, pluginLogger);
      } catch (error: any) {
        status = 'failed';
        pluginLogger.error(`Web search failed mid-stream for "${searchQuery}": ${error.message}`);
      }
      searchesRun += 1;

      const callItem = buildWebSearchCallItem(query, syntheticId('ws'), status);
      accumulatedSearchItems.push(callItem);
      completedByCallId.set(callId, { callItem, messageItem: null });

      const blocks = [
        sseBlock({ type: 'response.output_item.added', output_index: index, item: callItem }),
        sseBlock({ type: 'response.output_item.done', output_index: index, item: callItem }),
      ];
      pendingBlocksByIndex.set(index, blocks);

      const upstream = (req as any).__responsesUpstream;
      if (!upstream?.url || searchesRun > getWebSearchMaxSearches()) {
        // No way to continue (or capped): fall back to the phase-2 behavior so the
        // client at least receives the results rather than an empty turn.
        appendResultMessageBlocks(index, results, query);
        return;
      }

      await streamContinuation(index, callId, results);
    } finally {
      pendingSearches -= 1;
      flushIfIdle();
    }
  };
```

`appendResultMessageBlocks(index, results, query)` is the existing message-item block construction, extracted into a named helper so both the fallback and Task 5's non-streaming path describe the same shape.

`streamContinuation` opens call #2 and pipes it:

```typescript
  const streamContinuation = async (index: number, callId: string, results: SearchResult[]): Promise<void> => {
    const upstream = (req as any).__responsesUpstream;
    const input = buildContinuationInput(req.body?.input, lastOutputItems, callId, results);

    let resp: any;
    try {
      resp = await axios.post(
        upstream.url,
        { ...upstream.payload, input, stream: true },
        { headers: upstream.headers, timeout: upstream.timeoutMs, responseType: 'stream' }
      );
    } catch (error: any) {
      pluginLogger.error(`Web-search continuation stream failed: ${error.message}`);
      appendResultMessageBlocks(index, results, 'continuation unavailable');
      return;
    }

    indexOffset = maxIndexSeen + 1;

    await new Promise<void>((resolve) => {
      let tail2 = '';
      const onData = (chunk: Buffer): void => {
        tail2 += chunk.toString('utf8');
        const { blocks, tail: rest } = splitBlocks(tail2);
        tail2 = rest;
        for (const block of blocks) {
          const frame = parseFrame(block);
          if (!frame) continue;
          if (frame.type === 'response.created' || frame.type === 'response.in_progress') continue;
          if (typeof frame.output_index === 'number') frame.output_index += indexOffset;
          if (TERMINAL_RESPONSE_TYPES.has(frame.type)) {
            mergeTerminal(frame);
            continue;
          }
          originalWrite(sseBlock(frame));
        }
      };
      resp.data.on('data', onData);
      resp.data.on('end', () => resolve());
      resp.data.on('error', (e: any) => {
        pluginLogger.error(`Continuation stream errored: ${e?.message || e}`);
        resolve();
      });
      resp.data.on('close', () => resolve());
    });
  };
```

`mergeTerminal(frame)` builds the client's single final frame: prefix `frame.response.output` with `accumulatedSearchItems`, add `accumulatedUsage` to `frame.response.usage`, and store it as the new `heldTerminal`, so `flushIfIdle` writes exactly one terminal frame at the end.

`lastOutputItems` is the model's output from the call being continued. On the streaming path the interceptor does not have the assembled `output` array, so accumulate it: record each item from `response.output_item.done` frames (pre-offset, in arrival order) into a module-scoped-per-interceptor array, and use that.

This task is intricate; if a piece of the sketch above does not fit the real state machine, implement what the frame contract requires and describe the deviation in your report. The contract, not the sketch, is the requirement.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=responses-websearch-stream
```

Expected: PASS, including every pre-existing case. Several pre-existing cases assert the phase-2 dump shape; they now need an `__responsesUpstream` stash and a mocked continuation stream. Update them and enumerate each change in your report.

- [ ] **Step 5: Full suite and commit**

```bash
npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 52 suites, 606 tests (602 + 4).

```bash
git add services/gateway/src/plugins/responsesWebSearchPlugin.ts \
        services/gateway/test/responses-websearch-stream.test.ts
git commit -m "feat(gateway): splice the continuation stream into the Responses SSE output"
```

- [ ] **Step 6: Update the documentation**

`docs/user/chapter-2-features.md:42` currently describes the phase-2 behavior — "The turn ends there — the results are delivered as the assistant's message; the model does not take a further pass over them to write an answer." That is now wrong. Replace it with an accurate description: the gateway runs the search and calls the model again with the results, so the client receives a `web_search_call` item followed by the model's own answer; the number of searches per request is capped by `web_search.max_searches_per_request` (default 3).

Make the same correction in `services/gateway/src/plugins/responsesWebSearchPlugin.md` and in the plugin's source header comment, and document the new config key alongside the other `api_config.json` keys in the root `README.md`.

```bash
git add docs/user/chapter-2-features.md services/gateway/src/plugins/responsesWebSearchPlugin.md \
        services/gateway/src/plugins/responsesWebSearchPlugin.ts README.md
git commit -m "docs: describe the web-search continuation behavior"
```

---

## Live Verification (after all tasks)

- [ ] **Step 1: Publish and activate the config**, then restart the gateway (**ask the human partner first** — the gateway needs the admin service, and killing it mid-session has broken this environment before).

- [ ] **Step 2: Non-streaming continuation**

```bash
curl -s -X POST http://localhost:3000/openai/v1/responses \
  -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"gpt-5.3-codex--deployed","store":false,
       "instructions":"Use the web_search tool, then answer in one sentence.",
       "input":"What is the current Node.js LTS version?",
       "tools":[{"type":"web_search"}],"max_output_tokens":2000}'
```

Expected: `output` = a `web_search_call` item followed by a `message` written **by the model** — a one-sentence answer, not a numbered result list.

- [ ] **Step 3: Streaming continuation** — the same body with `"stream": true`. Expected: exactly one `response.created`, exactly one `response.completed`, `output_text.delta` frames carrying the model's answer, and `response.completed.response.output` beginning with the `web_search_call`.

- [ ] **Step 4: Masked query across both calls** — include PII, then confirm from the gateway log that the `Executing web search` line carries `MASKED_*` tokens, and from the payload logs that the continuation request body does too.

- [ ] **Step 5: Charset masking** — send a request with `Content-Type: application/json; charset=utf-8` containing PII and confirm the outbound payload is masked (before Task 1 it would not have been).

- [ ] **Step 6: Codex CLI, no shim** — the task that failed the phase-2 gate:

```bash
codex exec --disable multi_agent "Search the web for the latest Node.js LTS version, then write just that version string to node-lts.txt"
```

Expected: `node-lts.txt` exists and contains a version string. **This is the acceptance gate for the whole plan.**

- [ ] **Step 7: Anthropic regression** — one Claude Code web search through `/anthropic/v1/messages` still returns citations.

---

## Self-Review

**Spec coverage.** Continuation call + upstream stash → Tasks 3, 4, 5. Streaming splice → Task 6. Configurable cap with clamping → Task 2. Media-type matching + the 18 entries → Task 1. Usage summing → Tasks 4 and 5 (accumulate) and 6 (`accumulatedUsage` into the terminal frame). Continuation input including reasoning/encrypted content → Task 3. Error handling (continuation fails, search fails, cap reached, disconnect) → Tasks 5 and 6. Docs → Task 6 Step 6. Live gate → the verification block.

**Placeholders.** Every code step carries real code and every test step real assertions. Task 6's implementation is given as a sketch plus an explicit frame contract, with the contract named as the requirement — that is deliberate, because the interceptor's state machine has been revised twice and the implementer must fit the real code rather than a stale transcription.

**Type consistency.** `buildContinuationInput(originalInput, outputItems, callId, results)` is called with that argument order in Tasks 5 and 6. `getWebSearchMaxSearches()` returns `number` and is consumed in both. `__responsesUpstream` carries `{url, headers, timeoutMs, payload}` in Task 4 and is destructured identically later. `__responsesExtraUsage` uses `{input_tokens, output_tokens}` in Tasks 4 and 5. `buildWebSearchCallItem(query, id, status?)` and `buildSearchMessageItem(results, query, id)` keep their phase-2 signatures.
