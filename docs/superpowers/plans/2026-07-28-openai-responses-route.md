# OpenAI Responses API Route — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `POST /openai/v1/responses` by forwarding to a deployed GPT-5+ model's SAP AI Core deployment, with PII masking working end to end, so Codex CLI can use the gateway.

**Architecture:** A dedicated route + focused controller (NOT an extension of the 1450-line `openaiController`). Deployment resolution is extracted into a shared helper both controllers use. Requests are passed through essentially unchanged — the deployment already speaks Responses natively — with the pseudonymization plugin taught the Responses body shape (`input`/`instructions` in, `output` + SSE deltas out).

**Tech Stack:** TypeScript, Express, axios, Jest (`services/gateway/jest.config.json`), SAP AI Core deployments.

**Spec:** `docs/superpowers/specs/2026-07-28-openai-responses-api-design.md`

## Global Constraints

- **Live product.** Absent config must mean unchanged behavior; the chat-completions and Anthropic paths must not regress.
- **Masking is non-negotiable on this route.** Pseudonymization is force-enabled for the `openai` endpoint with `allow_user_bypass: false`. A passthrough that skips masking is a security regression, not a shortcut.
- **Run before-plugins BEFORE building the outbound payload.** `openaiController` builds its payload first and never rebuilds it, so plugins can't affect its body. Do not copy that ordering.
- **Logger trap:** `logger.error(component, message, error?: Error, metadata?: any)` — the 3rd parameter is `Error`-typed and silently drops plain objects. Upstream error bodies go in the **4th** parameter.
- **`api_config.json` has three synced copies.** Source of truth is `services/gateway/api_config.json`; then `git add` it and run `node cli-tools/sync-api-config.js`. Never hand-edit the admin/npm-dist copies. Verify with `md5 -q` on all three.
- **Commit messages carry no Claude/Co-Authored-By attribution.**
- Tests run from `services/gateway/`: `npm test -- --testPathPattern="<pattern>"`. Typecheck: `npx tsc --noEmit -p tsconfig.json`. Full-suite baseline before this work: **475 tests, 36 suites**.

## Verified upstream facts (do not re-derive)

Probed against `gpt-5.4--deployed` and `gpt-5.3-codex--deployed` (both `RUNNING`):

- `POST {deploymentUrl}/responses` → 200. Accepts `store:false`, `instructions`, `reasoning`, Responses-shaped flat `tools`, `include`.
- Deployment **rejects our alias**: send the upstream model name (`gpt-5.3-codex`, not `gpt-5.3-codex--deployed`).
- Hosted tools are **not** supported: `web_search`, `web_search_preview`, `file_search` each return 400 `"The following tool is not allowed for model 'X'"`. Out of scope — let that upstream error pass through; it is actionable.
- `usage` = `{input_tokens, input_tokens_details, output_tokens, output_tokens_details, total_tokens}`.
- Streaming: `content-type: text/event-stream`, frames are bare `data: {json}` with the type **inside** the JSON. **No `event:` lines. No `[DONE]` sentinel.**
- Streaming event types:
  - Text: `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`, `response.output_text.done`, `response.content_part.done`, `response.output_item.done`, `response.completed`
  - Tool: `response.created`, `response.in_progress`, `response.output_item.added`, `response.function_call_arguments.delta`, `response.function_call_arguments.done`, `response.output_item.done`, `response.completed`
  - Both delta events carry payload in a `delta` **string** field; tool-arg deltas are JSON fragments (first observed: `{\"`), so placeholders can split mid-token.

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/responsesEligibility.ts` (new) | Pure: decide whether a model may use `/responses` (config flag → provider flag → family heuristic) |
| `src/utils/responsesBodyAdapter.ts` (new) | Pure: read/write maskable text nodes in a Responses body (`instructions`, `input`) and `output` items |
| `src/controllers/responsesController.ts` (new) | `handleResponses`: resolve target, run plugins, forward, pass through JSON/SSE, usage, errors |
| `src/routes/responsesRoutes.ts` (new) | Route + middleware chain (mirrors `embeddingRoutes.ts`) |
| `src/index.ts` (modify ~line 117) | Mount at `/openai/v1/responses` and `/openai/api/v1/responses` |
| `src/services/configService.ts` (modify) | `getSupportsResponsesApi(provider, model)` accessor |
| `src/plugins/pseudonymization/index.ts` (modify) | Use the adapter for Responses bodies; add Responses SSE delta types |
| `api_config.json` + 2 synced copies | Hook entries for the new subpaths |

Tasks 1–2 are pure and testable in isolation; Task 3 wires the route; Tasks 4–5 make masking work; Task 6 is live verification.

---

### Task 1: Responses eligibility (pure)

**Files:**
- Create: `services/gateway/src/utils/responsesEligibility.ts`
- Test: `services/gateway/test/responses-eligibility.test.ts`

**Interfaces:**
- Consumes: `MAX_COMPLETION_TOKENS_MODELS`-style family matching — reuse by exporting from `src/utils/unsupportedParamFilter.ts` (see Step 3).
- Produces: `isResponsesFamily(modelName: string): boolean` and `resolveResponsesEligibility(opts: { modelName: string; provider?: string; isDeployed: boolean; modelFlag?: boolean; providerFlag?: boolean }): boolean`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/responses-eligibility.test.ts`:

```typescript
/**
 * Eligibility for the /openai/v1/responses route.
 * Order: per-model flag → provider flag → built-in heuristic
 * (deployed AND provider openai AND GPT-5+/o-series family).
 */
import { describe, it, expect } from '@jest/globals';
import { isResponsesFamily, resolveResponsesEligibility } from '../src/utils/responsesEligibility';

describe('isResponsesFamily', () => {
  it('accepts GPT-5+ and o-series, with or without the --deployed alias', () => {
    for (const m of ['gpt-5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex--deployed', 'gpt-6-turbo', 'o1', 'o3', 'o4-mini']) {
      expect(isResponsesFamily(m)).toBe(true);
    }
  });

  it('rejects GPT-4 and earlier, including Azure legacy gpt-35-turbo', () => {
    for (const m of ['gpt-4o', 'gpt-4', 'gpt-4.1', 'gpt-35-turbo', 'gpt-35-turbo-16k', 'gpt-3.5-turbo']) {
      expect(isResponsesFamily(m)).toBe(false);
    }
  });
});

describe('resolveResponsesEligibility', () => {
  const base = { modelName: 'gpt-5.3-codex--deployed', provider: 'openai', isDeployed: true };

  it('uses the heuristic when no flags are set', () => {
    expect(resolveResponsesEligibility(base)).toBe(true);
  });

  it('requires deployed AND provider openai AND family', () => {
    expect(resolveResponsesEligibility({ ...base, isDeployed: false })).toBe(false);
    expect(resolveResponsesEligibility({ ...base, provider: 'perplexity' })).toBe(false);
    expect(resolveResponsesEligibility({ ...base, modelName: 'gpt-4o--deployed' })).toBe(false);
  });

  it('per-model flag decides, overriding the heuristic in both directions', () => {
    expect(resolveResponsesEligibility({ ...base, modelFlag: false })).toBe(false);
    expect(resolveResponsesEligibility({ ...base, modelName: 'gpt-4o--deployed', modelFlag: true })).toBe(true);
  });

  it('provider flag applies when the model flag is absent, and loses to it', () => {
    expect(resolveResponsesEligibility({ ...base, providerFlag: false })).toBe(false);
    expect(resolveResponsesEligibility({ ...base, providerFlag: false, modelFlag: true })).toBe(true);
  });

  it('excludes Perplexity and Anthropic deployments', () => {
    expect(resolveResponsesEligibility({ modelName: 'sonar--deployed', provider: 'perplexity', isDeployed: true })).toBe(false);
    expect(resolveResponsesEligibility({ modelName: 'anthropic--claude-4.5-haiku--deployed', provider: 'anthropic', isDeployed: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/gateway && npm test -- --testPathPattern=responses-eligibility`
