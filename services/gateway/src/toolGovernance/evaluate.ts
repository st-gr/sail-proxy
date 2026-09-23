/**
 * Pure policy evaluation (spec 2026-09-16 §6, 2026-09-22 §2 and §3). A user policy and an optional
 * key policy are merged with "most restrictive wins": an identity must be allowed by both, the
 * stricter mode applies.
 *
 * Allow patterns come in two kinds (2026-09-22 §2.1). A SCOPED allow, `mcp:<server>/<tool>`, limits
 * that one server's tools; a GLOBAL allow is every other pattern and keeps the original meaning:
 * an empty global list allows everything, a non-empty one requires a match.
 *
 * The trust chain (§3.3): when a request carries output from a source either policy calls
 * untrusted, every declared tool either policy calls sensitive is denied too, under the same mode,
 * with the reason `trust_chain` - a model that has just read a web page must not run the shell.
 * A bare `mcp:<server>` declaration exposes the server's tools without naming them: a narrowed one
 * loses its sensitive names, any other is withheld whole when a sensitive pattern covers the server.
 */
import { matches, matchesAny, MODE_RANK, mcpServer, mcpServerOnly, mcpTool, mcpToolServer, scopedServerOf } from './identity';
import type { Decision, DecisionReason, PolicyMode, ToolIdentity, ToolPolicyBlock } from './identity';

export interface EvaluationResult {
  mode: PolicyMode;
  decisions: Map<ToolIdentity, Decision>;
  /** Identities the adapter must remove from the request (strip mode only). */
  blocked: ToolIdentity[];
  reject: boolean;
  reason?: string;
  policyNames: string[];
  /** The user policy's id (the key policy narrows it); undefined without any block. */
  policyId?: string;
  /**
   * Bare MCP server declarations to narrow, server → tool names (strip mode only, §2.2). A
   * declaration that names no tools lets the model call any of the server's tools; narrowing writes
   * the policy's names into it instead.
   */
  narrow: Map<string, string[]>;
  /** Why each denied identity was denied. */
  reasons: Map<ToolIdentity, DecisionReason>;
  /** The untrusted sources whose output is in the request, sorted; empty when none. */
  taintedBy: ToolIdentity[];
}

const scopedFor = (block: ToolPolicyBlock, server: string): string[] =>
  block.allow.filter((p) => scopedServerOf(p) === server);

/** Deny beats allow; a scoped allow decides its own server's tools; global allows decide the rest. */
export function deniedBy(block: ToolPolicyBlock, identity: ToolIdentity): boolean {
  if (matchesAny(block.deny, identity)) return true;
  const server = mcpToolServer(identity);
  if (server !== null) {
    const scoped = scopedFor(block, server);
    if (scoped.length > 0) return !matchesAny(scoped, identity);
  }
  const global = block.allow.filter((p) => scopedServerOf(p) === null);
  return global.length > 0 && !matchesAny(global, identity);
}

/**
 * The tool names a block limits `server` to: `null` when it does not limit the server (no scoped
 * allow, or `mcp:<server>/*` among them), `'prefix'` when a scoped allow ends in `*` and therefore
 * cannot be written into a request as names.
 */
export function serverLimit(block: ToolPolicyBlock, server: string): string[] | 'prefix' | null {
  const scoped = scopedFor(block, server);
  if (scoped.length === 0 || scoped.includes(`mcp:${server}/*`)) return null;
  if (scoped.some((p) => p.endsWith('*'))) return 'prefix';
  const prefix = `mcp:${server}/`;
  return scoped.map((p) => p.slice(prefix.length));
}

/**
 * Whether a sensitive pattern could cover a tool of `server`, for a bare `mcp:<server>` declaration
 * that exposes the server's tools without naming them: the pattern matches `mcp:<server>` itself,
 * names one of its tools (`mcp:<server>/…`), or is a prefix pattern whose prefix reaches into the
 * server's tools (`mcp:*`, `mcp:ma*`, `mcp:<server>/*`).
 */
function namesServer(pattern: string, server: string): boolean {
  const tools = `mcp:${server}/`;
  return matches(pattern, `mcp:${server}`) || pattern.startsWith(tools)
    || (pattern.endsWith('*') && tools.startsWith(pattern.slice(0, -1)));
}

const labels = (blocks: ToolPolicyBlock[], key: 'sensitive' | 'untrusted'): string[] =>
  blocks.flatMap((b) => (Array.isArray(b[key]) ? b[key]! : []));

