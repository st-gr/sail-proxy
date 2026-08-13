/**
 * SAP-hosted Cohere reranker client for file_search (document retrieval).
 *
 * After the cheap hybrid database search (Task 10/12) produces ~50 candidate
 * chunks via RRF, this sends them to a SAP AI Core `foundation-models` direct
 * deployment running a Cohere cross-encoder, which scores each candidate
 * against the query and returns a calibrated `[0,1]` relevance score. That
 * score is what `ranking_options.score_threshold` filters against.
 *
 * Verified live against the tenant (2026-07-30):
 *  - The deployment's model name is `cohere-reranker`, NOT `cohere-reranker-35`
 *    (SAP's published example payload). The model id is never hardcoded here —
 *    it is read from `getFileSearchConfig().hybrid.rerank.model`, which already
 *    defaults to the correct string.
 *  - Path: `POST ${sapConfig.url}/v2/inference/deployments/${id}/rerank`.
 *  - Response: `{ id, meta: { billed_units: { search_units } }, results: [
 *    { index, relevance_score } ] }`. `results` is already ordered by
 *    relevance, descending. There is no echoed document text — candidates are
 *    mapped back purely by `index`.
 *  - `relevance_score` is normalised to [0,1] but not linearly calibrated: an
 *    ordering and a threshold, never a ratio.
 *
 * Deployment discovery (`getRerankerDeploymentId`, re-exported here for a
 * single import surface) lives in deploymentDiscoveryService.ts, copied
 * structurally from `getPerplexityDeploymentId` — its own module-level cache
 * variable and the same 25%-TTL negative-caching-on-failure behaviour, with
 * only the model-name predicate changed.
 *
 * Degradation contract — this is the behaviour that matters most:
 *  - `hybrid.rerank.enabled === false`: reranking is never attempted; no
 *    deployment lookup, no HTTP call. Returns null immediately.
 *  - `hybrid.rerank.enabled === 'auto'` (the default): best-effort. Returns
 *    null — never throws — when no RUNNING deployment is discoverable, and
 *    also when the call itself fails for any reason (timeout, 5xx, malformed
 *    body). A transient reranker outage degrades search to the database's RRF
 *    ordering instead of failing the request.
 *  - `hybrid.rerank.enabled === true`: reranking was explicitly demanded, so
 *    an operator must not silently get degraded (RRF-only) results. Both "no
 *    deployment found" and "the call failed" THROW here instead of returning
 *    null, surfacing the problem instead of hiding it.
 *
 * Only `meta.billed_units.search_units` is logged (at info level, so cost is
 * visible from day one — Plan 3 turns it into a usage record). The query and
 * document text are never logged: that is user document content.
 */
import axios from 'axios';
import configService from '../services/configService';
import { getRerankerDeploymentId } from '../services/deploymentDiscoveryService';
import { getDefaultLogger } from '@libs/logger';
import { readUpstreamErrorBody } from '../utils/upstreamErrorBody';

export { getRerankerDeploymentId };

const logger = getDefaultLogger();

const RERANK_TIMEOUT_MS = 30000;

export interface RerankHit {
  index: number;
  relevanceScore: number;
}

/** `hits` in relevance-descending order; `searchUnits` is the billed
 *  `meta.billed_units.search_units` from the SAP response, when present —
 *  the figure that makes "can we drop Cohere for an open-weight model?"
 *  answerable directly from the teacher-log table. */
export interface RerankResult {
  hits: RerankHit[];
  searchUnits?: number;
}

/**
 * `hybrid.rerank.enabled: true` means the operator demanded stage 2. Without a
 * deployment there is nothing to demand, and a statusless Error would surface as a
 * generic 500 carrying this message. 503 matches what every other file_search
 * unavailability emits (filesController.ts, vectorStoresController.ts).
 *
 * The message is a fixed string — see the sole `throw` site below — and never
 * interpolates caller-supplied text (not the query, not a document, not an id).
 */
export class RerankerUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'file_search_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'RerankerUnavailableError';
  }
}

interface SapRerankResult {
  index: number;
  relevance_score: number;
}

interface SapRerankResponse {
  id?: string;
  meta?: { billed_units?: { search_units?: number } };
  results?: SapRerankResult[];
}

/**
 * Rerank candidate documents against a query using the SAP-hosted Cohere
 * cross-encoder. See the module doc comment above for the full degradation
 * contract; in short: null means "unavailable, caller keeps RRF order",
 * except under `enabled: true`, where unavailability throws instead.
 *
 * @param query - the (already-rewritten, if applicable) search query. Never
 *   logged.
 * @param documents - candidate chunk texts, in the same order their `index`
 *   will be reported against. Never logged.
 * @param topN - how many top-scoring results to request back from the API.
 */
export async function rerank(
  query: string,
  documents: string[],
  topN: number
): Promise<RerankResult | null> {
  const fileSearchConfig = configService.getFileSearchConfig();
  const enabled = fileSearchConfig.hybrid.rerank.enabled;

  if (enabled === false) {
    return null;
  }

  const required = enabled === true;

  const deploymentId = await getRerankerDeploymentId();
  if (!deploymentId) {
    const message = 'No RUNNING SAP AI Core reranker deployment was found for file_search';
    if (required) {
      throw new RerankerUnavailableError(message);
    }
    logger.debug('Reranker', `${message} — degrading to RRF order (hybrid.rerank.enabled=auto)`);
    return null;
  }

  const sapConfig = configService.getSAPAICoreConfig();
  const accessToken = await configService.getAccessToken();
  const url = `${sapConfig.url}/v2/inference/deployments/${deploymentId}/rerank`;

  const payload = {
    model: fileSearchConfig.hybrid.rerank.model,
    query,
    documents,
    top_n: topN,
  };

  let response;
  try {
    response = await axios.post<SapRerankResponse>(url, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'AI-Resource-Group': sapConfig.resourceGroup || 'default',
        'Content-Type': 'application/json',
      },
      timeout: RERANK_TIMEOUT_MS,
    });
  } catch (error: any) {
    // Never JSON.stringify an axios error: error.response.data can be a
    // circular IncomingMessage stream on the error path.
    const upstreamBody = await readUpstreamErrorBody(error?.response);
    logger.error('Reranker', `Rerank request failed: ${error.message}`, error, {
      status: error?.response?.status,
      upstreamBody,
    });
    if (required) {
      throw error;
    }
    return null;
  }

  const results = response.data?.results;
  if (!Array.isArray(results)) {
    const malformed = new Error('SAP reranker response is missing a results array');
    logger.error('Reranker', malformed.message, malformed, { status: response.status });
    if (required) {
      throw malformed;
    }
    return null;
  }

  // Metadata only: billed search_units is cost-relevant and safe to log.
  // Query text and document text are user document content and must never
  // be logged.
  const searchUnits = response.data?.meta?.billed_units?.search_units;
  logger.info('Reranker', 'Rerank request completed', {
    documentCount: documents.length,
    resultCount: results.length,
    searchUnits,
  });

  return {
    hits: results.map((r) => ({ index: r.index, relevanceScore: r.relevance_score })),
    searchUnits,
  };
}