Expected: FAIL — `Cannot find module '../src/utils/responsesEligibility'`

- [ ] **Step 3: Export the family regex for reuse**

In `services/gateway/src/utils/unsupportedParamFilter.ts`, change the existing private constant to exported (it already carries the `gpt-35-turbo` guard — do not write a second pattern):

```typescript
export const MAX_COMPLETION_TOKENS_MODELS = /^(?:gpt-[5-9](?:[.\-]|$)|o[1-9])/i;
```

- [ ] **Step 4: Write minimal implementation**

Create `services/gateway/src/utils/responsesEligibility.ts`:

```typescript
/**
 * Which models may be served on /openai/v1/responses.
 *
 * The SAP deployments for GPT-5+/o-series expose the Responses API natively.
 * Perplexity and Anthropic deployments do not, so they are excluded.
 *
 * Resolution order: per-model `supports_responses_api` → provider flag →
 * built-in family heuristic. This mirrors the pattern-default + config-override
 * shape used by defaultParamRenames, so a newly deployed GPT-5+ model works
 * with no config while exceptions stay fixable without a code change.
 */
import { MAX_COMPLETION_TOKENS_MODELS } from './unsupportedParamFilter';

/** GPT-5+/o-series family check. Tolerates the `--deployed` alias suffix. */
export function isResponsesFamily(modelName: string): boolean {
  if (!modelName) return false;
  return MAX_COMPLETION_TOKENS_MODELS.test(modelName.replace(/--deployed$/, ''));
}

export interface ResponsesEligibilityInput {
  modelName: string;
  provider?: string;
  isDeployed: boolean;
  /** api_config model_list_changes.<model>.supports_responses_api */
  modelFlag?: boolean;
  /** api_config.<provider>.supports_responses_api */
  providerFlag?: boolean;
}

export function resolveResponsesEligibility(opts: ResponsesEligibilityInput): boolean {
  if (typeof opts.modelFlag === 'boolean') return opts.modelFlag;
  if (typeof opts.providerFlag === 'boolean') return opts.providerFlag;
  return opts.isDeployed
    && opts.provider === 'openai'
    && isResponsesFamily(opts.modelName);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/gateway && npm test -- --testPathPattern=responses-eligibility`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add services/gateway/src/utils/responsesEligibility.ts services/gateway/src/utils/unsupportedParamFilter.ts services/gateway/test/responses-eligibility.test.ts
git commit -m "feat(gateway): add Responses API model-eligibility resolution"
```

---

### Task 2: Responses body adapter (pure)

**Files:**
- Create: `services/gateway/src/utils/responsesBodyAdapter.ts`
- Test: `services/gateway/test/responses-body-adapter.test.ts`

**Interfaces:**
- Produces (used by Task 4):
  - `isResponsesBody(body: any): boolean`
  - `extractResponsesInputTexts(body: any): Array<{ text: string; path: string }>`
  - `setResponsesInputText(body: any, path: string, newText: string): void`
  - `appendResponsesInstructions(body: any, note: string): void`
  - `unmaskResponsesOutput(response: any, unmask: (s: string) => string): void`

Paths use dot notation resolvable by `setResponsesInputText`, e.g. `instructions`, `input`, `input.0.content.1.text`, `input.2.arguments`, `input.3.output`.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/responses-body-adapter.test.ts`:

```typescript
/**
 * Reading/writing maskable text in Responses-shaped bodies.
 * Request side: `instructions` + `input` (string OR item array).
 * Response side: `output` items.
 */
import { describe, it, expect } from '@jest/globals';
import {
  isResponsesBody,
  extractResponsesInputTexts,
  setResponsesInputText,
  appendResponsesInstructions,
  unmaskResponsesOutput,
} from '../src/utils/responsesBodyAdapter';

describe('isResponsesBody', () => {
  it('detects Responses bodies and rejects chat-completions bodies', () => {
    expect(isResponsesBody({ input: 'hi' })).toBe(true);
    expect(isResponsesBody({ instructions: 'be terse', input: [] })).toBe(true);
    expect(isResponsesBody({ messages: [{ role: 'user', content: 'hi' }] })).toBe(false);
    expect(isResponsesBody({})).toBe(false);
  });
});

describe('extractResponsesInputTexts', () => {
  it('extracts a plain string input and instructions', () => {
    const body = { instructions: 'Be terse.', input: 'my secret is abc' };
    expect(extractResponsesInputTexts(body)).toEqual([
      { text: 'Be terse.', path: 'instructions' },
      { text: 'my secret is abc', path: 'input' },
    ]);
  });

  it('extracts message items, function_call arguments and function_call_output', () => {
    const body = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call the tool' }] },
        { type: 'function_call', name: 'f', arguments: '{"city":"Berlin"}' },
        { type: 'function_call_output', output: 'result text' },
      ],
    };
    expect(extractResponsesInputTexts(body)).toEqual([
      { text: 'call the tool', path: 'input.0.content.0.text' },
      { text: '{"city":"Berlin"}', path: 'input.1.arguments' },
      { text: 'result text', path: 'input.2.output' },
    ]);
  });

  it('returns [] for a body with nothing maskable', () => {
    expect(extractResponsesInputTexts({ model: 'gpt-5.4--deployed' })).toEqual([]);
  });
});

describe('setResponsesInputText', () => {
  it('writes back to every path shape extract produces', () => {
    const body: any = {
      instructions: 'a',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b' }] },
        { type: 'function_call', arguments: 'c' },
      ],
    };
    setResponsesInputText(body, 'instructions', 'A');
    setResponsesInputText(body, 'input.0.content.0.text', 'B');
    setResponsesInputText(body, 'input.1.arguments', 'C');
    expect(body.instructions).toBe('A');
    expect(body.input[0].content[0].text).toBe('B');
    expect(body.input[1].arguments).toBe('C');
  });

  it('writes back to a plain string input', () => {
    const body: any = { input: 'x' };
    setResponsesInputText(body, 'input', 'y');
    expect(body.input).toBe('y');
  });
});

describe('appendResponsesInstructions', () => {
  it('creates instructions when absent and appends when present', () => {
    const a: any = { input: 'x' };
    appendResponsesInstructions(a, 'NOTE');
    expect(a.instructions).toBe('NOTE');

    const b: any = { input: 'x', instructions: 'Base.' };
    appendResponsesInstructions(b, 'NOTE');
    expect(b.instructions).toBe('Base.\n\nNOTE');
  });
});

describe('unmaskResponsesOutput', () => {
  it('unmasks message text, function_call arguments and reasoning summaries', () => {
    const response: any = {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'token X here' }] },
        { type: 'function_call', arguments: '{"v":"X"}' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought about X' }] },
      ],
    };
    unmaskResponsesOutput(response, (s) => s.replace(/X/g, 'REAL'));
    expect(response.output[0].content[0].text).toBe('token REAL here');
    expect(response.output[1].arguments).toBe('{"v":"REAL"}');
    expect(response.output[2].summary[0].text).toBe('thought about REAL');
  });

  it('is a no-op when there is no output array', () => {
    const r: any = { status: 'completed' };
    expect(() => unmaskResponsesOutput(r, (s) => s)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/gateway && npm test -- --testPathPattern=responses-body-adapter`