export function evaluate(
  declared: ToolIdentity[],
  user: ToolPolicyBlock | null,
  key: ToolPolicyBlock | null,
  forced: ToolIdentity | null,
  sources: ToolIdentity[] = []
): EvaluationResult {
  const blocks = [user, key].filter((b): b is ToolPolicyBlock => !!b);
  const decisions = new Map<ToolIdentity, Decision>();
  const reasons = new Map<ToolIdentity, DecisionReason>();
  const unique = [...new Set(declared)];
  if (blocks.length === 0) {
    for (const id of unique) decisions.set(id, 'allowed');
    return { mode: 'monitor', decisions, blocked: [], reject: false, policyNames: [], narrow: new Map(), reasons, taintedBy: [] };
  }
  const mode = blocks.reduce<PolicyMode>((m, b) => (MODE_RANK[b.mode] > MODE_RANK[m] ? b.mode : m), 'monitor');
  const denied = unique.filter((id) => blocks.some((b) => deniedBy(b, id)));

  // A bare server declaration under a scoped allow (§2.2): narrowed in strip mode, refused in
  // reject mode, recorded in monitor mode or when a prefix makes the names unrenderable.
  const narrow = new Map<string, string[]>();
  const monitoredServers = new Set<ToolIdentity>();
  for (const id of unique) {
    if (denied.includes(id)) continue;
    const server = mcpServerOnly(id);
    if (server === null) continue;
    const limits = blocks.map((b) => serverLimit(b, server)).filter((l): l is string[] | 'prefix' => l !== null);
    if (limits.length === 0) continue;
    if (mode === 'reject') { denied.push(id); continue; }
    if (mode === 'monitor' || limits.includes('prefix')) { monitoredServers.add(id); continue; }
    const lists = limits as string[][];
    narrow.set(server, lists.reduce((acc, list) => acc.filter((name) => list.includes(name))));
  }
  for (const id of denied) reasons.set(id, 'policy');

  const untrusted = labels(blocks, 'untrusted');
  const sensitive = labels(blocks, 'sensitive');
  const taintedBy = [...new Set(sources)].filter((s) => matchesAny(untrusted, s)).sort();
  if (taintedBy.length > 0) {
    for (const id of unique) {
      if (denied.includes(id)) continue;
      const server = mcpServerOnly(id);
      const exposes = server !== null && !narrow.has(server) && sensitive.some((p) => namesServer(p, server));
      if (!matchesAny(sensitive, id) && !exposes) continue;
      denied.push(id);
      reasons.set(id, 'trust_chain');
      if (server !== null) narrow.delete(server);
    }
    // A narrowed server keeps only its names that are not sensitive; an empty list stays `[]`,
    // which the adapters render by dropping the server.
    for (const [server, names] of narrow) {
      const kept = names.filter((name) => !matchesAny(sensitive, mcpTool(server, name)));
      if (kept.length === names.length) continue;
      narrow.set(server, kept);
      reasons.set(mcpServer(server), 'trust_chain');
    }
  }

  const deniedDecision: Decision = mode === 'monitor' ? 'monitored' : mode === 'strip' ? 'stripped' : 'rejected';
  for (const id of unique) {
    const server = mcpServerOnly(id);
    decisions.set(id, denied.includes(id) ? deniedDecision
      : monitoredServers.has(id) ? 'monitored'
      : server !== null && narrow.has(server) ? 'stripped'
      : 'allowed');
  }
  const result: EvaluationResult = {
    mode, decisions, blocked: mode === 'strip' ? denied : [], reject: false,
    policyNames: blocks.map((b) => b.policyName), policyId: (user ?? key)!.policyId, narrow, reasons, taintedBy
  };
  const byPolicy = denied.filter((id) => reasons.get(id) === 'policy');
  const byTrust = denied.filter((id) => reasons.get(id) === 'trust_chain');
  const from = taintedBy.join(', ');
  if (mode === 'reject' && denied.length > 0) {
    result.reject = true;
    result.reason = [
      byPolicy.length > 0 ? `tools not permitted by policy: ${byPolicy.join(', ')}` : '',
      byTrust.length > 0 ? `tools not permitted while the conversation contains content from ${from}: ${byTrust.join(', ')}` : ''
    ].filter(Boolean).join('; ');
  } else if (mode === 'strip' && forced && denied.includes(forced)) {
    result.reject = true;
    result.reason = reasons.get(forced) === 'trust_chain'
      ? `tool_choice names ${forced}, which is withheld while the conversation contains content from ${from}`
      : `tool_choice names ${forced}, which the policy strips`;
    decisions.set(forced, 'rejected');
  }
  return result;
}

/** An invoked tool follows its declared decision; a tool the request never declared is unlisted. */
export function decideInvoked(result: EvaluationResult, identity: ToolIdentity): Decision {
  return result.decisions.get(identity) ?? 'unlisted';
}
