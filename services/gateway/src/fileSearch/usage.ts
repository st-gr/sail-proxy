/**
 * Usage events for file_search: embedding requests (ingest, re-embed, search), rerank calls,
 * and the gateway's own completions (chunk contexts and page transcriptions at ingestion, query
 * rewrites).
 *
 * These events are not bound to one HTTP request: the ingest and re-embed workers emit them
 * long after the attach or start call returned. So the emitter takes the paying credential
 * explicitly instead of reading it from `req`, and every event carries its own request id
 * (the admin drops an event whose request id an earlier batch already persisted).
 * No SIEM event is sent for these; `emitSiemUsageEvent` is request-bound.
 */
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { getDefaultLogger } from '@libs/logger';
import usageEmitter from '../services/usageEventEmitter';
import { extractAuthInfo } from '../utils/usageTracker';
import { buildFileSearchUsageEvent } from './usageEvent';
import { currentSapTarget } from '../sap/sapTarget';
import type { CompletionUsage } from './orchestrationCompletion';

const logger = getDefaultLogger();

/** The credential a file_search call is billed to. `onBehalfOf` is set only when the
 *  admin service key acted for a cockpit Grounding user. */
export interface FileSearchCaller {
  credentialId: string;
  authType: 'api_key' | 'aws_credential';
  onBehalfOf?: string;
}

export type FileSearchEndpoint =
  | 'file_search/ingest' | 'file_search/reembed' | 'file_search/search' | 'file_search/rerank'
  | 'file_search/context' | 'file_search/rewrite' | 'file_search/vision';

/**
 * One billed call. Embedding and rerank calls set `inputTokens` only. A completion
 * (`file_search/context`, `file_search/rewrite`, `file_search/vision`) also sets the three optional fields, with
 * orchestrationCompletion.ts's `CompletionUsage` split: `inputTokens` = input not read from a
 * prompt cache, cache writes INCLUDED; `cacheWriteTokens` = the part of it written to the
 * cache; `cacheReadTokens` = input read from the cache (not in `inputTokens`).
 * `buildFileSearchUsageEvent` maps that onto the event's four disjoint fields.
 */
export interface FileSearchUsage {
  endpoint: FileSearchEndpoint;
  model: string;
  inputTokens: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** `tokens` for embedding requests and completions, `units` for rerank search units. */
  unit: 'tokens' | 'units';
  responseTime: number;
  requestId: string;
}

/** What a search reports per billed call: one query-embedding request, the rerank's search
 *  units, or the query rewrite. Who pays and the request id are the sink's business. */
export type SearchUsage = Omit<FileSearchUsage, 'requestId' | 'endpoint'> & {
  endpoint: 'file_search/search' | 'file_search/rerank' | 'file_search/rewrite';
};

/** A completion's usage as a usage record (no request id yet). */
export function completionUsageRecord<E extends FileSearchEndpoint>(
  endpoint: E, model: string, usage: CompletionUsage, responseTime: number,
): Omit<FileSearchUsage, 'requestId' | 'endpoint'> & { endpoint: E } {
  return {
    endpoint, model, unit: 'tokens', responseTime,
    inputTokens: usage.input, outputTokens: usage.output,
    cacheWriteTokens: usage.cacheWrite, cacheReadTokens: usage.cachedRead,
  };
}

/** The admin's `requestId` column is `String(100)`. */
const MAX_REQUEST_ID_LENGTH = 100;

/**
 * Emit one usage event, fire-and-forget. A null caller (a legacy row, or one stamped with no
 * credential) records nothing: a credential is never invented. Standalone mode records
 * nothing either; the emitter itself skips it.
 */
export function emitFileSearchUsage(caller: FileSearchCaller | null, u: FileSearchUsage): void {
  if (!caller) {
    logger.debug('FileSearchUsage', 'No credential to bill; usage not recorded', {
      endpoint: u.endpoint, model: u.model, inputTokens: u.inputTokens, requestId: u.requestId,
    });
    return;
  }
  // Every file_search call goes to SAP AI Core: the event carries the tenant it was served by - the
  // target a request is pinned to; an ingest or re-embed worker item pins the latest one for its
  // whole run (withLatestSapTarget), so its SAP calls and these events share it.
  const target = currentSapTarget();
  const event = { ...buildFileSearchUsageEvent(caller, u), sapTenant: target.tenant, sapTenantSource: target.source };
  // The emitter catches its own failures today; this handler keeps a future rejection from
  // escaping as an unhandled rejection (callers do not await) and logs why it failed.
  usageEmitter.emit(event).catch((err: any) => {
    logger.warn('FileSearchUsage', 'Failed to emit file_search usage event', {
      requestId: u.requestId, error: err?.message ?? String(err),
    });
  });
}

