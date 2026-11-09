/**
 * Tool identities and pattern matching for tool governance (spec §3). Pure: no Express, no
 * logging. Every tool a request declares or a response invokes is reduced to one string,
 * `namespace:name`, so policies written once apply to every API family the same way.
 */
export type ToolIdentity = string;
/**
 * `detected` is the verdict for a tool the policy denies that the gateway saw being USED without
 * having prevented it: a nested MCP call inside a client's own container tool, for instance. It
 * never claims the call was stopped - `rejected` means that - and it never claims it was permitted.
 */
export type Decision = 'allowed' | 'monitored' | 'stripped' | 'rejected' | 'unlisted' | 'detected';
export type PolicyMode = 'monitor' | 'strip' | 'reject';
/** Why a tool was denied: the policy's allow/deny lists, or the trust chain (spec 2026-09-22 §3). */
export type DecisionReason = 'policy' | 'trust_chain';

/** The block the admin attaches to a validation response (user policy, and optionally the key's). */
export interface ToolPolicyBlock {
  policyId: string;
  policyName: string;
  mode: PolicyMode;
  allow: string[];
  deny: string[];
  /** Tools that act; withheld once untrusted output is in the conversation. Absent from an older admin. */
  sensitive?: string[];
  /** Tools whose output may carry third-party content. Absent from an older admin. */
  untrusted?: string[];
}

/** A tool result whose call is not in the request (a client truncated its history). */
export const UNKNOWN_SOURCE: ToolIdentity = 'function:<unknown>';

/** Stricter mode wins when a user policy and a key policy both apply. */
export const MODE_RANK: Record<PolicyMode, number> = { monitor: 0, strip: 1, reject: 2 };

/** `namespace:name`, optionally ending in one `*`, or a bare `namespace:*`; no whitespace, no other `*`. */
export const PATTERN_SYNTAX = /^(function|hosted|mcp):([^*\s]+\*?|\*)$/;

export function functionTool(name: string): ToolIdentity { return `function:${name}`; }
/** Anthropic server tools carry a date suffix (`web_search_20250305`); the identity drops it. */
export function hostedTool(type: string): ToolIdentity { return `hosted:${type.replace(/_\d{8}$/, '')}`; }
export function mcpServer(label: string): ToolIdentity { return `mcp:${label}`; }
export function mcpTool(label: string, tool: string): ToolIdentity { return `mcp:${label}/${tool}`; }
/** A typed tool that carries its own name (`{type:'custom',name:'exec'}` → `hosted:custom/exec`). */
export function hostedNamedTool(type: string, name: string): ToolIdentity { return `${hostedTool(type)}/${name}`; }

/** The tool's own name: the last path segment, or the part after the namespace. */
export function toolName(identity: ToolIdentity): string {
  const afterNamespace = identity.slice(identity.indexOf(':') + 1);
  const slash = afterNamespace.lastIndexOf('/');
  return slash === -1 ? afterNamespace : afterNamespace.slice(slash + 1);
}

/** The server of an `mcp:<server>/<tool>` identity; null for anything else, a bare `mcp:<server>` included. */
export function mcpToolServer(identity: ToolIdentity): string | null {
  const m = /^mcp:([^/]+)\/.+$/.exec(identity);
  return m ? m[1] : null;
}

/** The server of a bare `mcp:<server>` identity (a declaration naming no tools); null otherwise. */
export function mcpServerOnly(identity: ToolIdentity): string | null {
  const m = /^mcp:([^/]+)$/.exec(identity);
  return m ? m[1] : null;
}

/**
 * The server an allow pattern is SCOPED to (spec 2026-09-22 §2.1): `mcp:<server>/<tool-or-prefix*>`
 * with a literal server. Such a pattern limits that server's tools and nothing else. Every other
 * allow pattern is global - `mcp:<server>` alone, `mcp:git*`, `mcp:*`, `function:…`, `hosted:…`.
 */
export function scopedServerOf(pattern: string): string | null {
  const m = /^mcp:([^/*\s]+)\/\S+$/.exec(pattern);
  return m ? m[1] : null;
}

/**
 * The identity an invoked tool should be recorded under, given what the request declared.
 *
 * The gateway rewrites a Responses request's hosted and custom tools into plain function tools
 * before calling SAP AI Core, so the model's invocations come back as function calls whatever the
 * client declared: a custom tool named `exec` is invoked as `function:exec`, a hosted `web_search`
 * as `function:web_search`. Taken literally each of those is a tool nobody declared - a second
 * inventory row marked "unlisted", carrying no policy decision. When the invoked name matches
 * exactly ONE declared tool, the invocation is recorded under that declaration instead. An exact
 * declaration wins, and ambiguity is left alone rather than guessed.
 *
 * Only function calls are reconciled: an `mcp:` or `hosted:` invocation already names its own
 * namespace, so a same-named tool elsewhere is a different tool, not the one that was called.
 */
export function resolveInvoked(invoked: ToolIdentity, declared: ToolIdentity[]): ToolIdentity {
  if (declared.includes(invoked)) return invoked;
  if (!invoked.startsWith('function:')) return invoked;
  const name = toolName(invoked);
  if (!name) return invoked;
  const candidates = [...new Set(declared.filter((id) => toolName(id) === name))];
  return candidates.length === 1 ? candidates[0] : invoked;
}

/** Exact match, or prefix match when the pattern ends in `*`. Case-sensitive. */
export function matches(pattern: string, identity: ToolIdentity): boolean {
  if (pattern.endsWith('*')) return identity.startsWith(pattern.slice(0, -1));
  return pattern === identity;
}

export function matchesAny(patterns: string[], identity: ToolIdentity): boolean {
  return patterns.some((p) => matches(p, identity));
}
