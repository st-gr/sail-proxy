/**
 * Translate Codex's `tool_search` tool into an ordinary function tool outbound, and
 * restore the `tool_search_call` shape on the way back.
 *
 * BOTH SAP routes reject the type, measured 2026-08-11:
 *   deployed       -> "The following tools are not allowed for model 'gpt-5.3-codex': custom and tool_search."
 *   orchestration  -> "400 - Request Body: 'tool_search' is not one of ['function'] -
 *                      'config.modules.prompt_templating.prompt.tools[0].type'"
 * (the trailing JSON pointer names the offending entry's INDEX, so it varies.)
 *
 * Unlike `custom`/apply_patch, nothing is lost in translation. The captured declaration is
 * already a function tool in all but name — `{type, execution, description, parameters}`, with
 * `parameters` a plain JSON Schema and NO `name` field. There is no grammar to smuggle into a
 * description. The only invention is the name itself, and the tool's own description calls it
 * `tool_search`, so that is what it gets.
 *
 * Shapes below are from test/fixtures/codex-custom-tools/tool-search-capture.md, captured from
 * real codex 0.147.0 against api.openai.com — NOT inferred.
 *
 * THE ASYMMETRY THAT MATTERS. A `tool_search_call` carries `arguments` as a JSON OBJECT:
 *   "arguments": { "query": "documents", "limit": 8 }
 * while a `function_call` carries it as a JSON STRING. Translation has to convert in both
 * directions, and getting it backwards hands the client a string where it expects an object.
 *
 * THE DISCOVERED TOOLS, AND WHY THEY ARE HOISTED HERE BUT NOT AGAINST OpenAI. A
 * `tool_search_output` carries a `tools` array of discovered tools rather than any text.
 * Against `api.openai.com`, hoisting them would be wrong: measured across three consecutive
 * `response.create` frames, codex already adds them to its own `tools` array from the discovery
 * turn onward, so lifting them again would duplicate every one.
 *
 * Against THIS gateway it never does. With a config identical to a working one except a single
 * line — `base_url` pointed at localhost instead of `api.openai.com` — codex stops exposing them
 * entirely: no `namespace` entry, no discovered tools, on every turn. Codex keeps deferred MCP
 * tools visible only for the OpenAI host, and with `tool_mode: null` there is no code-mode
 * context to reach a deferred tool through, so the model can discover tools it can never call.
 * `hoistDiscoveredTools` below is the workaround; see its own comment for the mechanics.
 *
 * Pure: no I/O, no config, no logging.
 *
 * @see responsesCustomToolsPlugin.ts - the consumer; it owns the streaming interceptor
 * @see ../customTools/adapter.ts - the sibling that solves the same problem for `custom`
 */

export type ToolSearchMode = 'translate' | 'strip';

/** Translate by default: the alternative is a hard 400 that kills the turn. */
export const DEFAULT_TOOL_SEARCH_MODE: ToolSearchMode = 'translate';

/**
 * The name given to the translated tool. The wire declaration carries NO `name` — the
 * captured object has exactly four keys (`type`, `execution`, `description`, `parameters`) —
 * so one has to be supplied. The tool's own description refers to itself as `tool_search`.
 */
export const TOOL_SEARCH_TOOL_NAME = 'tool_search';

const VALID_MODES: ToolSearchMode[] = ['translate', 'strip'];

/**
 * Whether to hoist discovered tools into the request. ON by default, because today codex hides
 * them for every non-`api.openai.com` endpoint and the model would otherwise be able to discover
 * tools it can never call.
 *
 * This is a WORKAROUND FOR A CLIENT BUG, so it is deliberately switchable: when codex stops
 * gating deferred-tool exposure on the provider host, set `tool_search.hoist_discovered_tools`
 * to false and the gateway stops touching the tools array.
 *
 * Leaving it on after such a fix is safe rather than harmful — `hoistDiscoveredTools` skips any
 * name the request already declares, so a client that has started sending its own discovered
 * tools gets no duplicates (pinned by test). The switch exists so the workaround can be retired
 * deliberately rather than silently outliving the bug it was written for.
 */
export const DEFAULT_HOIST_DISCOVERED_TOOLS = true;

/** Only an explicit `false` disables the hoist; anything else (including absent) leaves it on. */
export function resolveHoistDiscoveredTools(value: unknown): boolean {
  return value === false ? false : DEFAULT_HOIST_DISCOVERED_TOOLS;
}

/** Anything that is not exactly one of the two modes resolves to the default. */
export function resolveToolSearchMode(value: unknown): ToolSearchMode {
  return VALID_MODES.includes(value as ToolSearchMode)
    ? (value as ToolSearchMode)
    : DEFAULT_TOOL_SEARCH_MODE;
}

function isToolSearchTool(tool: any): boolean {
  return !!tool && tool.type === 'tool_search';
}

