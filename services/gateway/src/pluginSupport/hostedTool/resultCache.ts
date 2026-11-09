/**
 * Hosted-tool results, kept just long enough for a client to replay the turn that produced
 * them.
 *
 * WHY THIS EXISTS: the engine rewrites a hosted tool into a function tool, then renders the
 * model's function call back into a `<type>_call` item for the client. Codex replays that
 * item on every later turn — but its typed deserializer carries only `id`, `status` and
 * `action`, so results cannot ride along in the item itself (measured: the codex binary's
 * ResponseItem enum has no results field, and unknown fields are dropped or rejected). The
 * id DOES survive, so it is the key here.
 *
 * WHAT IS STORED IS UNMASKED, and deliberately so: masking is a presentation step applied
 * when results are handed to the model, by the descriptor that owns the tool. Caching a
 * masked rendering instead would be both redundant and wrong — placeholders come from the
 * request's own ReplacementMap, and under `anonymization` they are per-request counters, so
 * one request's `MASKED_PERSON_3` is another's someone else.
 *
 * PROCESS-LOCAL, no shared tier. Results stay in the memory of the process that fetched
 * them; a replay landing elsewhere is a miss, and a miss re-executes the recorded query.
 *
 * OWNERSHIP IS CHECKED ON READ: one process serves every tenant, so a mismatched owner reads
 * as a miss, never as someone else's data. What this guarantees: two DIFFERENT non-empty
 * owners never see each other's entries. What it does NOT guarantee on its own: an EMPTY
 * owner is not a tenant identity, it is "identity unresolved" — and every caller whose
 * identity is unresolved would otherwise collapse into the same '' bucket, which is no
 * isolation at all between them. So an empty owner is refused on both sides: `putToolResult`
 * never stores one, and `getToolResult` never matches one, even against another empty-owner
 * entry that (per the above) can no longer exist. Concretely, `ownerEmailFrom` in engine.ts
 * returns '' for AWS SigV4-authenticated requests and for the pre-auth OpenRouter-models /
 * GitHub-Copilot-Chat paths in apiKeyAuth.ts — those requests simply never get a cached
 * replay and always fall through to re-executing the recorded query, which is the documented
 * miss behaviour. A normal API-key-authenticated request (including the codex CLI flow this
 * cache exists for) always resolves a non-empty owner in this deployment: either the real
 * email from the admin service, or the local-fallback constant when validation falls back to
 * the local key store — `ApiKeyValidationData.email` is a required field on both paths.
 *
 * EVICTION IS INSERTION-ORDER, NOT LRU: a `Map` preserves insertion order and is never
 * re-inserted on read, so the oldest-inserted entry is evicted first regardless of how
 * recently it was read.
 */
import { getHostedToolResultCacheTtlSeconds, getHostedToolResultCacheMaxEntries } from '../../services/configService';

export interface CachedToolResult {
  toolType: string;
  ownerEmail: string;
  payload: unknown;
  status: 'completed' | 'failed';
  query: string;
}

interface Entry { value: CachedToolResult; expiresAt: number }

const memory = new Map<string, Entry>();

function evictIfNeeded(): void {
  const cap = getHostedToolResultCacheMaxEntries();
  while (memory.size > cap) {
    const oldest = memory.keys().next();
    if (oldest.done) return;
    memory.delete(oldest.value);
  }
}

export function putToolResult(itemId: string, value: CachedToolResult): void {
  try {
    if (!itemId) return;
    // Fail closed: an unresolved owner is not a tenant identity, so never cache on its
    // behalf — see the module comment on ownership.
    if (!value.ownerEmail) return;
    memory.set(itemId, { value, expiresAt: Date.now() + getHostedToolResultCacheTtlSeconds() * 1000 });
    evictIfNeeded();
  } catch {
    // A cache is an optimisation; a miss re-executes the query. Never let this throw into
    // the render path.
  }
}

export function getToolResult(itemId: string, ownerEmail: string): CachedToolResult | undefined {
  // Fail closed: an unresolved reader can't be scoped to anything, so it never matches —
  // not even an entry that was (incorrectly) stored under an empty owner.
  if (!ownerEmail) return undefined;
  const hit = memory.get(itemId);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) { memory.delete(itemId); return undefined; }
  if (hit.value.ownerEmail !== ownerEmail) return undefined;
  return hit.value;
}

export function __resetToolResultCacheForTests(): void {
  memory.clear();
}
