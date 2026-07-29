# Responses API Hosted Tools + OpenRouter Mount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex CLI work through `/openai/v1/responses` without a proxy shim, by emulating the hosted `web_search` tool as a gateway plugin, and mount the route under `/openrouter/api/v1`.

**Architecture:** The Perplexity search core is extracted from the existing Anthropic `webSearchPlugin` into a shared module. A new `responsesWebSearchPlugin` reuses it with the Responses wire format: its before handler rewrites the hosted tool into a plain function tool and back-fills results for searches left pending from the previous turn; its after handler replaces the model's `function_call` with synthetic `web_search_call` + `message` items. For streaming it patches `res.write`/`res.end` to suppress the raw function-call frames and inject synthetic ones once the search resolves.

**Tech Stack:** TypeScript, Express 4, axios, Jest. SAP AI Core (Perplexity `sonar-pro` via direct deployment, orchestration `/v2/completion` fallback).

## Global Constraints

- **Live product.** Absent config must mean unchanged behavior. The chat-completions, Anthropic and AWS Bedrock paths must not regress. Task 1 edits a plugin that Claude Code uses in production.
- **Plugin, not controller code.** `responsesController.ts` is not modified by any task in this plan.
- **Plugin ordering is load-bearing.** `pseudonymizationPlugin` must run before `responsesWebSearchPlugin` on the request side, so the query sent to Perplexity is the masked one. On the response side the reverse must hold, so placeholders echoed by Perplexity are still unmasked. In `api_config.json` hook arrays, `pseudonymizationPlugin` is listed **first**.
- **`logger.error(component, message, error?: Error, metadata?: any)`** — the 3rd parameter is `Error`-typed and silently drops plain objects; upstream bodies belong in the 4th. Note that the *plugin* logger (`utils.logger`) has a different, 2-parameter signature: `(message: string, meta?: any)`.
- **`api_config.json` has three copies** that must stay md5-identical. `services/gateway/api_config.json` is the source of truth; sync with `git add services/gateway/api_config.json && node cli-tools/sync-api-config.js`, then verify with `md5 -q` on all three. Never hand-edit the admin or npm-dist copies.
- **Distributed installs** read config from the admin service, which *replaces* the file config wholesale. New hook keys require activating a new configuration; the route already fails closed with HTTP 503 `pseudonymization_hook_missing` if the masking hook is absent.
- **Commit messages carry no Claude or Co-Authored-By attribution.** Author is st-gr.
- **Baseline before this plan:** 519 tests / 41 suites, all green. `npx tsc --noEmit -p tsconfig.json` clean. Run both from `services/gateway`.
- **`file_search` is out of scope.** Do not implement, stub, or reference it.

---

## File Structure

| File | Responsibility |
|---|---|
| `services/gateway/src/plugins/webSearch/searchExecutor.ts` (new) | Perplexity execution: deployment discovery, orchestration fallback, system-prompt loading, response parsing. Exports `executeWebSearch`, `SearchResult`, `Logger`. |
| `services/gateway/src/plugins/webSearch/responsesAdapter.ts` (new) | Pure Responses-shape helpers: tool rewrite, pending-search detection, synthetic output items. No I/O. |
| `services/gateway/src/plugins/responsesWebSearchPlugin.ts` (new) | before/after handlers + the streaming interceptor. Wires the adapter to the executor. |
| `services/gateway/src/plugins/webSearchPlugin.ts` (modify) | Keeps Anthropic-specific formatting; imports the shared executor. |
| `services/gateway/src/routes/openRouterRoutes.ts` (modify) | Mounts `handleResponses` at `/responses`. |
| `services/gateway/api_config.json` (modify, + 2 synced copies) | Registers the plugin under `defaultHooks.openai.responses` / `.responses-stream`. |

The spec's architecture table names two new files; this plan splits the pure Responses helpers into a third (`responsesAdapter.ts`) so they can be unit-tested without mocking axios or the config service — the same split phase 1 used for `responsesBodyAdapter.ts`. It lives in the `webSearch/` directory the spec already introduces.

---

### Task 1: Extract the Perplexity search core

Pure move. No behavior change. This lands before either consumer changes so that, if it disturbs the live Anthropic path, it does so in isolation.

**Files:**
- Create: `services/gateway/src/plugins/webSearch/searchExecutor.ts`
- Modify: `services/gateway/src/plugins/webSearchPlugin.ts`
- Test: `services/gateway/test/webSearchPlugin.test.ts` (existing — must stay green, unmodified)
- Test: `services/gateway/test/search-executor.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface Logger { error(m: string, meta?: any): void; warn(...): void; info(...): void; debug(...): void; trace(...): void }`
  - `export interface SearchResult { title: string; url: string; snippet: string; content: string; date?: string }`
  - `export async function executeWebSearch(query: string, pluginLogger: Logger): Promise<SearchResult[]>`

**What moves** (from `webSearchPlugin.ts`, by current line number):

| Symbol | Lines | Exported from new module? |
|---|---|---|
| `interface Logger` | 48–55 | yes |
| `interface SearchResult` | 61–67 | yes |
| `interface PerplexityResponse` | 69–73 | no (module-private) |
| `interface PerplexitySearchResult` | 75–80 | no |
| `interface NormalizedCitation` | 82–85 | no |
| `let cachedSystemPrompt` | 126 | no |
| `loadSystemPrompt` | 132–192 | no |
| `getAccessToken` | 282–288 | no |
| `getPerplexityDeploymentId` | 290–305 | no |
| `executeWebSearch` | 307–339 | **yes** |
| `executeDirectPerplexitySearch` | 341–389 | no |
| `executeOrchestrationSearch` | 391–455 | no |
| `normalizeCitations` | 457–475 | no |
| `extractApiCitations` | 477–542 | no |
| `parsePerplexityResponse` | 544–599 | no |
| `parseLlmContent` | 601–626 | no |
| `parseTextResponse` | 628–642 | no |

**What stays** in `webSearchPlugin.ts`: `PluginContext`, `PluginUtils`, `PluginResult`, `ToolUseBlock`, `WebSearchToolResult`, `WEB_SEARCH_TOOL_SCHEMA`, `hasWebSearchTool`, `transformWebSearchTool`, `findPendingWebSearch`, `findWebSearchToolUse`, `buildResponseWithSearchResults`, `formatSearchSummary`, `injectSearchResults`, `beforeHandler`, `afterHandler`, `pluginRules`.

- [ ] **Step 1: Record the baseline**

