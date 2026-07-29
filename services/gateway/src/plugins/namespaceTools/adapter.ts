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
  // Prototype-less: a tool name is attacker-adjacent data, and a plain literal would both
  // READ inherited members (`map['toString']` is a truthy function, and `map['__proto__']`
  // is Object.prototype — which renestFunctionCall would stamp on the call as
  // `"namespace":{}`) and fail to WRITE at all (`map['__proto__'] = ns` goes through
  // Object.prototype's `__proto__` SETTER, which silently ignores a string: no own
  // property is created and the prototype is unchanged either, so such a tool is reported
  // hoisted while never mapping).
  const map: Record<string, string> = Object.create(null);
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