/**
 * Who pays for a request-bound file_search call. A cockpit Grounding call (the admin service
 * key with an acting user, see groundingActingUser) is billed to the service key on behalf of
 * that user; any other call to its own credential. Null when no credential is identified.
 */
export function fileSearchCallerOf(req: Request): FileSearchCaller | null {
  const anyReq = req as any;
  if (anyReq.groundingActor) {
    const serviceKeyId = anyReq.serviceAuth?.serviceKey?.id;
    if (typeof serviceKeyId !== 'string' || !serviceKeyId) return null;
    return { credentialId: serviceKeyId, authType: 'api_key', onBehalfOf: anyReq.groundingActor.email };
  }
  const auth = extractAuthInfo(req);
  if (!auth || !auth.credentialId || auth.credentialId === 'unknown') return null;
  return { credentialId: auth.credentialId, authType: auth.authType };
}

/**
 * The caller recorded in the database (a file's attach stamp, a job's credential), or null
 * when none was recorded. An auth type other than `aws_credential` is an API key, as
 * `batchJobIdentity` writes it.
 */
export function storedFileSearchCaller(
  credentialId: string | null | undefined, authType: string | null | undefined, onBehalfOf?: string | null,
): FileSearchCaller | null {
  if (!credentialId) return null;
  return {
    credentialId,
    authType: authType === 'aws_credential' ? 'aws_credential' : 'api_key',
    ...(onBehalfOf ? { onBehalfOf } : {}),
  };
}

/** A request id for one billed request of a worker: `fs-ingest-<uuid>` / `fs-reembed-<uuid>`
 *  (embeddings), `fs-context-<uuid>` (one chunk-context completion), `fs-vision-<uuid>` (one page
 *  transcription). */
export function workerRequestId(kind: 'ingest' | 'reembed' | 'context' | 'vision'): string {
  return `fs-${kind}-${randomUUID()}`;
}

/**
 * A request id derived from the HTTP request's id, for an event that request causes besides
 * its own: `${base}-${suffix}`, with suffixes `fs-embed-<n>`, `fs-rerank` and
 * `fs-<call>-embed-<n>` (Responses tool). A missing or `unknown` base becomes a fresh uuid.
 * At most 100 characters: the base is shortened, never the suffix, so siblings stay distinct.
 */
export function derivedRequestId(base: string | undefined, suffix: string): string {
  const root = base && base !== 'unknown' ? base : randomUUID();
  const tail = `-${suffix}`.slice(0, MAX_REQUEST_ID_LENGTH - 1);
  return `${root.slice(0, MAX_REQUEST_ID_LENGTH - tail.length)}${tail}`;
}

/**
 * The usage sink for ONE search (`SearchOptions.usage`), billed to `caller`. Ids derive from
 * `baseRequestId`: `fs-embed-<n>` per embedding request (n counts from 1), `fs-rerank` and
 * `fs-rewrite` (at most one query rewrite per search).
 * A Responses tool call passes its `callIndex`, giving `fs-<callIndex>-embed-<n>` and
 * `fs-<callIndex>-rerank`, so several calls in one response never share an id. Every id has
 * a suffix, so none equals the request's own usage event id.
 */
export function searchUsageSink(
  caller: FileSearchCaller | null, baseRequestId: string | undefined, callIndex?: number,
): (u: SearchUsage) => void {
  const prefix = callIndex === undefined ? 'fs-' : `fs-${callIndex}-`;
  let embedRequests = 0;
  return (u) => {
    const suffix = u.endpoint === 'file_search/rerank' ? `${prefix}rerank`
      : u.endpoint === 'file_search/rewrite' ? `${prefix}rewrite`
        : `${prefix}embed-${++embedRequests}`;
    emitFileSearchUsage(caller, { ...u, requestId: derivedRequestId(baseRequestId, suffix) });
  };
}