Run from `services/gateway`:

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=webSearchPlugin
```

Expected: tsc clean; the webSearchPlugin suite passes. Note the test count — it must be identical at the end of this task.

- [ ] **Step 2: Create the new module by moving code verbatim**

Create `services/gateway/src/plugins/webSearch/searchExecutor.ts`. Move the symbols in the table above **without editing their bodies**, except for the two changes below.

Header:

```typescript
/**
 * Perplexity sonar-pro search execution, shared by the Anthropic and Responses
 * web-search plugins.
 *
 * Extracted from webSearchPlugin.ts so both wire formats can reuse one search
 * implementation. Everything here is format-agnostic: it takes a query string
 * and returns SearchResult[]. All Anthropic- and Responses-specific shaping
 * lives in the respective plugins.
 *
 * Strategy: a direct sonar-pro deployment is preferred because it preserves
 * Perplexity's real `citations` / `search_results`. SAP's orchestration wrapper
 * strips those fields, so URLs from the fallback path are model-generated.
 *
 * @see webSearchPlugin.ts - Anthropic consumer
 * @see responsesWebSearchPlugin.ts - Responses consumer
 */
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import configService from '../../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { savePayload } from '../../utils/payloadLogger';

const logger = getDefaultLogger();
```

Note the `../../` depth on the three relative imports — the module is one directory deeper than `webSearchPlugin.ts`.

**Change 1 — the system-prompt paths.** `loadSystemPrompt` resolves `__dirname`-relative paths. The file stays at `services/gateway/src/plugins/webSearchPlugin.system-prompt.txt`; only the lookup changes. Replace the `possiblePaths` array with:

```typescript
  const possiblePaths = [
    // Development: running from src, file one directory up (plugins/)
    path.join(__dirname, '..', 'webSearchPlugin.system-prompt.txt'),
    // Production: running from dist, file in src
    path.join(__dirname, '..', '..', '..', '..', '..', '..', 'src', 'plugins', 'webSearchPlugin.system-prompt.txt'),
    // Alternative: resolved from the process working directory
    path.resolve(process.cwd(), 'src', 'plugins', 'webSearchPlugin.system-prompt.txt'),
  ];
```

**Change 2 — exports.** Add `export` to `interface Logger`, `interface SearchResult` and `async function executeWebSearch`. Everything else stays module-private.

- [ ] **Step 3: Update `webSearchPlugin.ts` to import the shared core**

Delete the moved symbols. Add this import after the existing imports:

```typescript
import { executeWebSearch, Logger, SearchResult } from './webSearch/searchExecutor';
```

Then remove the now-unused imports from `webSearchPlugin.ts`: `fs`, `path`, `axios`, `savePayload`. Keep `configService` and `getDefaultLogger` only if still referenced — check with a search before deleting, and let `tsc` confirm.

- [ ] **Step 4: Verify the extraction is inert**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=webSearchPlugin
```

Expected: tsc clean, and **the same number of tests passing as in Step 1**. `webSearchPlugin.test.ts` must not be modified — it is the regression net. If a test fails, the move was not verbatim; fix the module, not the test.

- [ ] **Step 5: Write a test for the extracted module's contract**

Create `services/gateway/test/search-executor.test.ts`:

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSAPAICoreConfig: () => ({ url: 'https://sap.example', resourceGroup: 'default' }),
    getDeploymentId: async () => 'orch-deployment',
    getAuthToken: async () => 'token',
  },
}));

const mockPost = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockPost(...a) } }));

import { executeWebSearch } from '../src/plugins/webSearch/searchExecutor';

const noopLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } as any;