Expected: FAIL — `Cannot find module '../src/utils/responsesBodyAdapter'`

- [ ] **Step 3: Write minimal implementation**

Create `services/gateway/src/utils/responsesBodyAdapter.ts`:

```typescript
/**
 * Body-shape adapter for the OpenAI Responses API.
 *
 * The pseudonymization plugin was written for chat-shaped bodies
 * (`messages` / `system`). Responses uses `instructions` and `input`, where
 * `input` is either a plain string or an array of items. Without this adapter
 * a /responses request would bypass PII masking entirely.
 */

/** True when the body looks like a Responses request rather than chat completions. */
export function isResponsesBody(body: any): boolean {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body.messages)) return false;
  return body.input !== undefined || typeof body.instructions === 'string';
}

/** Every maskable text node, with a dot path usable by setResponsesInputText. */
export function extractResponsesInputTexts(body: any): Array<{ text: string; path: string }> {
  const out: Array<{ text: string; path: string }> = [];
  if (!body || typeof body !== 'object') return out;

  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    out.push({ text: body.instructions, path: 'instructions' });
  }

  if (typeof body.input === 'string') {
    if (body.input.length > 0) out.push({ text: body.input, path: 'input' });
    return out;
  }

  if (!Array.isArray(body.input)) return out;

  for (let i = 0; i < body.input.length; i++) {
    const item = body.input[i];
    if (!item || typeof item !== 'object') continue;

    if (Array.isArray(item.content)) {
      for (let c = 0; c < item.content.length; c++) {
        const part = item.content[c];
        if (part && typeof part.text === 'string') {
          out.push({ text: part.text, path: `input.${i}.content.${c}.text` });
        }
      }
    } else if (typeof item.content === 'string') {
      out.push({ text: item.content, path: `input.${i}.content` });
    }

    if (typeof item.arguments === 'string') {
      out.push({ text: item.arguments, path: `input.${i}.arguments` });
    }
    if (typeof item.output === 'string') {
      out.push({ text: item.output, path: `input.${i}.output` });
    }
  }
  return out;
}

/** Write a masked string back to the path extract produced. */
export function setResponsesInputText(body: any, path: string, newText: string): void {
  const parts = path.split('.');
  let obj: any = body;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj === undefined || obj === null) return;
    obj = obj[parts[i]];
  }
  if (obj && typeof obj === 'object') obj[parts[parts.length - 1]] = newText;
}

/** Append the copy-note to `instructions` (the Responses equivalent of `system`). */
export function appendResponsesInstructions(body: any, note: string): void {
  if (!body || typeof body !== 'object') return;
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    body.instructions = `${body.instructions}\n\n${note}`;
  } else {
    body.instructions = note;
  }
}

/** Unmask every text-bearing node of a Responses `output` array, in place. */
export function unmaskResponsesOutput(response: any, unmask: (s: string) => string): void {
  if (!response || !Array.isArray(response.output)) return;

  for (const item of response.output) {
    if (!item || typeof item !== 'object') continue;

    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && typeof part.text === 'string') part.text = unmask(part.text);
      }
    }
    if (typeof item.arguments === 'string') item.arguments = unmask(item.arguments);
    if (Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (s && typeof s.text === 'string') s.text = unmask(s.text);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/gateway && npm test -- --testPathPattern=responses-body-adapter`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/utils/responsesBodyAdapter.ts services/gateway/test/responses-body-adapter.test.ts
git commit -m "feat(gateway): add Responses API body-shape adapter for masking"
```

---

### Task 3: Route, controller and mount (non-streaming first)

**Files:**
- Create: `services/gateway/src/controllers/responsesController.ts`
- Create: `services/gateway/src/routes/responsesRoutes.ts`
- Modify: `services/gateway/src/index.ts` (mount, after the embeddings mounts ~line 117)
- Modify: `services/gateway/src/services/configService.ts` (accessor + default export)
- Test: `services/gateway/test/responses-controller.test.ts`

**Interfaces:**
- Consumes: `resolveResponsesEligibility` (Task 1).
- Produces: `handleResponses(req, res, next)` exported from `responsesController`; `getSupportsResponsesApi(provider?: string, modelName?: string): boolean | undefined` on `configService`.

- [ ] **Step 1: Add the config accessor**

In `services/gateway/src/services/configService.ts`, insert next to `getUnsupportedParams` (same try/catch shape), and add `getSupportsResponsesApi,` to the default-export object beside `getParamRenames,`:

```typescript
/**
 * Per-model / per-provider override for /openai/v1/responses eligibility.
 * Returns undefined when unset so the caller falls back to the family heuristic.
 */
