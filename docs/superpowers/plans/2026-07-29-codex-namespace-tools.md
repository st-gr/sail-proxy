# Codex Sub-Agent (`namespace`) Tool Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex's sub-agent feature work through the gateway — SAP AI Core rejects the `namespace` tool wrapper with a 400 that kills the turn, so the gateway flattens it outbound and restores the `namespace` field on the way back, which Codex requires to route the call.

**Architecture:** A two-phase transformation, the same shape as the web-search emulation it sits beside. **Outbound:** hoist a `namespace` tool's nested function tools to the top level, drop the wrapper, and record `toolName → namespaceName` on the request. **Inbound:** re-add `namespace` to every `function_call` naming a hoisted tool, on the non-streaming path and in the streaming frames. Both halves are required — see the evidence below.

**Tech Stack:** TypeScript, Express 4, Jest. SAP AI Core deployments serving the OpenAI Responses API; Codex CLI as the driving client.

---

## Context — measured, not assumed

`namespace` is a **documented OpenAI Responses feature**, not a Codex invention: it groups related tools so the model gets a better selection surface ([OpenAI tool-search guide](https://developers.openai.com/api/docs/guides/tools-tool-search)). SAP AI Core does not allow the type for these models and rejects the whole request:

```
400 {"error":"BadRequest","message":"The following tools are not allowed for model 'gpt-5.3-codex': namespace and web_search."}
```

`web_search` was solved in phases 2–3. `namespace` is still worked around by telling users `--disable multi_agent` (`docs/user/chapter-2-features.md:81`), which switches the feature off.

**What Codex actually sends** — captured by pointing Codex CLI 0.145.0 at a local recording server:

```jsonc
{ "type": "namespace", "name": "multi_agent_v1",
  "description": "Tools for spawning and managing sub-agents.",
  "tools": [ /* 5 ordinary function tools */
    { "type": "function", "name": "close_agent",  "parameters": {…}, "strict": false },
    { "type": "function", "name": "resume_agent", … },
    { "type": "function", "name": "send_input",   … },
    { "type": "function", "name": "spawn_agent",  … },
    { "type": "function", "name": "wait_agent",   … } ] }
```

The nested entries are already valid top-level function tools — identical in shape to the ones the same request sends successfully alongside them. That is what makes flattening viable.

**What a namespaced call looks like coming back** — per the OpenAI guide, it carries a `namespace` field:

```json
{ "type": "function_call", "name": "list_open_orders", "namespace": "crm",
  "call_id": "call_abc123", "arguments": "{\"customer_id\":\"CUST-12345\"}" }
```

### The measurement that decides the architecture

I replied to Codex with a call for the real v1 tool `close_agent` (deliberately wrong arguments), once **without** the `namespace` field and once **with** it:

| Reply shape | What Codex did |
|---|---|
| no `namespace` | `ERROR codex_core::tools::router: error=unsupported call: close_agent` — the router never found the tool |
| `namespace: "multi_agent_v1"` | `failed to parse function arguments: missing field 'target'` — **the tool executed**, failing only on the bad arguments I supplied |

**Codex routes namespaced tools by `(namespace, name)`, not by name alone.** So flattening on its own would ship a broken feature: the deployment would accept the request, the model would call `spawn_agent`, and Codex would refuse to dispatch it. The inbound half is not optional.

This is why the transformation is a **plugin with both halves**, not a controller-side payload tweak.

---

## Global Constraints

- **Live product.** Absent config must mean the improved-but-safe default; chat-completions, Anthropic and AWS Bedrock must not regress. Only the Responses route is touched.
- **Both halves or neither.** A flatten with no re-nest is worse than today's 400 — it fails silently at the client instead of loudly at the gateway. If the inbound half cannot be made to work on a path, that path must use `strip` mode.
- **Plugin ordering is load-bearing.** `pseudonymizationPlugin` is index 0 in every hook array and patches `res.write` first; anything added patches on top. Never reorder.
- Three `api_config.json` copies must stay md5-identical: `services/gateway/api_config.json` (source of truth), `services/admin/api_config.json`, `npm-dist/sail-proxy/src/templates/api_config.template.json`. Sync with `git add services/gateway/api_config.json && node cli-tools/sync-api-config.js` from the repo root; never hand-edit the latter two.
- Every web-search hook entry is gated on `header:contentTypeJson` alongside its match rule, and `responses-hooks-config.test.ts` enforces that structurally across all hook arrays. A new plugin's entries must satisfy the same invariant.
- The **plugin** logger (`utils.logger`) is `(message, meta?)`. The gateway logger is `logger.error(component, message, error?: Error, metadata?: any)` — 3rd param `Error`-typed.
- Commit messages carry no Claude or Co-Authored-By attribution. Author is st-gr.
- Baseline: **667 tests / 53 suites** green, `npx tsc --noEmit -p tsconfig.json` clean, both from `services/gateway`. No pre-existing test may fail.

---

## File Structure

| File | Responsibility |
|---|---|
| `services/gateway/src/plugins/namespaceTools/adapter.ts` (new) | Pure: flatten outbound, build the map, re-nest inbound items and frames |
| `services/gateway/src/plugins/responsesNamespaceToolsPlugin.ts` (new) | before/after handlers + the streaming interceptor |
| `services/gateway/src/plugins/responsesNamespaceToolsPlugin.md` (new) | Operator documentation |
| `services/gateway/src/services/configService.ts` (modify) | `getNamespaceToolMode()` |
| `services/gateway/api_config.json` (+2 synced copies) | `namespace_tools.mode`, hook entries |
| `services/admin/src/schemas/api-config-schema.json` (modify) | Declare the key |
| `docs/user/chapter-2-features.md`, `README.md` (modify) | Drop the `--disable multi_agent` workaround |

---

### Task 1: Pure adapter

**Files:**
- Create: `services/gateway/src/plugins/namespaceTools/adapter.ts`
- Test: `services/gateway/test/namespace-tools-adapter.test.ts`

**Interfaces:**
- Produces:
  - `export type NamespaceToolMode = 'flatten' | 'strip'`
  - `export const DEFAULT_NAMESPACE_TOOL_MODE: NamespaceToolMode` (`'flatten'`)
  - `export function resolveNamespaceToolMode(value: unknown): NamespaceToolMode`
  - `export function flattenNamespaceTools(body: any, mode: NamespaceToolMode): { changed: boolean; map: Record<string,string>; hoisted: string[]; dropped: string[] }`
  - `export function renestFunctionCall(item: any, map: Record<string,string>): boolean` — mutates, returns whether it added a namespace
  - `export function renestOutputItems(output: any, map: Record<string,string>): number` — returns how many items were re-nested

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/namespace-tools-adapter.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import {
  flattenNamespaceTools, renestFunctionCall, renestOutputItems,
  resolveNamespaceToolMode, DEFAULT_NAMESPACE_TOOL_MODE,
} from '../src/plugins/namespaceTools/adapter';

const fn = (name: string) => ({
  type: 'function', name, description: `does ${name}`,
  parameters: { type: 'object', properties: {}, required: [] }, strict: false,
});

const NAMESPACE = {
  type: 'namespace', name: 'multi_agent_v1',
  description: 'Tools for spawning and managing sub-agents.',
  tools: [fn('close_agent'), fn('spawn_agent'), fn('wait_agent')],
};

describe('resolveNamespaceToolMode', () => {
  it('defaults to flatten', () => {
    expect(DEFAULT_NAMESPACE_TOOL_MODE).toBe('flatten');
    expect(resolveNamespaceToolMode(undefined)).toBe('flatten');
  });

  it('accepts the two valid modes and rejects everything else', () => {
    expect(resolveNamespaceToolMode('flatten')).toBe('flatten');
    expect(resolveNamespaceToolMode('strip')).toBe('strip');
    for (const bad of ['FLATTEN', 'off', '', 0, null, {}, [], true]) {
      expect(resolveNamespaceToolMode(bad as any)).toBe('flatten');
    }
  });
});

describe('flattenNamespaceTools', () => {
  it('hoists nested tools in place and records the map', () => {
    const body: any = { tools: [fn('exec_command'), { ...NAMESPACE }, fn('view_image')] };

    const r = flattenNamespaceTools(body, 'flatten');

    expect(r.changed).toBe(true);
    expect(body.tools.map((t: any) => t.name)).toEqual(
      ['exec_command', 'close_agent', 'spawn_agent', 'wait_agent', 'view_image']);
    expect(body.tools.some((t: any) => t.type === 'namespace')).toBe(false);
    expect(r.map).toEqual({
      close_agent: 'multi_agent_v1', spawn_agent: 'multi_agent_v1', wait_agent: 'multi_agent_v1',
    });
    expect(r.hoisted).toEqual(['close_agent', 'spawn_agent', 'wait_agent']);
  });

  it('hoists nested tools verbatim', () => {
    const body: any = { tools: [{ ...NAMESPACE }] };
    flattenNamespaceTools(body, 'flatten');
    expect(body.tools[0]).toEqual(NAMESPACE.tools[0]);
  });

  it('drops a nested tool whose name collides with a top-level one, and omits it from the map', () => {
    const body: any = { tools: [fn('spawn_agent'), { ...NAMESPACE }] };

    const r = flattenNamespaceTools(body, 'flatten');

    expect(body.tools.filter((t: any) => t.name === 'spawn_agent')).toHaveLength(1);
    expect(r.dropped).toContain('spawn_agent');
    expect(r.map.spawn_agent).toBeUndefined();
  });

  it('strip mode removes the namespace and records no map', () => {
    const body: any = { tools: [fn('exec_command'), { ...NAMESPACE }] };

    const r = flattenNamespaceTools(body, 'strip');

    expect(body.tools.map((t: any) => t.name)).toEqual(['exec_command']);
    expect(r.map).toEqual({});
    expect(r.dropped).toEqual(['close_agent', 'spawn_agent', 'wait_agent']);
  });

  it('handles multiple namespaces and keeps each tool with its own', () => {
    const other = { type: 'namespace', name: 'crm_v1', tools: [fn('lookup')] };
    const body: any = { tools: [{ ...NAMESPACE }, other] };

    const r = flattenNamespaceTools(body, 'flatten');

    expect(r.map.lookup).toBe('crm_v1');
    expect(r.map.close_agent).toBe('multi_agent_v1');
  });

  it('deletes an emptied tools key rather than sending []', () => {
    const body: any = { tools: [{ type: 'namespace', name: 'empty_v1', tools: [] }] };
    flattenNamespaceTools(body, 'flatten');
    expect('tools' in body).toBe(false);
  });

  it('is a no-op without a namespace tool, and tolerates junk', () => {
    const body: any = { tools: [fn('exec_command')] };
    const snapshot = JSON.parse(JSON.stringify(body));
    expect(flattenNamespaceTools(body, 'flatten').changed).toBe(false);
    expect(body).toEqual(snapshot);

    for (const junk of [{}, { tools: 'nope' }, null, undefined] as any[]) {
      expect(() => flattenNamespaceTools(junk, 'flatten')).not.toThrow();
      expect(flattenNamespaceTools(junk, 'flatten').changed).toBe(false);
    }
  });

  it('skips nested entries that are not function tools', () => {
    const body: any = { tools: [{ ...NAMESPACE, tools: [fn('ok'), { type: 'namespace', name: 'x' }, null] }] };
    const r = flattenNamespaceTools(body, 'flatten');
    expect(r.hoisted).toEqual(['ok']);
  });
});

describe('renestFunctionCall', () => {
  const map = { close_agent: 'multi_agent_v1' };

  it('adds the namespace Codex needs to route the call', () => {
    const item: any = { type: 'function_call', name: 'close_agent', call_id: 'c1', arguments: '{}' };

    expect(renestFunctionCall(item, map)).toBe(true);
    expect(item.namespace).toBe('multi_agent_v1');
  });

  it('leaves an unrelated function call alone', () => {
    const item: any = { type: 'function_call', name: 'exec_command', call_id: 'c1' };
    expect(renestFunctionCall(item, map)).toBe(false);
    expect('namespace' in item).toBe(false);
  });

  it('does not overwrite a namespace the model already set', () => {
    const item: any = { type: 'function_call', name: 'close_agent', namespace: 'other', call_id: 'c1' };
    expect(renestFunctionCall(item, map)).toBe(false);
    expect(item.namespace).toBe('other');
  });

  it('ignores non-function-call items and junk', () => {
    for (const junk of [{ type: 'message' }, {}, null, undefined] as any[]) {
      expect(renestFunctionCall(junk, map)).toBe(false);
    }
  });

  it('is a no-op with an empty map', () => {
    const item: any = { type: 'function_call', name: 'close_agent', call_id: 'c1' };
    expect(renestFunctionCall(item, {})).toBe(false);
  });
});

describe('renestOutputItems', () => {
  it('re-nests every matching call in an output array and counts them', () => {
    const map = { close_agent: 'multi_agent_v1', spawn_agent: 'multi_agent_v1' };
    const output: any = [
      { type: 'reasoning', id: 'r1' },
      { type: 'function_call', name: 'spawn_agent', call_id: 'c1' },
      { type: 'function_call', name: 'exec_command', call_id: 'c2' },
      { type: 'function_call', name: 'close_agent', call_id: 'c3' },
    ];

    expect(renestOutputItems(output, map)).toBe(2);
    expect(output[1].namespace).toBe('multi_agent_v1');
    expect('namespace' in output[2]).toBe(false);
    expect(output[3].namespace).toBe('multi_agent_v1');
  });

  it('returns 0 for a non-array or an empty map', () => {
    expect(renestOutputItems(undefined, { a: 'b' })).toBe(0);
    expect(renestOutputItems([{ type: 'function_call', name: 'a' }], {})).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/gateway && npm test -- --testPathPattern=namespace-tools-adapter
```

Expected: FAIL — `Cannot find module '../src/plugins/namespaceTools/adapter'`.

- [ ] **Step 3: Write the implementation**

Create `services/gateway/src/plugins/namespaceTools/adapter.ts`:

```typescript
/**
 * Flatten Codex's `namespace` tool wrapper outbound, and restore the `namespace`
 * field on the way back.
 *
 * `namespace` is a documented Responses feature that groups related tools, but SAP
 * AI Core does not allow the type and rejects the whole request:
 *   `The following tools are not allowed for model '<model>': namespace`
 * The nested entries are ordinary function tools, so hoisting them makes the request
 * acceptable while keeping every tool the client offered.
 *
 * BOTH halves are required. Measured against Codex CLI 0.145.0 by replying with a
 * call for the real tool `close_agent`:
 *   without `namespace` -> `codex_core::tools::router: error=unsupported call: close_agent`
 *   with    `namespace` -> the tool executed (it failed only on deliberately bad args)
 * Codex routes namespaced tools by (namespace, name), never by name alone — so a
 * flatten with no re-nest fails SILENTLY at the client, which is worse than the 400
 * it replaces.
 *
 * Pure: no I/O, no config, no logging.
 *
 * @see responsesNamespaceToolsPlugin.ts - the only consumer
 * @see api_config.json - namespace_tools.mode
 */

export type NamespaceToolMode = 'flatten' | 'strip';

/** Flatten by default: the alternative is a hard 400 that kills the turn. */
export const DEFAULT_NAMESPACE_TOOL_MODE: NamespaceToolMode = 'flatten';

const VALID_MODES: NamespaceToolMode[] = ['flatten', 'strip'];

/** Anything that is not exactly one of the two modes resolves to the default. */
export function resolveNamespaceToolMode(value: unknown): NamespaceToolMode {
  return VALID_MODES.includes(value as NamespaceToolMode)
    ? (value as NamespaceToolMode)
    : DEFAULT_NAMESPACE_TOOL_MODE;
}

function isNamespaceTool(tool: any): boolean {
  return !!tool && tool.type === 'namespace';
}

function isFunctionTool(tool: any): boolean {
  return !!tool && tool.type === 'function' && typeof tool.name === 'string' && tool.name.length > 0;
}

/**
 * Rewrite `body.tools` in place, returning the `toolName -> namespaceName` map the
 * response side needs.
 *
 * A nested tool whose name already exists at the top level is dropped rather than
 * hoisted — a duplicate tool name is itself a request the deployment rejects — and is
 * deliberately absent from the map, so its calls are left alone rather than being
 * given a namespace they were never declared under.
 */
export function flattenNamespaceTools(
  body: any,
  mode: NamespaceToolMode
): { changed: boolean; map: Record<string, string>; hoisted: string[]; dropped: string[] } {
  const map: Record<string, string> = {};
  const hoisted: string[] = [];
  const dropped: string[] = [];

  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) {
    return { changed: false, map, hoisted, dropped };
  }
  if (!body.tools.some(isNamespaceTool)) {
    return { changed: false, map, hoisted, dropped };
  }

  const taken = new Set<string>(body.tools.filter(isFunctionTool).map((t: any) => t.name as string));
  const rebuilt: any[] = [];

  for (const tool of body.tools) {
    if (!isNamespaceTool(tool)) { rebuilt.push(tool); continue; }

    const nsName = typeof tool.name === 'string' ? tool.name : '';
    for (const candidate of Array.isArray(tool.tools) ? tool.tools : []) {
      if (!isFunctionTool(candidate)) continue;
      if (mode === 'strip' || taken.has(candidate.name) || !nsName) {
        dropped.push(candidate.name);
        continue;
      }
      taken.add(candidate.name);
      map[candidate.name] = nsName;
      hoisted.push(candidate.name);
      rebuilt.push(candidate);
    }
  }

  body.tools = rebuilt;
  // Some deployments reject `"tools": []`, so an emptied list is removed entirely —
  // the same rule transformResponsesWebSearchTool follows.
  if (body.tools.length === 0) delete body.tools;

  return { changed: true, map, hoisted, dropped };
}

/**
 * Put back the `namespace` Codex needs to route this call. Mutates; returns whether
 * it changed anything. A namespace the model set itself is never overwritten.
 */
export function renestFunctionCall(item: any, map: Record<string, string>): boolean {
  if (!item || item.type !== 'function_call') return false;
  if (typeof item.name !== 'string') return false;
  if (item.namespace !== undefined) return false;
  const ns = map[item.name];
  if (!ns) return false;
  item.namespace = ns;
  return true;
}

/** Apply renestFunctionCall across a response `output` array. Returns the count changed. */
export function renestOutputItems(output: any, map: Record<string, string>): number {
  if (!Array.isArray(output)) return 0;
  let n = 0;
  for (const item of output) if (renestFunctionCall(item, map)) n += 1;
  return n;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=namespace-tools-adapter
```

Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/plugins/namespaceTools/adapter.ts \
        services/gateway/test/namespace-tools-adapter.test.ts
git commit -m "feat(gateway): add the Codex namespace-tool adapter"
```

---

### Task 2: Config key and accessor

**Files:**
- Modify: `services/gateway/src/services/configService.ts`
- Modify: `services/gateway/api_config.json` (+ sync 2 copies), `services/admin/src/schemas/api-config-schema.json`
- Test: `services/gateway/test/namespace-tools-config.test.ts`

**Interfaces:**
- Consumes: `resolveNamespaceToolMode`, `DEFAULT_NAMESPACE_TOOL_MODE`, `NamespaceToolMode` from `../plugins/namespaceTools/adapter` (Task 1).
- Produces: `export const getNamespaceToolMode: () => NamespaceToolMode`, exported individually **and** on the default-export object — Task 3 calls `configService.getNamespaceToolMode()`.

- [ ] **Step 1: Write the failing test**

The accessors call this module's own exported `getConfig()`, so the repo's convention (`test/websearch-cap-config.test.ts`) is to exercise the real accessor against the **shipped** config and keep validation in the pure helper, which Task 1 covers.

Create `services/gateway/test/namespace-tools-config.test.ts`:

```typescript
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import configService from '../src/services/configService';

describe('configService.getNamespaceToolMode', () => {
  it('resolves the mode shipped in api_config.json', () => {
    expect(configService.getNamespaceToolMode()).toBe('flatten');
  });

  it('is reachable off the default export, which is how the plugin calls it', () => {
    expect(typeof configService.getNamespaceToolMode).toBe('function');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --testPathPattern=namespace-tools-config
```

Expected: FAIL — `configService.getNamespaceToolMode is not a function`.

- [ ] **Step 3: Add the accessor**

In `services/gateway/src/services/configService.ts`, beside `getWebSearchMaxSearches`:

```typescript
/**
 * How to handle Codex's `namespace` sub-agent wrapper, which SAP AI Core rejects.
 * Absent config yields `flatten`, so an install whose api_config.json predates this
 * key gets the working behavior rather than the 400.
 *
 * @see plugins/namespaceTools/adapter.ts - the validation rules
 */
export const getNamespaceToolMode = (): NamespaceToolMode => {
  try {
    return resolveNamespaceToolMode(getConfig()?.api_config?.namespace_tools?.mode);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting the namespace tool mode: ${error.message}`);
    return DEFAULT_NAMESPACE_TOOL_MODE;
  }
};
```

Import the three symbols from `../plugins/namespaceTools/adapter`. Export individually **and** add `getNamespaceToolMode` to the default-export object beside `getWebSearchMaxSearches`.

- [ ] **Step 4: Ship the key and sync**

Add to `services/gateway/api_config.json` inside `api_config`, beside the existing `web_search` block:

```json
    "namespace_tools": {
      "mode": "flatten"
    },
```

From the repo root:

```bash
git add services/gateway/api_config.json
node cli-tools/sync-api-config.js
md5 -q services/gateway/api_config.json services/admin/api_config.json \
       npm-dist/sail-proxy/src/templates/api_config.template.json
```

Expected: three identical hashes. Declare it in `services/admin/src/schemas/api-config-schema.json` beside `web_search`: an object whose `mode` is `{"type":"string","enum":["flatten","strip"]}`.

- [ ] **Step 5: Run the test, then commit**

```bash
npx tsc --noEmit -p tsconfig.json && npm test -- --testPathPattern=namespace-tools-config
```

Expected: PASS, 2 tests.

```bash
git add services/gateway/src/services/configService.ts \
        services/gateway/test/namespace-tools-config.test.ts \
        services/gateway/api_config.json services/admin/api_config.json \
        npm-dist/sail-proxy/src/templates/api_config.template.json \
        services/admin/src/schemas/api-config-schema.json
git commit -m "feat(gateway): make the namespace-tool mode configurable"
```

---

### Task 3: The plugin — non-streaming, plus hook wiring

**Files:**
- Create: `services/gateway/src/plugins/responsesNamespaceToolsPlugin.ts`, `…​.md`
- Modify: `services/gateway/api_config.json` (+ sync 2 copies)
- Test: `services/gateway/test/responses-namespace-tools-plugin.test.ts`

**Interfaces:**
- Consumes: everything from Task 1; `configService.getNamespaceToolMode()` from Task 2.
- Produces: a CommonJS rules array via `export = pluginRules`, `id: "responsesNamespaceToolsPlugin"`, one `before` and one `after` entry. Task 4 adds the streaming interceptor to this same file. The map is stashed at `(req as any).__namespaceToolMap`.

**Handler contract** (matches `responsesWebSearchPlugin.ts`, which the loader already satisfies):

```typescript
interface PluginContext { req: Request; res: Response; utils: { logger: Logger }; upstreamResponse?: any }
// before: async ({ req, res, utils }) => Promise<{ stop: boolean }>
// after:  async ({ req, upstreamResponse, utils }) => Promise<any>
```

- [ ] **Step 1: Write the failing tests**

Create `services/gateway/test/responses-namespace-tools-plugin.test.ts`:

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockMode = jest.fn<() => string>();
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getNamespaceToolMode: () => mockMode() },
  getNamespaceToolMode: () => mockMode(),
}));

import pluginRules = require('../src/plugins/responsesNamespaceToolsPlugin');

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const after = (pluginRules as any[]).find(r => r.strategy === 'after').handler;
const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };

const fn = (name: string) => ({ type: 'function', name, parameters: { type: 'object', properties: {} }, strict: false });
const NS = { type: 'namespace', name: 'multi_agent_v1', tools: [fn('spawn_agent'), fn('close_agent')] };

describe('responsesNamespaceToolsPlugin — before', () => {
  beforeEach(() => { mockMode.mockReset(); mockMode.mockReturnValue('flatten'); });

  it('flattens the namespace and stashes the map on the request', async () => {
    const req: any = { body: { tools: [fn('exec_command'), { ...NS }] } };

    const r = await before({ req, res: {} as any, utils });

    expect(r).toEqual({ stop: false });
    expect(req.body.tools.some((t: any) => t.type === 'namespace')).toBe(false);
    expect(req.body.tools.map((t: any) => t.name)).toEqual(['exec_command', 'spawn_agent', 'close_agent']);
    expect(req.__namespaceToolMap).toEqual({ spawn_agent: 'multi_agent_v1', close_agent: 'multi_agent_v1' });
  });

  it('leaves a request with no namespace tool untouched and stashes no map', async () => {
    const req: any = { body: { tools: [fn('exec_command')] } };
    const snapshot = JSON.parse(JSON.stringify(req.body));

    await before({ req, res: {} as any, utils });

    expect(req.body).toEqual(snapshot);
    expect(req.__namespaceToolMap).toBeUndefined();
  });

  it('strip mode removes the tools and stashes no usable map', async () => {
    mockMode.mockReturnValue('strip');
    const req: any = { body: { tools: [fn('exec_command'), { ...NS }] } };

    await before({ req, res: {} as any, utils });

    expect(req.body.tools.map((t: any) => t.name)).toEqual(['exec_command']);
    expect(req.__namespaceToolMap).toEqual({});
  });

  it('never throws on a malformed body', async () => {
    for (const body of [undefined, null, {}, { tools: 'nope' }] as any[]) {
      await expect(before({ req: { body } as any, res: {} as any, utils })).resolves.toEqual({ stop: false });
    }
  });
});

describe('responsesNamespaceToolsPlugin — after', () => {
  beforeEach(() => { mockMode.mockReset(); mockMode.mockReturnValue('flatten'); });

  it('restores the namespace Codex needs to route the call', async () => {
    const req: any = { __namespaceToolMap: { spawn_agent: 'multi_agent_v1' } };
    const upstreamResponse = { output: [
      { type: 'reasoning', id: 'r1' },
      { type: 'function_call', name: 'spawn_agent', call_id: 'c1', arguments: '{}' },
    ] };

    const out = await after({ req, upstreamResponse, utils });

    expect(out.output[1].namespace).toBe('multi_agent_v1');
    expect(out.output[0]).toEqual({ type: 'reasoning', id: 'r1' });
  });

  it('leaves calls to non-namespaced tools alone', async () => {
    const req: any = { __namespaceToolMap: { spawn_agent: 'multi_agent_v1' } };
    const upstreamResponse = { output: [{ type: 'function_call', name: 'exec_command', call_id: 'c1' }] };

    const out = await after({ req, upstreamResponse, utils });

    expect('namespace' in out.output[0]).toBe(false);
  });

  it('passes the response through untouched when no map was stashed', async () => {
    const upstreamResponse = { output: [{ type: 'function_call', name: 'spawn_agent', call_id: 'c1' }] };

    const out = await after({ req: {} as any, upstreamResponse, utils });

    expect(out).toBe(upstreamResponse);
  });

  it('never throws on a malformed response', async () => {
    const req: any = { __namespaceToolMap: { a: 'b' } };
    for (const r of [undefined, null, {}, { output: 'nope' }] as any[]) {
      await expect(after({ req, upstreamResponse: r, utils })).resolves.toBe(r);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --testPathPattern=responses-namespace-tools-plugin
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the plugin**

Create `services/gateway/src/plugins/responsesNamespaceToolsPlugin.ts`:

```typescript
/**
 * Codex sub-agent (`namespace`) tool support for the Responses route.
 *
 * SAP AI Core rejects the `namespace` tool type outright, killing any Codex turn that
 * has multi_agent enabled — which is the default. This plugin flattens the wrapper
 * into the ordinary function tools it contains on the way out, and restores the
 * `namespace` field on the way back, which Codex REQUIRES to route the call:
 * measured against Codex 0.145.0, a call without it is refused by
 * `codex_core::tools::router` as `unsupported call: <name>`, while the same call with
 * it dispatches.
 *
 * Both halves or neither — a flatten with no re-nest fails silently at the client,
 * which is worse than the 400 it replaces. `strip` mode exists for deployments where
 * the flattened set is still unacceptable; it stashes an empty map so the response
 * side is a no-op.
 *
 * @see namespaceTools/adapter.ts - the pure transformations
 * @see responsesNamespaceToolsPlugin.md - operator documentation
 */
import { Request, Response } from 'express';
import configService from '../services/configService';
import {
  flattenNamespaceTools, renestOutputItems, NamespaceToolMode,
} from './namespaceTools/adapter';

interface Logger {
  error: (m: string, meta?: any) => void; warn: (m: string, meta?: any) => void;
  info: (m: string, meta?: any) => void; debug: (m: string, meta?: any) => void;
  trace: (m: string, meta?: any) => void;
}
interface PluginContext { req: Request; res: Response; utils: { logger: Logger }; upstreamResponse?: any }
interface PluginResult { stop: boolean }

/** Where the before handler leaves `toolName -> namespaceName` for the after handler. */
export const NAMESPACE_MAP_KEY = '__namespaceToolMap';

async function beforeHandler({ req, utils }: PluginContext): Promise<PluginResult> {
  const pluginLogger = utils.logger;
  try {
    const mode: NamespaceToolMode = configService.getNamespaceToolMode();
    const result = flattenNamespaceTools(req.body, mode);
    if (!result.changed) return { stop: false };

    (req as any)[NAMESPACE_MAP_KEY] = result.map;
    pluginLogger.info(
      `Flattened Codex namespace tool(s) [mode=${mode}]: hoisted [${result.hoisted.join(', ')}]` +
      (result.dropped.length > 0 ? `, dropped [${result.dropped.join(', ')}]` : ''));
    return { stop: false };
  } catch (error: any) {
    pluginLogger.error(`Error in responsesNamespaceToolsPlugin beforeHandler: ${error.message}`, { stack: error.stack });
    return { stop: false };
  }
}

async function afterHandler({ req, upstreamResponse, utils }: PluginContext): Promise<any> {
  const pluginLogger = utils.logger;
  try {
    const map = (req as any)[NAMESPACE_MAP_KEY];
    if (!map || Object.keys(map).length === 0) return upstreamResponse;

    const n = renestOutputItems(upstreamResponse?.output, map);
    if (n > 0) pluginLogger.info(`Restored the namespace on ${n} function call(s) so the client can route them`);
    return upstreamResponse;
  } catch (error: any) {
    pluginLogger.error(`Error in responsesNamespaceToolsPlugin afterHandler: ${error.message}`, { stack: error.stack });
    return upstreamResponse;
  }
}

const pluginRules = [
  { id: 'responsesNamespaceToolsPlugin', match: [], strategy: 'before', handler: beforeHandler },
  { id: 'responsesNamespaceToolsPlugin', match: [], strategy: 'after', handler: afterHandler },
];

export = pluginRules;
```

Note `afterHandler` mutates `upstreamResponse.output` in place and returns the same object — the third test above pins identity for the no-map case.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=responses-namespace-tools-plugin
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Wire the hooks**

In `services/gateway/api_config.json`, append a third entry to **both** `defaultHooks.openai.responses` and `.responses-stream`, after the existing `pseudonymizationPlugin` and `responsesWebSearchPlugin` entries:

```json
          {
            "request": {
              "callback": { "id": "responsesNamespaceToolsPlugin" },
              "match": ["header:contentTypeJson"]
            }
          }
```

`pseudonymizationPlugin` stays index 0. Gating on `header:contentTypeJson` satisfies the invariant `responses-hooks-config.test.ts` enforces — that test asserts each tool-plugin entry's `match` is a superset of its sibling masking entry's, so omitting it will fail the suite.

Then sync and verify md5 as in Task 2 Step 4.

- [ ] **Step 6: Write the plugin documentation**

Create `services/gateway/src/plugins/responsesNamespaceToolsPlugin.md` covering: the SAP rejection, the measured Codex routing behaviour (both A/B outcomes, quoted), the two modes and when an operator would choose `strip`, the hook wiring including why the content-type gate is present, and the streaming caveat until Task 4 lands. Cross-reference `responsesWebSearchPlugin.md` as the sibling emulation.

- [ ] **Step 7: Full suite and commit**

```bash
npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 56 suites, 667 + 18 + 2 + 8 = 695 tests, all green.

```bash
git add services/gateway/src/plugins/responsesNamespaceToolsPlugin.ts \
        services/gateway/src/plugins/responsesNamespaceToolsPlugin.md \
        services/gateway/test/responses-namespace-tools-plugin.test.ts \
        services/gateway/api_config.json services/admin/api_config.json \
        npm-dist/sail-proxy/src/templates/api_config.template.json
git commit -m "feat(gateway): flatten Codex namespace tools and restore the routing namespace"
```

---

### Task 4: Streaming

Codex always streams, so without this the feature works only for non-streaming API callers — i.e. not for the client it exists to serve.

**Files:**
- Modify: `services/gateway/src/plugins/responsesNamespaceToolsPlugin.ts`
- Test: `services/gateway/test/responses-namespace-tools-stream.test.ts`

**Interfaces:**
- Consumes: `renestFunctionCall`, `renestOutputItems` (Task 1); the map at `__namespaceToolMap` (Task 3).
- Produces: no new exports. `beforeHandler` installs an interceptor when `req.body.stream === true` and a map was stashed.

**Frame contract.** A `function_call` reaches the client in three places, and all three need the namespace:

1. `response.output_item.added` — `frame.item` is the `function_call`
2. `response.output_item.done` — same
3. the terminal frame (`response.completed` / `.incomplete` / `.failed`) — `frame.response.output[]` carries the finished items

Everything else passes through byte-identical. Frames are re-serialised **only** when a re-nest actually changed something, so an untouched stream is unmodified.

**Interceptor placement.** `pseudonymizationPlugin` patches `res.write` first (index 0), `responsesWebSearchPlugin` second; this patches third and therefore sees raw upstream bytes first. That is correct and requires no coordination: the web-search interceptor suppresses frames for `web_search` calls only, and this one touches only names in the map.

Reuse the block-framing helpers already proven in `responsesWebSearchPlugin.ts` (`splitBlocks`, `parseFrame`, `sseBlock`, and the `rebuildBlockWithSubstitution` pattern that preserves `event:` lines). Import them if they are exported; if they are module-private, extract them to a shared module rather than copying — and say which you did in your report.

- [ ] **Step 1: Write the failing tests**

Create `services/gateway/test/responses-namespace-tools-stream.test.ts`:

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockMode = jest.fn<() => string>();
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getNamespaceToolMode: () => mockMode() },
  getNamespaceToolMode: () => mockMode(),
}));

