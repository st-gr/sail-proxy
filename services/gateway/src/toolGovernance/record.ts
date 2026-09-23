/**
 * Request-scoped collection of invoked tools and the fold into the usage event. The middleware
 * seeds `req.toolGovernance`; controllers append invoked identities at their usage-parse sites;
 * emitUsageEvent calls toolsForEvent. Nothing here awaits or throws.
 */
import { resolveInvoked } from './identity';
import { normaliseIdentity } from './mcpNaming';
import type { ResolvedConvention } from './mcpNaming';
import type { ToolIdentity } from './identity';
import type { EvaluationResult } from './evaluate';
import { decideInvoked, deniedBy } from './evaluate';
import type { ToolPolicyBlock } from './identity';
import type { ToolAdapter } from './adapters/types';
import type { ToolUsageEntry } from '../types/usage';

export interface ToolGovernanceState {
  result: EvaluationResult;
  declared: ToolIdentity[];
  invoked: Map<ToolIdentity, number>;
  family: ToolAdapter['family'];
  /** The calling client's MCP naming convention, resolved from its user agent by the middleware. */
  convention?: ResolvedConvention;
  /** The policy blocks in force, so a tool nobody declared can still be judged against them. */
  blocks?: ToolPolicyBlock[];
  /** MCP tools reached inside a container tool's call, with the verdict each one earned. */
  nested?: Map<ToolIdentity, { count: number; denied: boolean }>;
  /** Normalised identities whose output the request carried; duplicates kept. */
  sources?: ToolIdentity[];
}

export function stateOf(req: any): ToolGovernanceState | undefined {
  const s = req?.toolGovernance;
  return s && s.result && s.invoked instanceof Map ? s : undefined;
}

/**
 * The blocks a response-side check should apply: the policy blocks, plus - when the request carried
 * untrusted output - one block that denies the sensitive patterns, so the call gate and nested
 * recording apply the trust chain without knowing about it.
 */
export function effectiveBlocks(s: ToolGovernanceState): ToolPolicyBlock[] {
  const blocks = s.blocks ?? [];
  if (blocks.length === 0 || (s.result.taintedBy ?? []).length === 0) return blocks;
  const sensitive = blocks.flatMap((b) => b.sensitive ?? []);
  if (sensitive.length === 0) return blocks;
  return [...blocks, { policyId: s.result.policyId ?? 'trust-chain', policyName: 'trust chain', mode: s.result.mode, allow: [], deny: sensitive }];
}

/**
 * MCP tools a container tool's call reached, recorded from the response the gateway proxies. They
 * were never declared, so they carry no declared decision: a tool the policy denies is `detected`
 * (used, not prevented) and any other is `unlisted` (used, nobody declared it).
 */
export function recordNestedTools(req: any, identities: ToolIdentity[]): void {
  const s = stateOf(req);
  if (!s || identities.length === 0) return;
  s.nested ??= new Map();
  for (const identity of identities) {
    const denied = effectiveBlocks(s).some((b) => deniedBy(b, identity));
    const seen = s.nested.get(identity);
    s.nested.set(identity, { count: (seen?.count ?? 0) + 1, denied: seen?.denied || denied });
  }
}

export function recordInvokedTools(req: any, identities: ToolIdentity[]): void {
  const s = stateOf(req);
  if (!s) return;
  // Reconciled against what the request declared: the gateway rewrites hosted and custom tools into
  // function tools before the upstream call, so an invocation of either comes back as a function
  // call and would otherwise be recorded as a tool nobody declared (see resolveInvoked).
  for (const id of identities) {
    // Same normalisation the middleware applied to the declared tools, so an invoked
    // `mcp__server__tool` lands on the identity its declaration carries rather than beside it.
    const named = s.convention ? normaliseIdentity(id, s.convention) : id;
    const resolved = resolveInvoked(named, s.declared);
    s.invoked.set(resolved, (s.invoked.get(resolved) ?? 0) + 1);
  }
}

/** Declared entries (one per unique identity) followed by invoked entries with their counts. */
export function toolsForEvent(req: any): ToolUsageEntry[] | undefined {
  const s = stateOf(req);
  if (!s) return undefined;
  const out: ToolUsageEntry[] = [];
  const reasonFor = (identity: ToolIdentity, decision: string) =>
    decision === 'allowed' || decision === 'unlisted' ? {} : s.result.reasons?.has(identity) ? { reason: s.result.reasons.get(identity)! } : {};
  const declaredCounts = new Map<ToolIdentity, number>();
  for (const id of s.declared) declaredCounts.set(id, (declaredCounts.get(id) ?? 0) + 1);
  for (const [identity, count] of declaredCounts) {
    const decision = s.result.decisions.get(identity) ?? 'allowed';
    out.push({ identity, facet: 'declared', count, decision, ...reasonFor(identity, decision) });
  }
  for (const [identity, count] of s.invoked) {
    const decision = decideInvoked(s.result, identity);
    out.push({ identity, facet: 'invoked', count, decision, ...reasonFor(identity, decision) });
  }
  for (const [identity, { count, denied }] of s.nested ?? []) {
    out.push({ identity, facet: 'invoked', count, decision: denied ? 'detected' : 'unlisted' });
  }
  const sourceCounts = new Map<ToolIdentity, number>();
  for (const id of s.sources ?? []) sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1);
  for (const [identity, count] of sourceCounts) out.push({ identity, facet: 'source', count, decision: 'allowed' });
  return out.length > 0 ? out : undefined;
}

/**
 * Everything a response-side gate needs, or undefined when the request was never governed: the
 * caller's policy blocks (including the trust chain's synthetic block) and the client's naming
 * convention. The gate itself only enforces under Strip and Reject (2026-09-18 host-executed spec):
 * under Monitor every call passes, so `blocks` is empty and the nested call is only recorded, never
 * refused - `recordNestedTools` judges it against `effectiveBlocks` regardless of mode, so it still
 * comes out `detected` rather than `unlisted`.
 */
export function gateContext(req: any): { convention: ResolvedConvention; blocks: ToolPolicyBlock[] } | undefined {
  const s = stateOf(req);
  if (!s?.convention || !s.blocks || s.blocks.length === 0) return undefined;
  return { convention: s.convention, blocks: s.result.mode === 'monitor' ? [] : effectiveBlocks(s) };
}