export const getSupportsResponsesApi = (provider?: string, modelName?: string): boolean | undefined => {
  try {
    const config = getConfig();
    const m = modelName
      ? config?.api_config?.model_list_changes?.[modelName]?.supports_responses_api
      : undefined;
    if (typeof m === 'boolean') return m;
    const p = provider ? config?.api_config?.[provider]?.supports_responses_api : undefined;
    return typeof p === 'boolean' ? p : undefined;
  } catch (error: any) {
    logger.error('ConfigService', `Error getting supports_responses_api: ${error.message}`);
    return undefined;
  }
};
```

- [ ] **Step 2: Write the failing test**

Create `services/gateway/test/responses-controller.test.ts`:

```typescript
/**
 * responsesController: eligibility gate + outbound payload shape.
 * Upstream HTTP is mocked; this asserts what we WOULD send.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const posted: any[] = [];
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string, body: any, cfg: any) => {
      posted.push({ url, body, cfg });
      return Promise.resolve({
        status: 200,
        data: { id: 'resp_1', object: 'response', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 4 } },
      });
    },
  },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(
      m.startsWith('gpt-5')
        ? { id: m, model: m.replace(/--deployed$/, ''), owned_by: 'OpenAI', deploymentUrl: 'http://mock-sap/deployments/abc' }
        : m.startsWith('sonar')
          ? { id: m, model: m.replace(/--deployed$/, ''), owned_by: 'Perplexity', deploymentUrl: 'http://mock-sap/deployments/xyz' }
          : null
    ),
    getAuthToken: () => Promise.resolve('tok'),
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportsResponsesApi: () => undefined,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getTimeout: () => 1000,
    getHookConfig: () => undefined,
    getConfig: () => ({}),
  },
}));

jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: () => Promise.resolve({ stop: false }),
  executeAfterPlugins: (_req: any, _res: any, body: any) => Promise.resolve(body),
}));

jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({}), emitUsageEvent: () => {}, updateTokenCounts: () => {},
}));

import { handleResponses } from '../src/controllers/responsesController';

function mockRes() {
  const r: any = { statusCode: 200, body: undefined, headers: {} };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.write = () => true; r.end = () => {}; r.writableEnded = false;
  return r;
}

describe('responsesController', () => {
  beforeEach(() => { posted.length = 0; });

  it('forwards to {deploymentUrl}/responses with the upstream model name', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'Say OK', max_output_tokens: 20 }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('http://mock-sap/deployments/abc/responses');
    expect(posted[0].body.model).toBe('gpt-5.3-codex');       // alias replaced
    expect(posted[0].body.input).toBe('Say OK');
    expect(res.statusCode).toBe(200);
    expect(res.body.object).toBe('response');
  });

  it('rejects an ineligible model with model_not_supported', async () => {
    const req: any = { body: { model: 'sonar--deployed', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(posted).toHaveLength(0);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('model_not_supported');
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('rejects an unknown model without calling upstream', async () => {
    const req: any = { body: { model: 'nope--deployed', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});
    expect(posted).toHaveLength(0);
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services/gateway && npm test -- --testPathPattern=responses-controller`
Expected: FAIL — `Cannot find module '../src/controllers/responsesController'`

- [ ] **Step 4: Write the controller**

Create `services/gateway/src/controllers/responsesController.ts`:

```typescript
/**
 * OpenAI Responses API (POST /openai/v1/responses).
 *
 * Deployed GPT-5+/o-series models serve the Responses API natively, so this
 * forwards the request essentially unchanged and passes the result back —
 * preserving reasoning items, encrypted content and the exact SSE framing the
 * client expects. Orchestration-served models are out of scope (phase 2).
 *
 * NOTE on ordering: before-plugins run BEFORE the outbound payload is built.
 * openaiController does the opposite and never rebuilds its payload, so
 * plugins there cannot affect the outbound body. Do not copy that.
 */
import { Request, Response, NextFunction } from 'express';
import axios, { AxiosResponse } from 'axios';
import modelService from '../services/modelService';
import configService from '../services/configService';
import { executeBeforePlugins, executeAfterPlugins } from '../services/pluginExecutor';
import * as payloadLogger from '../utils/payloadLogger';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import { resolveResponsesEligibility } from '../utils/responsesEligibility';
import { stripUnsupportedParams, applyParamRenames } from '../utils/unsupportedParamFilter';

function badRequest(res: Response, message: string, code = 'model_not_supported'): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', code } });
}

export const handleResponses = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  const requestedModel = (req.body || {}).model;
  const usageMetrics = createUsageMetrics();
  const debugRequestId = (req as any).debugRequestId;
  const isStreaming = (req.body || {}).stream === true;

  if (!requestedModel) {
    badRequest(res, 'Missing required parameter: model', 'invalid_request_error');
    return;
  }

  try {
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '00_original_responses_request', req.body, req);
    }

    const modelDetails: any = await modelService.getModelDetails(requestedModel);
    const provider = (modelDetails?.provider || modelDetails?.owned_by || '').toLowerCase();
    const isDeployed = !!modelDetails?.deploymentUrl;

    const eligible = !!modelDetails && resolveResponsesEligibility({
      modelName: requestedModel,
      provider,
      isDeployed,
      modelFlag: configService.getSupportsResponsesApi(undefined, requestedModel),
      providerFlag: configService.getSupportsResponsesApi(provider, undefined),
    });

    if (!eligible) {
      logger.warn('responsesController', `Model ${requestedModel} is not eligible for the Responses API (provider=${provider}, deployed=${isDeployed})`);
      badRequest(res,
        `Model ${requestedModel} does not support the Responses API. It requires a deployed GPT-5+ or o-series model, e.g. gpt-5.3-codex--deployed. Use /openai/v1/chat/completions for other models.`);
      return;
    }

    // Plugins first, so masking reaches the outbound body.
    (req as any).__endpoint = 'openai';
    const subPath = isStreaming ? 'responses-stream' : 'responses';
    const hookConfig = configService.getHookConfig(requestedModel, subPath, 'openai');
    if (hookConfig) {
      const pluginResult: any = await executeBeforePlugins(req, res, hookConfig);
      if (pluginResult?.stop) return;
    }

    const payload: any = { ...req.body };
    if (modelDetails.model) payload.model = modelDetails.model;   // deployment rejects the --deployed alias

    const dropped = stripUnsupportedParams(payload, configService.getUnsupportedParams(provider, requestedModel));
    if (dropped.length > 0) {
      logger.warn('responsesController', `Dropped unsupported parameter(s) for ${requestedModel}: ${dropped.join(', ')}`);
    }
    applyParamRenames(payload, configService.getParamRenames(provider, requestedModel));

    const url = `${modelDetails.deploymentUrl}/responses`;
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '02_responses_request_to_deployment', { url, payload }, req);
    }

    const authToken = await (modelService as any).getAuthToken();
    const headers = {
      Authorization: `Bearer ${authToken}`,
      'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default',
      'Content-Type': 'application/json',
    };

    if (isStreaming) {
      await forwardStream(req, res, url, payload, headers, usageMetrics, requestedModel, debugRequestId);
      return;
    }

    const upstream: AxiosResponse = await axios.post(url, payload, {
      headers,
      timeout: configService.getTimeout(false),
    });

    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '03_responses_response_from_deployment', upstream.data, req, res);
    }

    const u = upstream.data?.usage;
    if (u) updateTokenCounts(usageMetrics, u.input_tokens || 0, u.output_tokens || 0);
    emitUsageEvent(req, usageMetrics, requestedModel, upstream.status);

    let finalBody = upstream.data;
    if (hookConfig) finalBody = await executeAfterPlugins(req, res, upstream.data, hookConfig);

    res.status(upstream.status).json(finalBody);
  } catch (error: any) {
    const status = error.response?.status || 500;
    // 4th parameter: the 3rd is Error-typed and silently drops plain objects.
    logger.error('responsesController', `Responses request failed for ${requestedModel}: ${error.message}`, undefined, {
      status, data: error.response?.data,
    });
    if (debugRequestId && error.response) {
      payloadLogger.savePayload(debugRequestId, '97_responses_error_from_deployment',
        { status, data: error.response.data }, req, res);
    }
    emitUsageEvent(req, usageMetrics, requestedModel, status);

    if (res.headersSent || res.writableEnded) {
      // Mid-stream: cannot change status. Emit a Responses-shaped failure frame.
      try {
        res.write(`data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: error.message } } })}\n\n`);
      } catch { /* best effort */ }
      res.end();
      return;
    }
    res.status(status).json(error.response?.data || {
      error: { message: error.message, type: 'api_error', code: status },
    });
  }
};