describe('searchExecutor', () => {
  beforeEach(() => { mockPost.mockReset(); });

  it('returns parsed results from a Perplexity JSON payload', async () => {
    mockPost.mockResolvedValue({
      data: {
        choices: [{ message: { content: JSON.stringify({
          summary: 'Berlin is mild today.',
          results: [{ title: 'Weather', url: 'https://w.example/berlin', snippet: 'Mild', content: 'Mild and dry', date: 'July 2026' }],
        }) } }],
        citations: ['https://w.example/berlin'],
      },
    });

    const results = await executeWebSearch('weather in Berlin', noopLogger);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://w.example/berlin');
    expect(results[0].title).toBe('Weather');
  });

  it('returns an empty array instead of throwing when the search fails', async () => {
    mockPost.mockRejectedValue(new Error('upstream down'));

    const results = await executeWebSearch('anything', noopLogger);

    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the new test**

```bash
npm test -- --testPathPattern="search-executor|webSearchPlugin"
```

Expected: both suites PASS. If the first test fails on the response shape, read `parsePerplexityResponse` in the new module and adjust the **fixture** to match what it actually parses — the extraction must not change parsing behavior.

- [ ] **Step 7: Full suite and commit**

```bash
npx tsc --noEmit -p tsconfig.json
npm test
```

Expected: 42 suites (baseline 41 + `search-executor.test.ts`), 521 tests (baseline 519 + 2). No pre-existing test may fail.

```bash
git add services/gateway/src/plugins/webSearch/searchExecutor.ts \
        services/gateway/src/plugins/webSearchPlugin.ts \
        services/gateway/test/search-executor.test.ts
git commit -m "refactor(gateway): extract the Perplexity search core into a shared module"
```

---

### Task 2: Responses-shape web-search helpers (pure)

No I/O, no mocks. Everything a later task needs to read or write a Responses body lives here.

**Files:**
- Create: `services/gateway/src/plugins/webSearch/responsesAdapter.ts`
- Test: `services/gateway/test/responses-websearch-adapter.test.ts`

**Interfaces:**
- Consumes: `SearchResult` from `./searchExecutor` (Task 1).
- Produces:
  - `export const RESPONSES_WEB_SEARCH_TOOL: Record<string, any>`
  - `export function hasResponsesWebSearchTool(tools: any): boolean`
  - `export function transformResponsesWebSearchTool(body: any): boolean`
  - `export function findPendingResponsesSearch(input: any): { callId: string; query: string } | null`
  - `export function appendFunctionCallOutput(body: any, callId: string, results: SearchResult[]): void`
  - `export function isWebSearchFunctionCall(item: any): boolean`
  - `export function parseQueryFromArguments(args: any): string`
  - `export function formatSearchSummaryText(results: SearchResult[], query: string): string`
  - `export function buildWebSearchCallItem(query: string, id: string, status?: 'completed' | 'failed'): any`
  - `export function buildSearchMessageItem(results: SearchResult[], query: string, id: string): any`

- [ ] **Step 1: Write the failing tests**

Create `services/gateway/test/responses-websearch-adapter.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import {
  hasResponsesWebSearchTool,
  transformResponsesWebSearchTool,
  findPendingResponsesSearch,
  appendFunctionCallOutput,
  isWebSearchFunctionCall,
  parseQueryFromArguments,
  buildWebSearchCallItem,
  buildSearchMessageItem,
} from '../src/plugins/webSearch/responsesAdapter';

const RESULTS = [
  { title: 'Berlin weather', url: 'https://w.example/berlin', snippet: 'Mild', content: 'Mild and dry', date: 'July 2026' },
];

describe('responsesAdapter — tool rewrite', () => {
  it('detects a hosted web_search tool', () => {
    expect(hasResponsesWebSearchTool([{ type: 'web_search', external_web_access: false }])).toBe(true);
  });

  it('ignores a plain function tool named something else', () => {
    expect(hasResponsesWebSearchTool([{ type: 'function', name: 'exec_command' }])).toBe(false);
  });

  it('ignores a non-array tools value', () => {
    expect(hasResponsesWebSearchTool(undefined)).toBe(false);
    expect(hasResponsesWebSearchTool('web_search')).toBe(false);
  });

  it('rewrites the hosted tool into a flat function tool and leaves others untouched', () => {
    const body: any = { tools: [{ type: 'function', name: 'exec_command' }, { type: 'web_search', external_web_access: false }] };

    expect(transformResponsesWebSearchTool(body)).toBe(true);

    expect(body.tools).toHaveLength(2);
    expect(body.tools[0]).toEqual({ type: 'function', name: 'exec_command' });
    expect(body.tools[1].type).toBe('function');
    expect(body.tools[1].name).toBe('web_search');
    expect(body.tools[1].parameters.required).toEqual(['query']);
  });

  it('reports no change when there is no hosted tool', () => {
    const body: any = { tools: [{ type: 'function', name: 'exec_command' }] };
    expect(transformResponsesWebSearchTool(body)).toBe(false);
  });

  it('drops the tools key entirely rather than sending an empty array', () => {
    const body: any = { tools: [] };
    transformResponsesWebSearchTool(body);
    expect('tools' in body).toBe(false);
  });
});

describe('responsesAdapter — pending searches', () => {
  it('finds a web_search call with no matching output', () => {
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' },
    ];

    expect(findPendingResponsesSearch(input)).toEqual({ callId: 'call_1', query: 'weather in Berlin' });
  });

  it('returns null when the call already has its output', () => {
    const input = [
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    ];

    expect(findPendingResponsesSearch(input)).toBeNull();
  });

  it('ignores pending calls to other tools', () => {
    const input = [{ type: 'function_call', call_id: 'call_9', name: 'exec_command', arguments: '{}' }];
    expect(findPendingResponsesSearch(input)).toBeNull();
  });

  it('returns null for a string input', () => {
    expect(findPendingResponsesSearch('just a prompt')).toBeNull();
  });

  it('appends a function_call_output carrying the results', () => {
    const body: any = { input: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' }] };

    appendFunctionCallOutput(body, 'call_1', RESULTS as any);

    const last = body.input[body.input.length - 1];
    expect(last.type).toBe('function_call_output');
    expect(last.call_id).toBe('call_1');
    expect(last.output).toContain('https://w.example/berlin');
  });
});

describe('responsesAdapter — output items', () => {
  it('identifies a web_search function call output item', () => {
    expect(isWebSearchFunctionCall({ type: 'function_call', name: 'web_search' })).toBe(true);
    expect(isWebSearchFunctionCall({ type: 'function_call', name: 'exec_command' })).toBe(false);
    expect(isWebSearchFunctionCall({ type: 'message' })).toBe(false);
  });

  it('parses the query from a JSON arguments string', () => {
    expect(parseQueryFromArguments('{"query":"weather in Berlin"}')).toBe('weather in Berlin');
  });

  it('returns an empty string for unparseable arguments', () => {
    expect(parseQueryFromArguments('{"quer')).toBe('');
    expect(parseQueryFromArguments(undefined)).toBe('');
  });

  it('builds a completed web_search_call item', () => {
    const item = buildWebSearchCallItem('weather in Berlin', 'ws_1');

    expect(item).toEqual({
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: { type: 'search', query: 'weather in Berlin' },
    });
  });

  it('builds a failed web_search_call item when asked', () => {
    expect(buildWebSearchCallItem('q', 'ws_1', 'failed').status).toBe('failed');
  });

  it('builds a message item with url_citation annotations', () => {
    const item = buildSearchMessageItem(RESULTS as any, 'weather in Berlin', 'msg_1');

    expect(item.type).toBe('message');
    expect(item.role).toBe('assistant');
    expect(item.status).toBe('completed');
    expect(item.content[0].type).toBe('output_text');
    expect(item.content[0].text).toContain('Berlin weather');
    expect(item.content[0].annotations[0]).toMatchObject({
      type: 'url_citation',
      url: 'https://w.example/berlin',
      title: 'Berlin weather',
    });
  });

  it('builds a message item that says so when there are no results', () => {
    const item = buildSearchMessageItem([], 'obscure query', 'msg_1');

    expect(item.content[0].text).toContain('No web search results');
    expect(item.content[0].annotations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --testPathPattern=responses-websearch-adapter
```

Expected: FAIL — `Cannot find module '../src/plugins/webSearch/responsesAdapter'`.

- [ ] **Step 3: Write the implementation**

Create `services/gateway/src/plugins/webSearch/responsesAdapter.ts`:

```typescript
/**
 * Pure helpers for emulating the hosted `web_search` tool in the OpenAI
 * Responses wire format.
 *
 * SAP AI Core deployments reject hosted tool types outright
 * (`The following tool is not allowed for model '<model>': web_search`), but
 * Codex CLI attaches one to every request and offers no way to turn it off. So
 * the gateway rewrites it into a plain function tool the deployment accepts,
 * runs the search itself, and hands the client back the hosted-tool shape it
 * expects — the same trick webSearchPlugin plays for Anthropic.
 *
 * Everything here is pure: no I/O, no config, no logging.
 */
import { SearchResult } from './searchExecutor';

/** The flat function tool a deployment accepts in place of the hosted one. */
export const RESPONSES_WEB_SEARCH_TOOL: Record<string, any> = {
  type: 'function',
  name: 'web_search',
  description: 'Search the web for current information. Use this tool when you need up-to-date information about topics, news, documentation, or any other web content.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query to look up on the web' },
    },
    required: ['query'],
  },
  strict: false,
};

export function hasResponsesWebSearchTool(tools: any): boolean {
  return Array.isArray(tools) && tools.some(t => t && t.type === 'web_search');
}

/**
 * Replace every hosted web_search entry with the function-tool equivalent.
 * Mutates in place; returns whether anything changed.
 *
 * An empty `tools` array is removed rather than forwarded: some deployments
 * reject `"tools": []`.
 */
export function transformResponsesWebSearchTool(body: any): boolean {
  if (!body || !Array.isArray(body.tools)) return false;

  let changed = false;
  body.tools = body.tools.map((t: any) => {
    if (t && t.type === 'web_search') {
      changed = true;
      return { ...RESPONSES_WEB_SEARCH_TOOL };
    }
    return t;
  });

  if (body.tools.length === 0) delete body.tools;
  return changed;
}

export function isWebSearchFunctionCall(item: any): boolean {
  return !!item && item.type === 'function_call' && item.name === 'web_search';
}

/** Read the `query` out of a function call's JSON arguments string. */
export function parseQueryFromArguments(args: any): string {
  if (typeof args !== 'string') return '';
  try {
    const parsed = JSON.parse(args);
    return typeof parsed?.query === 'string' ? parsed.query : '';
  } catch {
    return '';
  }
}

/**
 * A web_search call from the previous turn whose result was never supplied.
 * The client replays the whole conversation (store: false), so this is how the
 * model gets to reason over search results without a second deployment call
 * inside one request.
 */
export function findPendingResponsesSearch(input: any): { callId: string; query: string } | null {
  if (!Array.isArray(input)) return null;

  const satisfied = new Set<string>();
  for (const item of input) {
    if (item && item.type === 'function_call_output' && typeof item.call_id === 'string') {
      satisfied.add(item.call_id);
    }
  }

  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!isWebSearchFunctionCall(item)) continue;
    if (typeof item.call_id !== 'string' || satisfied.has(item.call_id)) continue;
    return { callId: item.call_id, query: parseQueryFromArguments(item.arguments) };
  }
  return null;
}

/** Append the results for a pending call as a function_call_output item. */
export function appendFunctionCallOutput(body: any, callId: string, results: SearchResult[]): void {
  if (!body || !Array.isArray(body.input)) return;
  body.input.push({
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify({
      results: results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet, content: r.content, date: r.date })),
    }),
  });
}

/** Human-readable summary of the search, used as the assistant's message text. */
export function formatSearchSummaryText(results: SearchResult[], query: string): string {
  if (!results.length) {
    return `No web search results were found for "${query}".`;
  }
  const lines = results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet} (${r.url})`);
  return `Web search results for "${query}":\n\n${lines.join('\n')}`;
}

export function buildWebSearchCallItem(query: string, id: string, status: 'completed' | 'failed' = 'completed'): any {
  return { type: 'web_search_call', id, status, action: { type: 'search', query } };
}

export function buildSearchMessageItem(results: SearchResult[], query: string, id: string): any {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{
      type: 'output_text',
      text: formatSearchSummaryText(results, query),
      annotations: results.map(r => ({ type: 'url_citation', url: r.url, title: r.title })),
    }],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=responses-websearch-adapter
```

Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/plugins/webSearch/responsesAdapter.ts \
        services/gateway/test/responses-websearch-adapter.test.ts
git commit -m "feat(gateway): add Responses-shape web-search adapter helpers"
```

---

### Task 3: The plugin — non-streaming path and hook wiring

**Files:**
- Create: `services/gateway/src/plugins/responsesWebSearchPlugin.ts`
- Create: `services/gateway/src/plugins/responsesWebSearchPlugin.md`
- Modify: `services/gateway/api_config.json` (+ sync 2 copies)
- Test: `services/gateway/test/responses-websearch-plugin.test.ts`

**Interfaces:**
- Consumes: `executeWebSearch`, `SearchResult`, `Logger` from `./webSearch/searchExecutor` (Task 1); every export of `./webSearch/responsesAdapter` (Task 2).
- Produces: a CommonJS plugin-rules array via `export = pluginRules`, with `id: "responsesWebSearchPlugin"` and two entries, `strategy: "before"` and `strategy: "after"`. Task 4 adds the streaming interceptor to this same file.

**Plugin handler contract** (copied from `webSearchPlugin.ts`, which the loader already satisfies):

```typescript
interface PluginContext { req: Request; res: Response; utils: { logger: Logger }; upstreamResponse?: any }
interface PluginResult { stop: boolean; response?: any }
// before: async ({ req, utils }: PluginContext) => Promise<PluginResult>
// after:  async ({ req, upstreamResponse, utils }: PluginContext) => Promise<any>
```

Note `utils.logger` takes `(message, meta?)` — two parameters, unlike the gateway's 4-parameter `logger.error`.

- [ ] **Step 1: Write the failing tests**

Create `services/gateway/test/responses-websearch-plugin.test.ts`:

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockExecuteWebSearch = jest.fn();
jest.mock('../src/plugins/webSearch/searchExecutor', () => ({
  __esModule: true,
  executeWebSearch: (...a: any[]) => mockExecuteWebSearch(...a),
}));

import pluginRules = require('../src/plugins/responsesWebSearchPlugin');

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const after = (pluginRules as any[]).find(r => r.strategy === 'after').handler;

const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };
const RESULTS = [{ title: 'Berlin weather', url: 'https://w.example/berlin', snippet: 'Mild', content: 'Mild and dry' }];

describe('responsesWebSearchPlugin — before handler', () => {
  beforeEach(() => { mockExecuteWebSearch.mockReset(); mockExecuteWebSearch.mockResolvedValue(RESULTS); });

  it('rewrites the hosted tool into a function tool', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'hi', tools: [{ type: 'web_search', external_web_access: false }] } };

    await before({ req, res: {} as any, utils });

    expect(req.body.tools[0].type).toBe('function');
    expect(req.body.tools[0].name).toBe('web_search');
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('leaves a request with no hosted tool untouched', async () => {
    const req: any = { body: { input: 'hi', tools: [{ type: 'function', name: 'exec_command' }] } };
    const snapshot = JSON.parse(JSON.stringify(req.body));

    const result = await before({ req, res: {} as any, utils });

    expect(result).toEqual({ stop: false });
    expect(req.body).toEqual(snapshot);
  });

  it('executes a pending search and appends its function_call_output', async () => {
    const req: any = { body: {
      tools: [{ type: 'web_search' }],
      input: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' }],
    } };

    await before({ req, res: {} as any, utils });

    expect(mockExecuteWebSearch).toHaveBeenCalledWith('weather in Berlin', utils.logger);
    const last = req.body.input[req.body.input.length - 1];
    expect(last.type).toBe('function_call_output');
    expect(last.call_id).toBe('call_1');
    expect(last.output).toContain('https://w.example/berlin');
  });

  it('never throws when the search fails', async () => {
    mockExecuteWebSearch.mockRejectedValue(new Error('perplexity down'));
    const req: any = { body: {
      tools: [{ type: 'web_search' }],
      input: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' }],
    } };

    await expect(before({ req, res: {} as any, utils })).resolves.toEqual({ stop: false });
    expect(req.body.tools[0].type).toBe('function');
  });
});