/**
 * Rewrite `body.tools` in place. Returns whether a tool_search declaration was present and
 * what happened to it.
 *
 * `execution: "client"` is dropped: it is not a valid field on a function tool, and it is
 * advisory metadata for the CLIENT, which already knows it executes this tool itself. It is
 * also not always present — one captured occurrence omits it — so nothing may depend on it.
 */
export function translateToolSearchTool(
  body: any,
  mode: ToolSearchMode
): { changed: boolean; translated: boolean; dropped: boolean } {
  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) {
    return { changed: false, translated: false, dropped: false };
  }
  if (!body.tools.some(isToolSearchTool)) {
    return { changed: false, translated: false, dropped: false };
  }

  let translated = false;
  let dropped = false;
  const rebuilt: any[] = [];

  for (const tool of body.tools) {
    if (!isToolSearchTool(tool)) { rebuilt.push(tool); continue; }

    if (mode === 'strip') { dropped = true; continue; }

    const fn: any = { type: 'function', name: TOOL_SEARCH_TOOL_NAME };
    if (tool.description !== undefined) fn.description = tool.description;
    if (tool.parameters !== undefined) fn.parameters = tool.parameters;
    rebuilt.push(fn);
    translated = true;
  }

  body.tools = rebuilt;
  // Some deployments reject `"tools": []`, so an emptied list is removed entirely — the same
  // rule flattenNamespaceTools and translateCustomTools follow.
  if (body.tools.length === 0) delete body.tools;

  return { changed: true, translated, dropped };
}

/** The text parts of a discovered tool, used to describe the result to the upstream model. */
function describeDiscoveredTools(tools: any): Array<{ name: string; namespace?: string }> {
  if (!Array.isArray(tools)) return [];
  const out: Array<{ name: string; namespace?: string }> = [];
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') continue;
    // A discovered entry is a `namespace` wrapper containing function tools; a bare function
    // tool is accepted too, since nothing guarantees the wrapper.
    if (entry.type === 'namespace' && Array.isArray(entry.tools)) {
      for (const nested of entry.tools) {
        if (nested && typeof nested.name === 'string') {
          out.push({ name: nested.name, namespace: typeof entry.name === 'string' ? entry.name : undefined });
        }
      }
      continue;
    }
    if (typeof entry.name === 'string') out.push({ name: entry.name });
  }
  return out;
}

/**
 * Hoist the tools a `tool_search_output` discovered into the request's own `tools` array, and
 * report the `name -> namespace` pairs the response side needs to re-nest their calls.
 *
 * WHY THIS EXISTS, and why the module header's "do not hoist" note does not apply here.
 * That note is correct about `api.openai.com`: codex adds discovered tools to its own `tools`
 * array from the discovery turn onward, so hoisting there would duplicate them. Measured
 * 2026-08-11, that is NOT true against this gateway. With a config identical to a working one
 * except a single line —
 *   base_url = "https://api.openai.com/v1"  ->  "http://localhost:3000/openai/v1"
 * — codex stops exposing them: no `namespace` entry, no discovered tools, on every turn. Codex
 * keeps deferred MCP tools visible only for the `api.openai.com` host, and with `tool_mode: null`
 * there is no code-mode context to reach a deferred tool through. So against this gateway the
 * model can discover tools it can never call, and hoisting is the only available lever.
 *
 * The discovered entries are `namespace` wrappers, which no upstream on this gateway accepts, so
 * they are flattened here rather than left for `flattenNamespaceTools`: that plugin's before
 * handler runs EARLIER than this one in both hook arrays, so by now its flatten has already
 * happened and anything added afterwards would reach the bridge still wrapped.
 *
 * A name already present in `body.tools` is skipped rather than added twice — a duplicate tool
 * name is itself a request some deployments reject — and is deliberately left out of the map, so
 * its calls are not given a namespace they were not hoisted under.
 */
export function hoistDiscoveredTools(body: any): { hoisted: string[]; map: Record<string, string> } {
  // Prototype-less for the same reason flattenNamespaceTools uses one: a tool name is
  // attacker-adjacent data, and a plain literal both reads inherited members and silently
  // fails to write `__proto__`.
  const map: Record<string, string> = Object.create(null);
  const hoisted: string[] = [];

  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) return { hoisted, map };

  const outputs = body.input.filter(
    (i: any) => i && typeof i === 'object' && i.type === 'tool_search_output' && Array.isArray(i.tools)
  );
  if (outputs.length === 0) return { hoisted, map };

  if (!Array.isArray(body.tools)) body.tools = [];
  const taken = new Set<string>(
    body.tools.filter((t: any) => t && typeof t.name === 'string').map((t: any) => t.name as string)
  );

  for (const out of outputs) {
    for (const entry of out.tools) {
      if (!entry || typeof entry !== 'object') continue;
      const nsName = entry.type === 'namespace' && typeof entry.name === 'string' ? entry.name : '';
      const nested = entry.type === 'namespace' && Array.isArray(entry.tools) ? entry.tools : [entry];

      for (const tool of nested) {
        if (!tool || tool.type !== 'function' || typeof tool.name !== 'string' || !tool.name) continue;
        if (taken.has(tool.name)) continue;
        taken.add(tool.name);

        const fn: any = { type: 'function', name: tool.name };
        if (tool.description !== undefined) fn.description = tool.description;
        if (tool.parameters !== undefined) fn.parameters = tool.parameters;
        if (tool.strict !== undefined) fn.strict = tool.strict;
        // `defer_loading` is deliberately NOT carried: it describes a client-side loading
        // policy and is not a field any upstream here reads.
        body.tools.push(fn);
        hoisted.push(tool.name);
        if (nsName) map[tool.name] = nsName;
      }
    }
  }

  if (body.tools.length === 0) delete body.tools;
  return { hoisted, map };
}