/** Pipe the upstream SSE bytes straight through; res.write is patched by the masking plugin. */
async function forwardStream(
  req: Request, res: Response, url: string, payload: any,
  headers: Record<string, string>, usageMetrics: any, requestedModel: string,
  debugRequestId?: string,
): Promise<void> {
  const upstream: AxiosResponse = await axios.post(url, payload, {
    headers, responseType: 'stream', timeout: configService.getTimeout(true),
  });

  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  let captured = '';
  upstream.data.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    captured += s;
    res.write(s);
  });

  req.on('close', () => {
    if (upstream.data?.destroy) upstream.data.destroy();
  });

  await new Promise<void>((resolve) => {
    upstream.data.on('end', () => {
      // Usage lives on the final response.completed frame.
      try {
        const m = captured.match(/"type"\s*:\s*"response\.completed"[\s\S]*$/);
        if (m) {
          const frame = JSON.parse(m[0].slice(m[0].indexOf('{'), m[0].lastIndexOf('}') + 1));
          const u = frame?.response?.usage;
          if (u) updateTokenCounts(usageMetrics, u.input_tokens || 0, u.output_tokens || 0);
        }
      } catch { /* usage is best-effort */ }
      emitUsageEvent(req, usageMetrics, requestedModel, 200);
      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '03_responses_stream_from_deployment',
          { totalLength: captured.length, rawResponse: captured.slice(0, 200000) }, req, res);
      }
      res.end();
      resolve();
    });
    upstream.data.on('error', () => { res.end(); resolve(); });
  });
}
```

- [ ] **Step 5: Create the route**

Create `services/gateway/src/routes/responsesRoutes.ts`:

```typescript
/**
 * OpenAI Responses API routes with unified authentication
 */
import * as express from 'express';
import * as responsesController from '../controllers/responsesController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';

const router: express.Router = express.Router();

const responsesAuth = createUnifiedTokenAuth();
const responsesServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);
const responsesRateLimit = unifiedAuthProxyService.createUnifiedRateLimitMiddleware(serviceConfigurations.openai);

router.post('/', responsesAuth, responsesServiceAuth, responsesRateLimit, rateLimiter, responsesController.handleResponses);

export default router;
```

- [ ] **Step 6: Mount the route**

In `services/gateway/src/index.ts`, add the import beside the other route imports, then mount immediately after the embeddings mounts:

```typescript
import responsesRoutes from './routes/responsesRoutes';
```

```typescript
// OpenAI Responses Routes
app.use('/openai/api/v1/responses', responsesRoutes);
app.use('/openai/v1/responses', responsesRoutes);
```

Also add a startup log line next to the existing OpenAI ones:

```typescript
    logger.info('Gateway Service', `- OpenAI Responses: http://${config.host}:${config.port}/openai/v1/responses`);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test -- --testPathPattern=responses-controller`
Expected: typecheck clean; PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add services/gateway/src/controllers/responsesController.ts services/gateway/src/routes/responsesRoutes.ts services/gateway/src/index.ts services/gateway/src/services/configService.ts services/gateway/test/responses-controller.test.ts
git commit -m "feat(gateway): add /openai/v1/responses passthrough route for deployed GPT-5+ models"
```

---

### Task 4: Mask Responses request bodies

**Files:**
- Modify: `services/gateway/src/plugins/pseudonymization/index.ts`
- Test: `services/gateway/test/pseudonymization-responses.test.ts`