describe('responsesWebSearchPlugin — after handler', () => {
  beforeEach(() => { mockExecuteWebSearch.mockReset(); mockExecuteWebSearch.mockResolvedValue(RESULTS); });

  it('replaces a web_search function call with web_search_call + message items', async () => {
    const req: any = { body: { tools: [{ type: 'function', name: 'web_search' }] } };
    const upstreamResponse = {
      id: 'resp_1',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' },
      ],
    };

    const out = await after({ req, upstreamResponse, utils });

    expect(out.output.map((i: any) => i.type)).toEqual(['reasoning', 'web_search_call', 'message']);
    expect(out.output[1].action.query).toBe('weather in Berlin');
    expect(out.output[2].content[0].annotations[0].url).toBe('https://w.example/berlin');
  });

  it('passes a response with no web_search call through unchanged', async () => {
    const req: any = { body: {} };
    const upstreamResponse = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] };

    const out = await after({ req, upstreamResponse, utils });

    expect(out).toBe(upstreamResponse);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('emits a failed web_search_call when the search throws', async () => {
    mockExecuteWebSearch.mockRejectedValue(new Error('perplexity down'));
    const req: any = { body: {} };
    const upstreamResponse = { output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' }] };

    const out = await after({ req, upstreamResponse, utils });

    expect(out.output[0].type).toBe('web_search_call');
    expect(out.output[0].status).toBe('failed');
  });

  it('returns the original response when output is not an array', async () => {
    const req: any = { body: {} };
    const upstreamResponse = { error: 'nope' };

    expect(await after({ req, upstreamResponse, utils })).toBe(upstreamResponse);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --testPathPattern=responses-websearch-plugin
```

Expected: FAIL — `Cannot find module '../src/plugins/responsesWebSearchPlugin'`.

- [ ] **Step 3: Write the plugin**

Create `services/gateway/src/plugins/responsesWebSearchPlugin.ts`:

```typescript
/**
 * Responses API web-search plugin.
 *
 * SAP AI Core deployments reject the hosted `web_search` tool outright, and
 * Codex CLI attaches one to every request with no way to disable it — so
 * without this plugin the /openai/v1/responses route is unusable from Codex.
 *
 * Strategy mirrors webSearchPlugin (the Anthropic equivalent):
 *   before — rewrite the hosted tool into a plain function tool the deployment
 *            accepts, and back-fill results for a search left pending from the
 *            previous turn.
 *   after  — replace the model's function_call with the synthetic
 *            web_search_call + message items the client expects.
 *
 * The model reasons over results on the client's NEXT turn (via the pending
 * back-fill), not through a second deployment call inside this request.
 *
 * Ordering: pseudonymizationPlugin runs first on the request side, so the query
 * handed to Perplexity is already masked. Do not reorder the hook arrays.
 *
 * @see api_config.json - defaultHooks.openai.responses / responses-stream
 * @see responsesWebSearchPlugin.md - documentation
 */
import { Request, Response } from 'express';
import { executeWebSearch, Logger, SearchResult } from './webSearch/searchExecutor';
import {
  hasResponsesWebSearchTool,
  transformResponsesWebSearchTool,
  findPendingResponsesSearch,
  appendFunctionCallOutput,
  isWebSearchFunctionCall,
  parseQueryFromArguments,
  buildWebSearchCallItem,
  buildSearchMessageItem,
} from './webSearch/responsesAdapter';

interface PluginContext {
  req: Request;
  res: Response;
  utils: { logger: Logger };
  upstreamResponse?: any;
}

interface PluginResult {
  stop: boolean;
  response?: any;
}

/** Marks a request whose hosted tool we rewrote, so the after handler knows to look. */
const REWROTE_FLAG = '__responsesWebSearchRewritten';

let syntheticCounter = 0;
function syntheticId(prefix: string): string {
  syntheticCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${syntheticCounter.toString(36)}`;
}

async function beforeHandler({ req, utils }: PluginContext): Promise<PluginResult> {
  const pluginLogger = utils.logger;

  try {
    const body: any = req.body;
    if (!body) return { stop: false };

    if (!hasResponsesWebSearchTool(body.tools)) {
      return { stop: false };
    }

    transformResponsesWebSearchTool(body);
    (req as any)[REWROTE_FLAG] = true;
    pluginLogger.info('Rewrote hosted web_search tool into a function tool');

    const pending = findPendingResponsesSearch(body.input);
    if (!pending) return { stop: false };

    pluginLogger.info(`Executing pending web_search ${pending.callId}: "${pending.query}"`);
    const results = await executeWebSearch(pending.query, pluginLogger);
    appendFunctionCallOutput(body, pending.callId, results);
    pluginLogger.info(`Injected ${results.length} search results as function_call_output`);

    return { stop: false };
  } catch (error: any) {
    pluginLogger.error(`Error in responsesWebSearchPlugin beforeHandler: ${error.message}`, { stack: error.stack });
    return { stop: false };
  }
}

async function afterHandler({ upstreamResponse, utils }: PluginContext): Promise<any> {
  const pluginLogger = utils.logger;

  try {
    const output = upstreamResponse?.output;
    if (!Array.isArray(output)) return upstreamResponse;
    if (!output.some(isWebSearchFunctionCall)) return upstreamResponse;

    const rebuilt: any[] = [];
    for (const item of output) {
      if (!isWebSearchFunctionCall(item)) {
        rebuilt.push(item);
        continue;
      }

      const query = parseQueryFromArguments(item.arguments);
      let results: SearchResult[] = [];
      let status: 'completed' | 'failed' = 'completed';

      try {
        results = await executeWebSearch(query, pluginLogger);
      } catch (error: any) {
        status = 'failed';
        pluginLogger.error(`Web search failed for "${query}": ${error.message}`);
      }

      rebuilt.push(buildWebSearchCallItem(query, syntheticId('ws'), status));
      rebuilt.push(buildSearchMessageItem(results, query, syntheticId('msg')));
    }

    return { ...upstreamResponse, output: rebuilt };
  } catch (error: any) {
    pluginLogger.error(`Error in responsesWebSearchPlugin afterHandler: ${error.message}`, { stack: error.stack });
    return upstreamResponse;
  }
}

const pluginRules = [
  { id: 'responsesWebSearchPlugin', match: [], strategy: 'before', handler: beforeHandler },
  { id: 'responsesWebSearchPlugin', match: [], strategy: 'after', handler: afterHandler },
];

export = pluginRules;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=responses-websearch-plugin
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Wire the hooks in `api_config.json`**

In `services/gateway/api_config.json`, under `api_config.defaultHooks.openai`, the `responses` and `responses-stream` arrays currently hold one entry each (`pseudonymizationPlugin`). Append a second entry to **each** array, after the existing one:

```json
          {
            "request": {
              "callback": { "id": "responsesWebSearchPlugin" },
              "match": ["tools:hasWebSearch"]
            }
          }
```

Order matters: `pseudonymizationPlugin` stays first so the query reaching Perplexity is masked.

The `tools:hasWebSearch` hook definition already exists under `api_config.hookDefinitions` and is reused as-is — do not add a new one.

- [ ] **Step 6: Sync the three config copies**

```bash
cd /Users/grundmanns/Documents/repos/project
git add services/gateway/api_config.json
node cli-tools/sync-api-config.js
md5 -q services/gateway/api_config.json \
       services/admin/api_config.json \
       npm-dist/sail-proxy/src/templates/api_config.template.json
```

Expected: three identical hashes. Those three paths are `SOURCE_FILE` + `TARGET_FILES` in `cli-tools/sync-api-config.js`; note the npm-dist copy is a *template* under `src/templates/`, not a bare `api_config.json`.

- [ ] **Step 7: Write the plugin documentation**

Create `services/gateway/src/plugins/responsesWebSearchPlugin.md` covering: the problem (SAP rejects hosted tools, Codex always sends one), the two-phase strategy, the hook configuration shown in Step 5 including why `pseudonymizationPlugin` is listed first, the request/response shapes from Task 2, the inherited limitations (Perplexity usage not merged into the usage event; orchestration fallback strips real citations), and a `curl` example against `/openai/v1/responses` with a `{"type":"web_search"}` tool. Cross-reference `webSearchPlugin.md` as the Anthropic sibling.

- [ ] **Step 8: Full suite and commit**

```bash
cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 44 suites (Task 2 added `responses-websearch-adapter.test.ts`, this task adds `responses-websearch-plugin.test.ts`), 547 tests (521 + 18 + 8). No pre-existing test may fail.

```bash
cd /Users/grundmanns/Documents/repos/project
git add services/gateway/src/plugins/responsesWebSearchPlugin.ts \
        services/gateway/src/plugins/responsesWebSearchPlugin.md \
        services/gateway/test/responses-websearch-plugin.test.ts \
        services/gateway/api_config.json services/admin/api_config.json \
        npm-dist/sail-proxy/src/templates/api_config.template.json
git commit -m "feat(gateway): emulate the hosted web_search tool on the Responses route"
```

---

### Task 4: Streaming — suppress and inject

The non-streaming after handler never runs for `stream: true`; the controller pipes upstream bytes straight through. If the raw `function_call` frames reach Codex it will try to execute a tool it has no handler for, so they must be suppressed and replaced.

The search is asynchronous but `res.write` is synchronous. The interceptor therefore **queues** everything written while a search is in flight and flushes it after injecting the synthetic frames, and defers `res.end` if it lands during that window.

**Files:**
- Modify: `services/gateway/src/plugins/responsesWebSearchPlugin.ts`
- Test: `services/gateway/test/responses-websearch-stream.test.ts`

**Interfaces:**
- Consumes: everything from Task 3, plus `buildWebSearchCallItem` / `buildSearchMessageItem` / `parseQueryFromArguments` from Task 2.
- Produces: no new exports. `beforeHandler` gains a call to `installResponsesWebSearchInterceptor(req, res)` when `req.body.stream === true`.

**Interceptor ordering (do not change).** `pseudonymizationPlugin` installs its own `res.write` patch from its before handler and is listed first, so it patches first. This plugin patches on top, which means a write flows *this interceptor first, then pseudonymization's unmasker, then the socket* — exactly the required order: synthetic frames are injected while still masked, then unmasked with everything else.

- [ ] **Step 1: Write the failing tests**

Create `services/gateway/test/responses-websearch-stream.test.ts`:

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockExecuteWebSearch = jest.fn();
jest.mock('../src/plugins/webSearch/searchExecutor', () => ({
  __esModule: true,
  executeWebSearch: (...a: any[]) => mockExecuteWebSearch(...a),
}));

import pluginRules = require('../src/plugins/responsesWebSearchPlugin');

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };
const RESULTS = [{ title: 'Berlin weather', url: 'https://w.example/berlin', snippet: 'Mild', content: 'Mild and dry' }];

function mockRes() {
  const written: string[] = [];
  let ended = false;
  return {
    written,
    get ended() { return ended; },
    write(chunk: any) { written.push(chunk.toString()); return true; },
    end(chunk?: any) { if (chunk) written.push(chunk.toString()); ended = true; return this as any; },
    setHeader() { /* no-op */ },
    headersSent: false,
    writableEnded: false,
  } as any;
}

function frames(written: string[]): any[] {
  return written.join('')
    .split('\n\n')
    .map(b => b.trim())
    .filter(b => b.startsWith('data: '))
    .map(b => JSON.parse(b.slice(6)));
}

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }

/** Let the queued search promise settle. */
const settle = () => new Promise(r => setTimeout(r, 0));

describe('responsesWebSearchPlugin — streaming', () => {
  beforeEach(() => { mockExecuteWebSearch.mockReset(); mockExecuteWebSearch.mockResolvedValue(RESULTS); });

  it('suppresses web_search function-call frames and injects synthetic items', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };

    await before({ req, res, utils });

    res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }));
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '' } }));
    res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"query":"weather ' }));
    res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'in Berlin"}' }));
    res.write(sse({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"query":"weather in Berlin"}' }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' } }));
    await settle();
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 10, output_tokens: 2 } } }));

    const types = frames(res.written).map(f => f.type);

    expect(types).not.toContain('response.function_call_arguments.delta');
    expect(types).not.toContain('response.function_call_arguments.done');
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types[types.length - 1]).toBe('response.completed');

    const added = frames(res.written).filter(f => f.type === 'response.output_item.added');
    expect(added.map(f => f.item.type)).toEqual(['web_search_call', 'message']);
    expect(added[0].item.action.query).toBe('weather in Berlin');

    expect(mockExecuteWebSearch).toHaveBeenCalledWith('weather in Berlin', utils.logger);
  });

  it('passes frames for other items straight through', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'hi' } };

    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'exec_command', arguments: '' } }));
    res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"cmd":"ls"}' }));

    const types = frames(res.written).map(f => f.type);
    expect(types).toEqual(['response.output_item.added', 'response.function_call_arguments.delta']);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('queues frames that arrive while the search is in flight, preserving order', async () => {
    let release: (v: any) => void = () => {};
    mockExecuteWebSearch.mockReturnValue(new Promise(r => { release = r; }));

    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1' } }));

    expect(frames(res.written).map(f => f.type)).not.toContain('response.completed');

    release(RESULTS);
    await settle();

    const types = frames(res.written).map(f => f.type);
    expect(types[types.length - 1]).toBe('response.completed');
    expect(types).toContain('response.output_item.added');
  });

  it('emits a failed web_search_call when the search rejects mid-stream', async () => {
    mockExecuteWebSearch.mockRejectedValue(new Error('perplexity down'));
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    await settle();

    const added = frames(res.written).filter(f => f.type === 'response.output_item.added');
    expect(added[0].item.type).toBe('web_search_call');
    expect(added[0].item.status).toBe('failed');
  });

  it('defers res.end until a queued search has flushed', async () => {
    let release: (v: any) => void = () => {};
    mockExecuteWebSearch.mockReturnValue(new Promise(r => { release = r; }));

    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.end();

    expect(res.ended).toBe(false);

    release(RESULTS);
    await settle();

    expect(res.ended).toBe(true);
  });

  it('does not install an interceptor for a non-streaming request', async () => {
    const res = mockRes();
    const originalWrite = res.write;
    const req: any = { body: { stream: false, tools: [{ type: 'web_search' }], input: 'hi' } };

    await before({ req, res, utils });

    expect(res.write).toBe(originalWrite);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --testPathPattern=responses-websearch-stream
```

Expected: FAIL — frames pass through unsuppressed; `response.function_call_arguments.delta` is present.

- [ ] **Step 3: Add the interceptor to the plugin**

In `services/gateway/src/plugins/responsesWebSearchPlugin.ts`, add before `beforeHandler`:

```typescript
const INTERCEPTOR_FLAG = '__responsesWebSearchInterceptorInstalled';

/** Re-frame arbitrary write boundaries into whole `data: {json}\n\n` blocks. */
function splitBlocks(pending: string): { blocks: string[]; tail: string } {
  const parts = pending.split('\n\n');
  const tail = parts.pop() ?? '';
  return { blocks: parts.map(p => `${p}\n\n`), tail };
}

function parseFrame(block: string): any | null {
  const line = block.split('\n').find(l => l.startsWith('data: '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(6));
  } catch {
    return null;
  }
}

function sseBlock(frame: any): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/**
 * Suppress the raw function_call frames for a hosted web_search and inject the
 * synthetic web_search_call + message frames in their place.
 *
 * res.write is synchronous but the search is not, so once a suppressed item
 * completes every later write is queued and flushed after the injection. res.end
 * is deferred the same way, or the stream would close before the results land.
 */
function installResponsesWebSearchInterceptor(req: Request, res: Response, pluginLogger: Logger): void {
  if ((res as any)[INTERCEPTOR_FLAG]) return;
  if (typeof (res as any).write !== 'function' || typeof (res as any).end !== 'function') return;
  (res as any)[INTERCEPTOR_FLAG] = true;

  const originalWrite = (res as any).write.bind(res);
  const originalEnd = (res as any).end.bind(res);

  let tail = '';                          // partial block held across writes
  let queue: string[] = [];               // blocks held while a search is in flight
  let searching = false;
  let endPending = false;
  let endArgs: any[] = [];

  const suppressed = new Map<number, { callId: string; args: string }>();

  const flush = (): void => {
    const pendingBlocks = queue;
    queue = [];
    for (const block of pendingBlocks) originalWrite(block);
    if (endPending) {
      endPending = false;
      originalEnd(...endArgs);
    }
  };

  const emit = (block: string): void => {
    if (searching) queue.push(block);
    else originalWrite(block);
  };

  const runSearch = async (index: number, query: string): Promise<void> => {
    let results: SearchResult[] = [];
    let status: 'completed' | 'failed' = 'completed';
    try {
      results = await executeWebSearch(query, pluginLogger);
    } catch (error: any) {
      status = 'failed';
      pluginLogger.error(`Web search failed mid-stream for "${query}": ${error.message}`);
    }

    const callItem = buildWebSearchCallItem(query, syntheticId('ws'), status);
    const messageItem = buildSearchMessageItem(results, query, syntheticId('msg'));

    originalWrite(sseBlock({ type: 'response.output_item.added', output_index: index, item: callItem }));
    originalWrite(sseBlock({ type: 'response.output_item.done', output_index: index, item: callItem }));
    originalWrite(sseBlock({ type: 'response.output_item.added', output_index: index, item: { ...messageItem, content: [] } }));
    originalWrite(sseBlock({
      type: 'response.output_text.delta', output_index: index, content_index: 0,
      item_id: messageItem.id, delta: messageItem.content[0].text,
    }));
    originalWrite(sseBlock({
      type: 'response.output_text.done', output_index: index, content_index: 0,
      item_id: messageItem.id, text: messageItem.content[0].text,
    }));
    originalWrite(sseBlock({ type: 'response.output_item.done', output_index: index, item: messageItem }));

    searching = false;
    flush();
  };

  (res as any).write = function patchedWrite(chunk: any, ...rest: any[]): boolean {
    try {
      tail += chunk?.toString?.('utf8') ?? String(chunk);
      const { blocks, tail: newTail } = splitBlocks(tail);
      tail = newTail;

      for (const block of blocks) {
        const frame = parseFrame(block);
        if (!frame || typeof frame.output_index !== 'number') { emit(block); continue; }

        const index = frame.output_index;

        if (frame.type === 'response.output_item.added' && isWebSearchFunctionCall(frame.item)) {
          suppressed.set(index, { callId: frame.item.call_id, args: frame.item.arguments || '' });
          continue;                                    // suppressed
        }

        const tracked = suppressed.get(index);
        if (!tracked) { emit(block); continue; }

        if (frame.type === 'response.function_call_arguments.delta') {
          tracked.args += frame.delta ?? '';
          continue;
        }
        if (frame.type === 'response.function_call_arguments.done') {
          if (typeof frame.arguments === 'string') tracked.args = frame.arguments;
          continue;
        }
        if (frame.type === 'response.output_item.done') {
          if (frame.item && typeof frame.item.arguments === 'string') tracked.args = frame.item.arguments;
          suppressed.delete(index);
          searching = true;
          void runSearch(index, parseQueryFromArguments(tracked.args));
          continue;
        }
        continue;                                      // any other frame for this item
      }
      return true;
    } catch (error: any) {
      pluginLogger.error(`responsesWebSearchPlugin interceptor error: ${error.message}`);
      return originalWrite(chunk, ...rest);
    }
  };

  (res as any).end = function patchedEnd(...args: any[]): any {
    if (searching) {
      endPending = true;
      endArgs = args;
      return res;
    }
    return originalEnd(...args);
  };
}
```

Task 3's `beforeHandler` destructures only `{ req, utils }`. Widen it to take `res`:

```typescript
async function beforeHandler({ req, res, utils }: PluginContext): Promise<PluginResult> {
```

Then, immediately after `pluginLogger.info('Rewrote hosted web_search tool into a function tool');`, add:

```typescript
    if (body.stream === true) {
      installResponsesWebSearchInterceptor(req, res, pluginLogger);
    }
```

The interceptor is installed for every streaming request carrying a hosted `web_search` tool, whether or not the model ends up calling it — a request that never triggers a search simply passes every frame through.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=responses-websearch-stream
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Confirm the non-streaming tests still pass**

```bash
npm test -- --testPathPattern=responses-websearch
```

Expected: the adapter, plugin and stream suites all green — the `res` destructuring change must not have broken Task 3's tests.

- [ ] **Step 6: Full suite and commit**

```bash
npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 45 suites, 553 tests (547 + 6). No pre-existing test may fail.

```bash
git add services/gateway/src/plugins/responsesWebSearchPlugin.ts \
        services/gateway/test/responses-websearch-stream.test.ts
git commit -m "feat(gateway): suppress and replace web_search frames in Responses streams"
```

---

### Task 5: OpenRouter mount and documentation

**Files:**
- Modify: `services/gateway/src/routes/openRouterRoutes.ts`
- Modify: `services/gateway/src/index.ts` (startup log line)
- Modify: `README.md`, `docs/user/chapter-2-features.md`
- Test: `services/gateway/test/responses-routes.test.ts` (new)

**Interfaces:**
- Consumes: `handleResponses` from `../controllers/responsesController` (phase 1).
- Produces: no new exports.

`/openrouter/api/v1/chat/completions` already funnels into `openaiController`, which tags `__endpoint = 'openai'`, so the mounted route resolves hooks against `defaultHooks.openai.responses` with **no config change**. Mount `handleResponses` behind the same middleware chain the file's existing routes use.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/responses-routes.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const routesDir = path.join(__dirname, '..', 'src', 'routes');

describe('Responses route mounts', () => {
  it('mounts /responses on the OpenRouter router with the same handler as the OpenAI route', () => {
    const openRouter = fs.readFileSync(path.join(routesDir, 'openRouterRoutes.ts'), 'utf-8');

    expect(openRouter).toContain('handleResponses');
    expect(openRouter).toMatch(/router\.post\(\s*['"]\/responses['"]/);
  });

  it('keeps the OpenAI Responses route intact', () => {
    const responses = fs.readFileSync(path.join(routesDir, 'responsesRoutes.ts'), 'utf-8');
    expect(responses).toContain('handleResponses');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --testPathPattern=responses-routes
```

Expected: FAIL — `openRouterRoutes.ts` contains no `handleResponses`.

- [ ] **Step 3: Mount the route**

Read `services/gateway/src/routes/openRouterRoutes.ts` and `services/gateway/src/routes/responsesRoutes.ts` first. Add the `handleResponses` import to `openRouterRoutes.ts` and register `router.post('/responses', …)` behind **the identical middleware chain** the file's existing `POST` routes use (auth → service-auth → rate-limit → rateLimiter). Do not invent a chain; copy the neighbouring route's.

- [ ] **Step 4: Add the startup log line**

In `services/gateway/src/index.ts`, next to the existing OpenRouter log lines (near `- OpenRouter Models:`), add:

```typescript
    logger.info('Gateway Service', `- OpenRouter Responses: http://${config.host}:${config.port}/openrouter/api/v1/responses`);
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=responses-routes
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Update the documentation**

In `docs/user/chapter-2-features.md`, under `#### OpenAI Responses API`:
- add `/openrouter/api/v1/responses` to the **Endpoint** line as an alias;
- add a bullet: hosted `web_search` is emulated gateway-side through Perplexity `sonar-pro`, so a client that sends `{"type":"web_search"}` gets `web_search_call` + message items back; the model reasons over the results on the following turn;
- in the `##### Using Codex CLI` subsection, remove nothing about `multi_agent` (still required) but delete any statement implying `web_search` prevents use of the route.

In `README.md`, add `/openrouter/api/v1/responses` to the endpoint table near the two existing Responses rows (lines 74–75), and — in the Codex CLI section — replace the `--disable multi_agent` note only if it also mentions web search; the `multi_agent` caveat itself stays.

- [ ] **Step 7: Full suite and commit**

```bash
cd services/gateway && npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 46 suites, 555 tests (553 + 2). No pre-existing test may fail.

```bash
cd /Users/grundmanns/Documents/repos/project
git add services/gateway/src/routes/openRouterRoutes.ts services/gateway/src/index.ts \
        services/gateway/test/responses-routes.test.ts \
        README.md docs/user/chapter-2-features.md
git commit -m "feat(gateway): mount the Responses route under /openrouter/api/v1"
```

---

## Live Verification (after all tasks)

Unit tests cannot prove Codex compatibility. This is the acceptance gate.

- [ ] **Step 1: Publish the config**

The gateway reads config from the admin service in distributed mode, and an activated configuration *replaces* the file config. Create and activate a new configuration from the updated `services/gateway/api_config.json`:

```bash
python3 -c "
import json
cfg = open('services/gateway/api_config.json').read()
print(json.dumps({'name':'responses-web-search','configData':cfg,'description':'Adds responsesWebSearchPlugin to defaultHooks.openai.responses / responses-stream'}))
" > /tmp/createcfg.json

curl -s -u admin@test.com:admin -H "Content-Type: application/json" \
  -X POST http://localhost:4004/odata/v4/admin/createConfiguration --data-binary @/tmp/createcfg.json
# then, with the returned configId:
curl -s -u admin@test.com:admin -H "Content-Type: application/json" \
  -X POST http://localhost:4004/odata/v4/admin/activateConfiguration -d '{"configId":"<id>"}'
```

- [ ] **Step 2: Restart the gateway**

Plugin code loads only on restart or on an admin config-change event. **Ask the human partner before restarting** — the gateway requires the admin service in distributed mode, and killing it mid-session has broken this environment before.

- [ ] **Step 3: Non-streaming probe**

```bash
curl -s -X POST http://localhost:3000/openai/v1/responses \
  -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"gpt-5.3-codex--deployed","store":false,
       "input":"What is the current weather in Berlin?",
       "tools":[{"type":"web_search"}],"max_output_tokens":2000}'
```

Expected: HTTP 200, and `output` containing a `web_search_call` item followed by a `message` item with `url_citation` annotations. **Not** a 400 naming `web_search`.

- [ ] **Step 4: Streaming probe**

The same body with `"stream": true`. Expected: no `response.function_call_arguments.delta` frame anywhere in the stream, and `response.output_item.added` frames for `web_search_call` and `message`.

- [ ] **Step 5: Masking check**

Include a PII value in the prompt, then inspect the newest payload logs in `services/gateway/logs/payloads`. The `02_responses_request_to_deployment` file must contain `MASKED_*` tokens and no raw value, and the client's output must show the real value restored.

- [ ] **Step 6: Anthropic regression**

Run one Claude Code request that uses web search through `/anthropic/v1/messages` and confirm results still come back with citations — this is what proves the Task 1 extraction was inert in production, not just in tests.

- [ ] **Step 7: Codex CLI without the shim**

```bash
export SAILPROXY_API_KEY=<key>
codex exec --disable multi_agent "Search the web for the latest Node.js LTS version and write it to node-lts.txt"
```

Expected: completes, having actually performed a search, pointed **directly at port 3000** with no `striptools.js` shim in the path.

---

## Self-Review

**Spec coverage.** Shared search core → Task 1. Responses wire-format helpers → Task 2. Plugin before/after + hook wiring + ordering constraint + plugin docs → Task 3. Streaming suppress-and-inject including the mid-stream failure path → Task 4. OpenRouter mount → Task 5. Error-handling rules → inherited via Task 1's verbatim move, with the failed-`web_search_call` behaviour explicit in Tasks 3 and 4. Known limitations → documented in Task 3, Step 7. Testing section → each task's tests plus the Live Verification block. `file_search` → excluded in Global Constraints and never referenced.

**Placeholders.** None: every code step carries the actual code, every test step the actual assertions, and every command the actual invocation. The two steps that deliberately say "read the neighbouring code first" (Task 5 Step 3's middleware chain, Task 3 Step 7's prose docs) name exactly what to copy and why, rather than leaving the engineer to guess.

**Type consistency.** `SearchResult` and `Logger` are defined once in Task 1 and imported by Tasks 2–4. `executeWebSearch(query, pluginLogger)` keeps its signature across the extraction and all three call sites. The adapter functions named in Task 2's Interfaces block are the exact names imported in Tasks 3 and 4. `buildWebSearchCallItem(query, id, status?)` and `buildSearchMessageItem(results, query, id)` are called with that argument order in both the non-streaming and streaming paths.