import pluginRules = require('../src/plugins/responsesNamespaceToolsPlugin');

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };

const fn = (name: string) => ({ type: 'function', name, parameters: { type: 'object', properties: {} }, strict: false });
const NS = { type: 'namespace', name: 'multi_agent_v1', tools: [fn('spawn_agent')] };
const sse = (o: any) => `data: ${JSON.stringify(o)}\n\n`;

function mockRes() {
  const written: string[] = [];
  return {
    written,
    write(c: any) { written.push(c.toString()); return true; },
    end() { return this as any; },
    on() { return this as any; },
  } as any;
}

const frames = (w: string[]) => w.join('').split('\n\n').map(b => b.trim())
  .filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)));

describe('responsesNamespaceToolsPlugin — streaming', () => {
  beforeEach(() => { mockMode.mockReset(); mockMode.mockReturnValue('flatten'); });

  async function streamingReq(res: any) {
    const req: any = { body: { stream: true, tools: [fn('exec_command'), { ...NS }] } };
    await before({ req, res, utils });
    return req;
  }

  it('adds the namespace to the function_call in added, done and the terminal frame', async () => {
    const res = mockRes();
    await streamingReq(res);
    const call = { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', arguments: '{"task":"x"}' };

    res.write(sse({ type: 'response.created', response: { id: 'r1' } }));
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } }));
    res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"task":"x"}' }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { ...call } }));
    res.write(sse({ type: 'response.completed', response: { id: 'r1', output: [{ ...call }], usage: {} } }));

    const f = frames(res.written);
    const added = f.find(x => x.type === 'response.output_item.added');
    const done = f.find(x => x.type === 'response.output_item.done');
    const completed = f.find(x => x.type === 'response.completed');

    expect(added.item.namespace).toBe('multi_agent_v1');
    expect(done.item.namespace).toBe('multi_agent_v1');
    expect(completed.response.output[0].namespace).toBe('multi_agent_v1');
  });

  it('leaves frames for non-namespaced tools byte-identical', async () => {
    const res = mockRes();
    await streamingReq(res);
    const raw = sse({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_2', call_id: 'c2', name: 'exec_command', arguments: '{}' } });

    res.write(raw);

    expect(res.written.join('')).toBe(raw);
  });

  it('passes an unrelated frame through byte-identical', async () => {
    const res = mockRes();
    await streamingReq(res);
    const raw = sse({ type: 'response.output_text.delta', output_index: 0, delta: 'hello' });

    res.write(raw);

    expect(res.written.join('')).toBe(raw);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const res = mockRes();
    await streamingReq(res);
    const block = sse({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', arguments: '{}' } });

    res.write(block.slice(0, 30));
    res.write(block.slice(30));

    expect(frames(res.written)[0].item.namespace).toBe('multi_agent_v1');
  });

  it('does not install an interceptor for a non-streaming request', async () => {
    const res = mockRes();
    const original = res.write;
    const req: any = { body: { stream: false, tools: [{ ...NS }] } };

    await before({ req, res, utils });

    expect(res.write).toBe(original);
  });

  it('does not install an interceptor when there is no namespace tool', async () => {
    const res = mockRes();
    const original = res.write;
    const req: any = { body: { stream: true, tools: [fn('exec_command')] } };

    await before({ req, res, utils });

    expect(res.write).toBe(original);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --testPathPattern=responses-namespace-tools-stream
```

Expected: FAIL — no interceptor; `added.item.namespace` is `undefined`.

- [ ] **Step 3: Implement the interceptor**

Add to `responsesNamespaceToolsPlugin.ts` an `installNamespaceInterceptor(req, res, map, pluginLogger)` that patches `res.write`, holds a partial `tail` across writes, and for each complete block:

- parses the frame; on a parse failure emits the block unchanged;
- for `response.output_item.added` / `.done`, calls `renestFunctionCall(frame.item, map)`;
- for a terminal type, calls `renestOutputItems(frame.response?.output, map)`;
- re-serialises **only** when the call returned a change, preserving any non-`data:` lines; otherwise writes the original block untouched;
- wraps the whole body in try/catch, logging and writing the original chunk on failure — a throw here must never break the stream.

Patch `res.end` to flush a non-empty `tail` before ending, matching what `responsesWebSearchPlugin`'s interceptor does; a final block without its `\n\n` terminator must not be dropped.

Call it from `beforeHandler` after the map is stashed, guarded on `req.body.stream === true` and a non-empty map.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc --noEmit -p tsconfig.json
npm test -- --testPathPattern=responses-namespace-tools
```

Expected: PASS — both the plugin and stream suites.

- [ ] **Step 5: Update the user documentation**

`docs/user/chapter-2-features.md:81` currently tells users to disable the feature. Replace it: the gateway flattens the `namespace` wrapper outbound and restores the routing namespace inbound, so sub-agents work with no Codex flag; `namespace_tools.mode = "strip"` drops them instead. Reword `README.md:1179`, which points at that section for "the `multi_agent` caveat" — keep the README an overview.

Also correct the streaming caveat you wrote into `responsesNamespaceToolsPlugin.md` in Task 3.

- [ ] **Step 6: Full suite and commit**

```bash
npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: 57 suites, 695 + 6 = 701 tests, all green.

```bash
git add services/gateway/src/plugins/responsesNamespaceToolsPlugin.ts \
        services/gateway/src/plugins/responsesNamespaceToolsPlugin.md \
        services/gateway/test/responses-namespace-tools-stream.test.ts \
        docs/user/chapter-2-features.md README.md
git commit -m "feat(gateway): restore the routing namespace in Responses streams"
```

---

## Live Verification (after all tasks)

- [ ] **Step 1: Publish and activate the config**, then restart the gateway. **Ask the human partner before restarting** — the gateway requires the admin service, and killing it mid-session has broken this environment before.

- [ ] **Step 2: The 400 is gone** — `codex exec --skip-git-repo-check "say ok"`, run **without** `--disable multi_agent`. Then confirm from the newest `services/gateway/logs/payloads/*_02_responses_request_to_deployment.json` that `tools` carries `spawn_agent`/`close_agent`/`resume_agent`/`send_input`/`wait_agent` as top-level function tools and no `namespace` entry.

- [ ] **Step 3: A sub-agent actually runs** — the decisive gate:

```bash
codex exec --skip-git-repo-check "Spawn a sub-agent to count the .ts files under services/gateway/src, then report the number it gives you."
```

Expected: the turn completes, using the sub-agent tools. Watch specifically for the absence of `unsupported call:` in Codex's output — that string is the exact symptom of the namespace field not arriving, and it is what Task 1's evidence was built on.

- [ ] **Step 4: Regression** — an ordinary Codex task with no sub-agents; one `/openai/v1/responses` curl with a hosted `web_search` tool (phases 2–3 still work); and one non-streaming curl with a `namespace` tool confirming the after handler path.

---

## Self-Review

**Coverage.** SAP rejects the wrapper → Task 1 flattens, Task 3 wires it. Codex needs the namespace back to route → Task 1's re-nest, Task 3 non-streaming, Task 4 streaming. Operators need an escape hatch → Task 2's `mode`. The docs tell users to disable the feature → Task 4 Step 5. Whether it works end to end → the live gate, whose Step 3 watches for the exact error string the research produced.

**Placeholders.** None. Task 4 Step 3 is prose rather than a code block — deliberate: the interceptor must fit `responsesWebSearchPlugin.ts`'s existing framing helpers, which have been revised three times, and a transcribed sketch would be stale. The frame contract above it is the requirement, and it is exact.

**Type consistency.** `NamespaceToolMode` is defined in Task 1 and imported by Task 2. `flattenNamespaceTools(body, mode)` returns `{changed, map, hoisted, dropped}` and is destructured with those names in Task 3. `renestFunctionCall(item, map)` and `renestOutputItems(output, map)` keep that argument order in Tasks 3 and 4. `NAMESPACE_MAP_KEY` is `'__namespaceToolMap'`, matching the tests.

**What changed from the first draft of this plan, and why.** It originally specified a request-side-only transformation in `responsesController`, explicitly *not* a plugin, on the reasoning that tool calls come back as ordinary `function_call` items a name-keyed router would dispatch. The measurement above disproved that: Codex refuses the call as `unsupported call: close_agent` without the `namespace` field. The plan is now a two-phase plugin. The lesson is recorded here because the first design was plausible, self-consistent, and wrong — and only an experiment separated the two.