**Interfaces:**
- Consumes: the Task 2 adapter functions.
- Produces: `beforeHandler` masks `instructions` + `input`; `afterHandler` unmasks `output`.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/pseudonymization-responses.test.ts`:

```typescript
/**
 * PII masking must work on the Responses route. Pseudonymization is
 * force-enabled for the openai endpoint with allow_user_bypass:false, so a
 * body shape the plugin does not understand would be a silent security gap.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockConfig: any = { api_config: { defaultHooks: {}, model_list_changes: {} } };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => mockConfig, getSubstitutedModel: (_p: string, m: string) => m },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_p: string, m: string) => m,
}));

import pluginRules = require('../src/plugins/pseudonymization/index');

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before').handler;
const afterHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'after').handler;

const masking = { method: 'pseudonymization', entities: [{ type: 'profile-email' }, { type: 'profile-person' }] };

describe('pseudonymization on Responses bodies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('masks a plain string input and instructions', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', instructions: 'Mail john@test.com', input: 'Contact john@test.com', masking } };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    expect(req.body.input).not.toContain('john@test.com');
    expect(req.body.input).toContain('MASKED_EMAIL');
    expect(req.body.instructions).toContain('MASKED_EMAIL');
  });

  it('masks message items, function_call arguments and function_call_output', async () => {
    const req: any = {
      body: {
        model: 'gpt-5.3-codex--deployed', masking,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'write to john@test.com' }] },
          { type: 'function_call', name: 'f', arguments: '{"to":"john@test.com"}' },
          { type: 'function_call_output', output: 'sent to john@test.com' },
        ],
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    const s = JSON.stringify(req.body.input);
    expect(s).not.toContain('john@test.com');
    expect(s).toContain('MASKED_EMAIL');
  });

  it('appends the copy-note to instructions, not system', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'Contact john@test.com', masking } };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    expect(typeof req.body.instructions).toBe('string');
    expect(req.body.instructions).toContain('NEVER invent');
    expect(req.body.system).toBeUndefined();
  });

  it('unmasks a Responses output in the after handler', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'Contact john@test.com', masking } };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    const token = req.__pseudonymizationMap.forward.get('john@test.com');
    expect(token).toBeDefined();

    const upstreamResponse: any = {
      object: 'response', status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: `I mailed ${token}` }] },
        { type: 'function_call', arguments: `{"to":"${token}"}` },
      ],
    };
    const result = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });

    expect(result.output[0].content[0].text).toBe('I mailed john@test.com');
    expect(result.output[1].arguments).toBe('{"to":"john@test.com"}');
  });

  it('leaves chat-shaped bodies working exactly as before', async () => {
    const req: any = { body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Contact john@test.com' }], masking } };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    expect(req.body.messages[0].content).toContain('MASKED_EMAIL');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/gateway && npm test -- --testPathPattern=pseudonymization-responses`
Expected: FAIL — the input/instructions assertions fail because the plugin never masks them.

- [ ] **Step 3: Wire the adapter into beforeHandler**

In `services/gateway/src/plugins/pseudonymization/index.ts`, add the import beside the other local imports:

```typescript
import {
  isResponsesBody,
  extractResponsesInputTexts,
  setResponsesInputText,
  appendResponsesInstructions,
  unmaskResponsesOutput,
} from '../../utils/responsesBodyAdapter';
```

Immediately BEFORE the `// Process system messages (Anthropic format)` block, insert the Responses branch:

```typescript
    // Responses API bodies use `instructions` + `input` instead of `system` +
    // `messages`. Without this the /openai/v1/responses route would bypass
    // masking entirely, even though it is force-enabled for this endpoint.
    const responsesBody = isResponsesBody(req.body);
    if (responsesBody) {
      for (const { text, path } of extractResponsesInputTexts(req.body)) {
        const detected = detectEntities(text, maskingConfig);
        allEntities.push(...detected);
        const masked = replaceEntities(text, detected, map, maskingConfig);
        maskedInputs.push(masked);
        setResponsesInputText(req.body, path, masked);
      }
    }
```

- [ ] **Step 4: Route the copy-note to instructions**

In the copy-note injection block, replace the `if (Array.isArray(req.body.system))` chain's opening condition so Responses bodies get `instructions`:

```typescript
      if (responsesBody) {
        appendResponsesInstructions(req.body, copyNote);
      } else if (Array.isArray(req.body.system)) {
        req.body.system.push({ type: 'text', text: copyNote });
      } else if (typeof req.body.system === 'string') {
        req.body.system = `${req.body.system}\n\n${copyNote}`;
      } else if (req.body.system === undefined || req.body.system === null) {
        req.body.system = copyNote;
      }
```

- [ ] **Step 5: Unmask the Responses output in afterHandler**

In `afterHandler`, immediately after the existing `unmaskToolBlocks(upstreamResponse, map);` line, add:

```typescript
    // Responses API output items (message/function_call/reasoning).
    unmaskResponsesOutput(upstreamResponse, (s: string) => unmaskText(s, map));
```

- [ ] **Step 6: Extend value propagation to Responses nodes**

In `services/gateway/src/plugins/pseudonymization/replacer.ts`, in `propagateMaskedValues`, extend the walked subtree so one secret still maps to one token everywhere. Replace the two walk lines at the end of the function with:

```typescript
  if (body?.system !== undefined) body.system = walk(body.system);
  if (Array.isArray(body?.messages)) walk(body.messages);
  if (body?.instructions !== undefined) body.instructions = walk(body.instructions);
  if (body?.input !== undefined) body.input = walk(body.input);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test -- --testPathPattern="pseudonymization"`
Expected: typecheck clean; the new suite PASSES (5 tests) and all pre-existing pseudonymization tests still pass.

- [ ] **Step 8: Commit**

```bash
git add services/gateway/src/plugins/pseudonymization/index.ts services/gateway/src/plugins/pseudonymization/replacer.ts services/gateway/test/pseudonymization-responses.test.ts
git commit -m "feat(gateway): mask Responses API request bodies and unmask output items"
```

---

### Task 5: Unmask Responses streaming deltas + wire hooks

**Files:**
- Modify: `services/gateway/src/plugins/pseudonymization/index.ts` (SSE interceptor `processBlock`)
- Modify: `services/gateway/api_config.json` (+ 2 synced copies)
- Test: `services/gateway/test/pseudonymization-responses-stream.test.ts`

**Interfaces:**
- Consumes: the existing `StreamUnmaskBuffer` and `installSseUnmaskInterceptor` machinery.
- Produces: unmasked `response.output_text.delta` / `response.function_call_arguments.delta` frames.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/pseudonymization-responses-stream.test.ts`:

```typescript
/**
 * Responses streaming frames are bare `data: {json}` with the type inside the
 * JSON (no `event:` lines, no [DONE]). Placeholders can split across deltas —
 * tool-argument deltas arrive as JSON fragments.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockConfig: any = { api_config: { defaultHooks: {}, model_list_changes: {} } };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => mockConfig, getSubstitutedModel: (_p: string, m: string) => m },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_p: string, m: string) => m,
}));

import pluginRules = require('../src/plugins/pseudonymization/index');
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before').handler;

const masking = { method: 'pseudonymization', entities: [{ type: 'profile-email' }] };
const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;

async function setup(inputText: string) {
  const written: string[] = [];
  const res: any = {
    write: (c: any) => { written.push(String(c)); return true; },
    end: (c?: any) => { if (typeof c === 'string') written.push(c); },
  };
  const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: inputText, masking } };
  await beforeHandler({ req, res, utils: { logger: mockLogger } });
  return { req, res, written, map: req.__pseudonymizationMap };
}

describe('Responses streaming unmask', () => {
  beforeEach(() => jest.clearAllMocks());

  it('unmasks response.output_text.delta split across frames', async () => {
    const { res, written, map } = await setup('Contact john@test.com');
    const token = map.forward.get('john@test.com');

    res.write(frame({ type: 'response.created', response: { status: 'in_progress' } }));
    res.write(frame({ type: 'response.output_text.delta', delta: `mail ${token.slice(0, 6)}` }));
    res.write(frame({ type: 'response.output_text.delta', delta: token.slice(6) }));
    res.write(frame({ type: 'response.output_text.done' }));
    res.write(frame({ type: 'response.completed', response: { status: 'completed' } }));

    const all = written.join('');
    expect(all).toContain('john@test.com');
    expect(all).not.toContain('MASKED_EMAIL');
  });

  it('unmasks response.function_call_arguments.delta JSON fragments', async () => {
    const { res, written, map } = await setup('Contact john@test.com');
    const token = map.forward.get('john@test.com');

    res.write(frame({ type: 'response.output_item.added', item: { type: 'function_call' } }));
    res.write(frame({ type: 'response.function_call_arguments.delta', delta: '{"to":"' }));
    res.write(frame({ type: 'response.function_call_arguments.delta', delta: `${token}"}` }));
    res.write(frame({ type: 'response.function_call_arguments.done' }));
    res.write(frame({ type: 'response.completed', response: { status: 'completed' } }));

    const all = written.join('');
    expect(all).toContain('john@test.com');
    expect(all).not.toContain('MASKED_EMAIL');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/gateway && npm test -- --testPathPattern=pseudonymization-responses-stream`
Expected: FAIL — masked tokens survive because `processBlock` does not recognize the Responses delta types.

- [ ] **Step 3: Handle Responses deltas in the SSE interceptor**

In `installSseUnmaskInterceptor`'s `processBlock`, after the existing Anthropic `input_json_delta` block and before the `content_block_stop` block, insert:

```typescript
    // OpenAI Responses API deltas. Frames are bare `data: {json}` with the type
    // inside the JSON; both delta events carry a `delta` string. Tool-argument
    // deltas are JSON fragments, so a placeholder can split mid-token.
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      const key = `responses_text:${event.output_index ?? 0}`;
      event.delta = getBuf(key).append(event.delta);
      track(key, event.delta);
      modified = true;
    }
    if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
      const key = `responses_args:${event.output_index ?? 0}`;
      event.delta = getBuf(key).append(event.delta);
      track(key, event.delta);
      modified = true;
    }
    // Flush retained fragments when a Responses item finishes.
    if (event.type === 'response.output_text.done'
        || event.type === 'response.function_call_arguments.done'
        || event.type === 'response.output_item.done'
        || event.type === 'response.completed') {
      for (const [key, buf] of Array.from(buffers.entries())) {
        if (!key.startsWith('responses_')) continue;
        const remainder = buf.flush();
        if (remainder) {
          const deltaType = key.startsWith('responses_text:')
            ? 'response.output_text.delta'
            : 'response.function_call_arguments.delta';
          const idx = parseInt(key.split(':')[1], 10) || 0;
          syntheticPrefix += `data: ${JSON.stringify({ type: deltaType, output_index: idx, delta: remainder })}\n\n`;
          track(key, remainder);
        }
        buffers.delete(key);
        auditBlock(key);
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/gateway && npm test -- --testPathPattern=pseudonymization-responses-stream`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire the plugin hooks for the new subpaths**

Edit `services/gateway/api_config.json` (SOURCE OF TRUTH) — inside `defaultHooks.openai`, add two subpath entries alongside the existing `invoke` / `invoke-with-response-stream`, matching their shape exactly:

```json
        "responses": [
          {
            "request": {
              "callback": { "id": "pseudonymizationPlugin" },
              "match": ["header:contentTypeJson"]
            }
          }
        ],
        "responses-stream": [
          {
            "request": {
              "callback": { "id": "pseudonymizationPlugin" },
              "match": ["header:contentTypeJson"]
            }
          }
        ]
```

Then sync and verify:

```bash
cd /Users/grundmanns/Documents/repos/project
node -e "JSON.parse(require('fs').readFileSync('services/gateway/api_config.json','utf8')); console.log('config JSON ok')"
git add services/gateway/api_config.json
node cli-tools/sync-api-config.js
md5 -q services/gateway/api_config.json services/admin/api_config.json npm-dist/sail-proxy/src/templates/api_config.template.json
```

Expected: `config JSON ok`, sync reports both targets, and all three md5 hashes are identical.

- [ ] **Step 6: Declare the new config key in the admin schema**

In `services/admin/src/schemas/api-config-schema.json`, add to `$defs/providerConfig.properties` AND to the `model_list_changes` item `properties`:

```json
"supports_responses_api": {
  "description": "Override whether this provider/model may be served on /openai/v1/responses. Absent = built-in family heuristic (deployed GPT-5+/o-series).",
  "type": "boolean"
}
```

- [ ] **Step 7: Document the endpoint**

The route ships to `npm-dist/sail-proxy` automatically (`bundle:gateway` runs `pnpm build` and copies `dist/**/*` wholesale), but the endpoint tables are hand-maintained in three places. Add a row to each, matching the surrounding format exactly.

In root `README.md`, after the `/openai/v1/embeddings` row:

```markdown
| OpenAI      | `/openai/api/v1/responses`                                 | OpenAI Responses API → deployed GPT-5+ models       |
| OpenAI      | `/openai/v1/responses`                                     | OpenAI Responses API alias → deployed GPT-5+ models |
```

In `npm-dist/sail-proxy/README.md`, after its `/openai/v1/embeddings` row:

```markdown
| OpenAI | `/openai/api/v1/responses` | OpenAI Responses API (deployed GPT-5+ models) |
| OpenAI | `/openai/v1/responses` | OpenAI Responses alias |
```

In `docs/user/chapter-2-features.md`, add a short subsection near the existing OpenAI endpoint description:

```markdown
### OpenAI Responses API