/**
 * Convert replayed `tool_search_output` items in `body.input` into `function_call_output`, in
 * place. Returns the number converted.
 *
 * The `id` is DROPPED rather than carried. Codex's ids are type-prefixed (`tso_` here), and the
 * upstream validates the prefix against the item's type once that type has been rewritten — the
 * apply_patch work hit exactly this as `Invalid 'input[8].id': 'ctco_…'. Expected an ID that
 * begins with 'fc'`, which made the feature work exactly once per conversation. `call_id` is
 * what pairs a call to its output and is preserved.
 *
 * The `output` string is a compact machine-readable list of what was discovered. The real
 * payload — the tool declarations themselves — reaches the model through the request's `tools`
 * array, which codex populates itself; see this module's header.
 */
export function translateToolSearchOutputItems(body: any): number {
  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) return 0;

  let converted = 0;
  for (let i = 0; i < body.input.length; i += 1) {
    const item = body.input[i];
    if (!item || typeof item !== 'object') continue;

    // The CALL is replayed too, not only its output. Measured live: with only the output
    // converted, the very next turn died with
    //   "Unsupported Responses input item type: tool_search_call"
    // — the same shape of miss the apply_patch work hit, where handling one half of a
    // replayed pair leaves the other half to kill the turn.
    if (item.type === 'tool_search_call') {
      const next: any = {
        type: 'function_call',
        call_id: item.call_id,
        name: TOOL_SEARCH_TOOL_NAME,
        // Back to a JSON string: this is the direction that feeds an upstream which knows
        // only function tools. A tool_search_call carries `arguments` as an object.
        arguments: JSON.stringify(
          item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
            ? item.arguments
            : {}
        ),
      };
      if (item.status !== undefined) next.status = item.status;
      body.input[i] = next;
      converted += 1;
      continue;
    }

    if (item.type !== 'tool_search_output') continue;

    const discovered = describeDiscoveredTools(item.tools);
    const next: any = {
      type: 'function_call_output',
      call_id: item.call_id,
      output: JSON.stringify({ tools: discovered }),
    };
    if (item.status !== undefined) next.status = item.status;
    body.input[i] = next;
    converted += 1;
  }
  return converted;
}

/**
 * Put back the `tool_search_call` shape codex declared, so its router dispatches the call.
 * Mutates; returns whether it changed anything.
 *
 * `arguments` goes from a JSON string to an object. A string that will not parse becomes `{}`
 * rather than throwing — a malformed search is a wasted turn, an exception is a dead stream.
 */
export function restoreToolSearchCall(item: any): boolean {
  if (!item || item.type !== 'function_call') return false;
  if (item.name !== TOOL_SEARCH_TOOL_NAME) return false;

  let args: any = {};
  if (typeof item.arguments === 'string' && item.arguments.length > 0) {
    try {
      const parsed = JSON.parse(item.arguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch { /* leave args as {} — the captured in_progress item carries {} too */ }
  } else if (item.arguments && typeof item.arguments === 'object') {
    args = item.arguments;
  }

  item.type = 'tool_search_call';
  item.arguments = args;
  delete item.name;      // a tool_search_call carries no `name`; the type identifies it

  // Both captured calls carry `execution: "client"`, and it is the field that tells the client
  // it is the one to run this call. Setting it is restoring an observed field, not inventing
  // one — and omitting it risks codex declining to execute a call it should own. A value the
  // model somehow set itself is left alone.
  if (item.execution === undefined) item.execution = 'client';

  // Re-prefix the item id. Every captured tool_search_call id begins `tsc_`, while what
  // arrives here is the upstream's function-call id (`fc_…`). The prefix is swapped rather
  // than the id regenerated, so it stays unique and still corresponds to the upstream item.
  // This is the mirror of the lesson the apply_patch work learned in the other direction: a
  // type-prefixed id that no longer matches its item's type is not merely cosmetic.
  if (typeof item.id === 'string' && item.id.startsWith('fc_')) {
    item.id = `tsc_${item.id.slice(3)}`;
  }
  return true;
}

/** Apply restoreToolSearchCall across a response `output` array. Returns the count changed. */
export function restoreToolSearchItems(output: any): number {
  if (!Array.isArray(output)) return 0;
  let n = 0;
  for (const item of output) if (restoreToolSearchCall(item)) n += 1;
  return n;
}
