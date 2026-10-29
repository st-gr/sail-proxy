/**
 * The usage event a file_search call records, as a pure function: no logger, emitter or
 * config imports, so the admin's contract test can build the exact event the gateway sends.
 */
import type { UsageEvent } from '../types/usage';
import type { FileSearchCaller, FileSearchUsage } from './usage';

/**
 * `timestamp` is whole Unix seconds, like the main tracker's; the admin reads `timestamp * 1000`.
 *
 * A completion's usage (any of `outputTokens`, `cacheWriteTokens`, `cacheReadTokens` set) maps
 * onto the event's four DISJOINT fields, which the admin prices separately and adds:
 * `inputTokens` = full-rate input only (`u.inputTokens − u.cacheWriteTokens`),
 * `cacheCreationInputTokens` = `u.cacheWriteTokens`, `cacheReadInputTokens` = `u.cacheReadTokens`,
 * `outputTokens` = `u.outputTokens`. Their sum is the whole prompt plus the output. An embedding
 * or rerank event carries no cache fields and `outputTokens: 0`, exactly as before.
 */
export function buildFileSearchUsageEvent(caller: FileSearchCaller, u: FileSearchUsage, nowMs: number = Date.now()): UsageEvent {
  const completion = u.outputTokens !== undefined || u.cacheWriteTokens !== undefined || u.cacheReadTokens !== undefined;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  return {
    requestId: u.requestId,
    timestamp: Math.floor(nowMs / 1000),
    authType: caller.authType,
    credentialId: caller.credentialId,
    ...(caller.onBehalfOf ? { onBehalfOf: caller.onBehalfOf } : {}),
    provider: 'unknown', // the admin resolves it from the model
    model: u.model,
    inputTokens: completion ? Math.max(0, u.inputTokens - cacheWrite) : u.inputTokens,
    outputTokens: u.outputTokens ?? 0,
    ...(completion ? { cacheCreationInputTokens: cacheWrite, cacheReadInputTokens: u.cacheReadTokens ?? 0 } : {}),
    responseTime: u.responseTime,
    statusCode: 200,
    endpoint: u.endpoint,
    unit: u.unit,
  };
}