- **Endpoint**: `/openai/v1/responses`
- **Models**: deployed GPT-5+ / o-series only (e.g. `gpt-5.3-codex--deployed`). Other models return HTTP 400 `model_not_supported` — use `/openai/v1/chat/completions` for those.
- **Supported**: streaming, function tools, `reasoning`, `instructions`, `store: false`. Hosted tools (`web_search`, `file_search`) are not supported by the deployments and are rejected upstream.
- **Client**: works with Codex CLI (point it at `http://<host>:<port>/openai/v1`).

```bash
curl -X POST http://localhost:3000/openai/v1/responses \
  -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"gpt-5.3-codex--deployed","input":"Say OK","max_output_tokens":30,"store":false}'
```
```

- [ ] **Step 8: Run the full suite**

Run: `cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test`
Expected: typecheck clean; all suites pass (baseline 475 + the new tests from Tasks 1–5).

- [ ] **Step 9: Commit**

```bash
git add services/gateway/src/plugins/pseudonymization/index.ts services/gateway/test/pseudonymization-responses-stream.test.ts services/gateway/api_config.json services/admin/api_config.json npm-dist/sail-proxy/src/templates/api_config.template.json services/admin/src/schemas/api-config-schema.json README.md npm-dist/sail-proxy/README.md docs/user/chapter-2-features.md
git commit -m "feat(gateway): unmask Responses streaming deltas, wire hooks, document the endpoint"
```

---

### Task 6: Live verification against the real deployment

**Files:** none (verification only). Requires the gateway running and reachable on `:3000`, and a valid API key.

**Note on config:** in distributed mode the gateway reads config from the admin service, so the new hook entries must be activated there, not just written to the file:

```bash
cd /Users/grundmanns/Documents/repos/project
python3 -c "
import json; d=json.load(open('services/gateway/api_config.json'))
print(json.dumps({'name':'responses-hooks','configData':json.dumps(d),'description':'responses subpath hooks'}))
" > /tmp/cfg.json
CID=$(curl -sS -X POST -u admin@test.com:admin -H 'Content-Type: application/json' \
  http://localhost:4004/odata/v4/admin/createConfiguration -d @/tmp/cfg.json \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('configId',''))")
curl -sS -X POST -u admin@test.com:admin -H 'Content-Type: application/json' \
  http://localhost:4004/odata/v4/admin/activateConfiguration -d "{\"configId\":\"$CID\"}"
```

Plugin/controller code changes require a **gateway restart** to load.

- [ ] **Step 1: Non-streaming happy path**

```bash
KEY=<your gateway api key>
curl -sS -w "\n[http_%{http_code}]\n" http://127.0.0.1:3000/openai/v1/responses \
  -H "content-type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"gpt-5.3-codex--deployed","input":"Say OK","max_output_tokens":30,"store":false}'
```

Expected: `http_200`, body is a Responses object with `"object":"response"`, `"status":"completed"`, and an `output` array containing a `message` item.

- [ ] **Step 2: Ineligible model gives an actionable error**

```bash
curl -sS -w "\n[http_%{http_code}]\n" http://127.0.0.1:3000/openai/v1/responses \
  -H "content-type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"sonar--deployed","input":"hi","max_output_tokens":20}'
```

Expected: `http_400` with `code: "model_not_supported"` and a message naming `gpt-5.3-codex--deployed`.

- [ ] **Step 3: Streaming**

```bash
curl -sS -N http://127.0.0.1:3000/openai/v1/responses \
  -H "content-type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"gpt-5.3-codex--deployed","input":"Count to three.","max_output_tokens":200,"store":false,"stream":true}' \
  | head -c 1200
```

Expected: `data: {"type":"response.created"...}` frames through to `response.completed`, no `event:` lines, no `[DONE]`.

- [ ] **Step 4: Tools round-trip**

```bash
curl -sS -w "\n[http_%{http_code}]\n" http://127.0.0.1:3000/openai/v1/responses \
  -H "content-type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"gpt-5.3-codex--deployed","input":"Weather in Berlin? Use the tool.","max_output_tokens":300,"store":false,
       "tools":[{"type":"function","name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}'
```

Expected: `http_200` with a `function_call` item in `output`.

- [ ] **Step 5: Masking round-trip (the security gate)**

```bash
S=$(date +%s)
curl -sS http://127.0.0.1:3000/openai/v1/responses \
  -H "content-type: application/json" -H "Authorization: Bearer $KEY" \
  -d "{\"model\":\"gpt-5.3-codex--deployed\",\"max_output_tokens\":60,\"store\":false,
       \"input\":\"Probe $S: reply with exactly this email address: erin.tester@example-corp.com\"}"
# then inspect the outbound payload log
grep -l "Probe $S" services/gateway/logs/payloads/*_02_responses_request_to_deployment.json | head -1 | xargs -I{} sh -c '
  echo "raw email outbound (want 0): $(grep -oc "erin.tester@example-corp.com" {})";
  echo "MASKED_EMAIL outbound (want >=1): $(grep -oc MASKED_EMAIL {})"'
```

Expected: outbound payload has **0** occurrences of the real address and at least one `MASKED_EMAIL`; the curl response body shows the **real** address (unmasked on the way back) and no `MASKED_` token. Requires payload logging enabled (`logging.payload_logging_enabled: true`).

- [ ] **Step 6: Codex CLI end to end — the acceptance gate**

Point Codex CLI at the gateway (base URL `http://127.0.0.1:3000/openai/v1`, the gateway API key, model `gpt-5.3-codex--deployed`) and complete one real task that involves at least one tool call. No unit test can prove Codex compatibility — only running Codex can.

Expected: Codex completes the task; the gateway logs show `/openai/v1/responses` 200s; no `MASKED_` token appears in Codex's output.

- [ ] **Step 7: Regression check**

```bash
curl -sS -o /dev/null -w "chat-completions: http_%{http_code}\n" http://127.0.0.1:3000/openai/v1/chat/completions \
  -H "content-type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"gpt-4o","max_tokens":20,"messages":[{"role":"user","content":"Say OK"}]}'
```

Expected: `http_200` — the existing chat path is unaffected.

- [ ] **Step 8: Commit any fixes found during live verification**

```bash
git add -A services/gateway
git commit -m "fix(gateway): address issues found verifying the Responses route live"
```

---

## Self-Review

**Spec coverage:** route + mount (Task 3), focused controller (Task 3), eligibility with config override (Tasks 1, 3, 5 Step 6), upstream model-name substitution (Task 3), plugins-before-payload ordering (Task 3), masking of `input`/`instructions` + copy-note to `instructions` (Task 4), `output` unmasking (Task 4), value propagation (Task 4 Step 6), streaming delta unmasking with the observed event names (Task 5), hook wiring + 3-copy sync (Task 5), admin schema (Task 5), usage mapping `input_tokens`/`output_tokens` (Task 3), error handling incl. the logger 4th-parameter trap and mid-stream `response.failed` (Task 3), payload-log stages (Task 3), live verification incl. Codex (Task 6).

**Deliberately deferred, per spec:** orchestration emulation, `previous_response_id`/`store:true`, background mode, hosted tools (`web_search`/`file_search` — verified 400 upstream), and an `/openrouter/api/v1/responses` mount.

**Type consistency:** `resolveResponsesEligibility` / `isResponsesFamily` (Task 1) are used with those exact names in Task 3. The five adapter functions (Task 2) are imported under the same names in Task 4. `getSupportsResponsesApi(provider?, modelName?)` is defined in Task 3 Step 1 and called there. `MAX_COMPLETION_TOKENS_MODELS` is exported in Task 1 Step 3 and imported in Task 1 Step 4.
