/**
 * Query rewriting for file_search retrieval (`rewrite_query`, config key
 * `file_search.rewrite_query`, defaulting to FALSE — see
 * `configService.FILE_SEARCH_DEFAULTS.rewriteQuery`).
 *
 * The default was flipped when the hosted `file_search` TOOL shipped: it costs
 * ~1.3s on every search, and on the tool path the model has already turned the
 * user's turn into a search query, so rewriting that a second time drifts it
 * further from what was asked. Only the REST endpoint
 * (`POST /vector_stores/{id}/search`) still consults the config value at all —
 * the tool passes `rewriteQuery: false` explicitly (see
 * `plugins/fileSearch/descriptor.ts`), so this module is unreachable from it
 * whatever the config says. NOTE that no EXISTING install picks the new default
 * up: standalone copies the template once at first run, and Docker/Kyma take the
 * admin-activated configuration wholesale from the database with no merge.
 * See `docs/developer/file-search-tool.md`.
 *
 * OpenAI's `file_search` tool rewrites the caller's raw query into a better
 * search query before embedding it. Accepting `rewrite_query` and silently
 * doing nothing would be exactly the "silence instead of a 400" failure mode
 * the hand-off notes warned about for this feature, so this module actually
 * calls the tenant's orchestration deployment — the same one embeddings and
 * reranking reach via `configService.getDeploymentId()` / the SAP AI Core
 * `/v2/inference/deployments/{id}/...` surface — to rewrite the query.
 *
 * Best-effort, unlike the reranker: `rewriteQuery` is a plain boolean, not
 * `true | false | 'auto'`, so there is no operator-facing "require rewriting"
 * mode to honour. A rewrite failure (no deployment discoverable, timeout,
 * malformed response) must never fail the search itself — it degrades to the
 * caller's original query, with a reason-coded log line. Never throws.
 *
 * The call itself goes through the shared internal completion helper
 * (orchestrationCompletion.ts: deployment discovery, sampling drop, payload
 * layout, timeout, usage fold). The query travels in `messages_history`, never in
 * the template SAP parses for placeholders. The tokens spent are reported to the
 * caller's usage sink as one `file_search/rewrite` record.
 *
 * Query text is user-authored, potentially sensitive search content — never
 * logged at info level or above, matching the rest of file_search.
 *
 * MODEL IS CONFIG-DRIVEN, never hardcoded — exactly like `hybrid.rerank.
 * model`. Verified live against the tenant (2026-07-30): this codebase's
 * usual no-model-specified fallback elsewhere, `gpt-35-turbo-16k`, returns
 * HTTP 400 ("Model name 'gpt-35-turbo-16k' is not supported") from this
 * tenant's orchestration `/v2/completion`. A model name that works on one
 * SAP AI Core tenant is not guaranteed to work on another's, so this reads
 * `getFileSearchConfig().rewriteQueryModel` (default `'gpt-5-mini'`) rather
 * than a constant. Do not restore `gpt-35-turbo-16k` here.
 */
import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import { CompletionError, orchestrationComplete } from './orchestrationCompletion';
import { completionUsageRecord, SearchUsage } from './usage';

const logger = getDefaultLogger();

const REWRITE_TIMEOUT_MS = 10000;

const SYSTEM_PROMPT =
  'You rewrite search queries for a document retrieval system. Given the ' +
  "user's query, rewrite it into a concise, keyword-rich query that " +
  'maximizes recall against a corpus of documents, preserving the original ' +
  'meaning, intent and language. Reply with ONLY the rewritten query text — ' +
  'no quotes, no explanation, no preamble.';

/**
 * Rewrites `query` via the tenant's orchestration deployment for better
 * retrieval recall. Returns the original `query`, unchanged, on any failure
 * — no deployment discoverable, a network/timeout error, or a malformed
 * response — so a rewrite outage degrades search rather than failing it.
 * `onUsage` receives the tokens a completed call spent (also when its reply was
 * empty); a sink that throws is ignored.
 */
export async function rewriteSearchQuery(query: string, onUsage?: (u: SearchUsage) => void): Promise<string> {
  let rewriteModel = '';
  const report = (usage: CompletionError['usage'], elapsedMs: number) => {
    if (!onUsage || !usage) return;
    try {
      onUsage(completionUsageRecord('file_search/rewrite', rewriteModel, usage, elapsedMs));
    } catch (error: any) {
      logger.warn('QueryRewriter', `Rewrite usage sink failed and was ignored: ${error?.message}`);
    }
  };
  try {
    rewriteModel = configService.getFileSearchConfig().rewriteQueryModel;
    const started = Date.now();
    try {
      const result = await orchestrationComplete({
        model: rewriteModel,
        system: SYSTEM_PROMPT,
        messages: [{ text: query }],
        // The model's refused sampling parameters are dropped by the helper's shared
        // per-model rule (gpt-5 family refuses temperature other than 1).
        params: { temperature: 0 },
        timeoutMs: REWRITE_TIMEOUT_MS,
      });
      report(result.usage, result.elapsedMs);
      return result.text;
    } catch (error) {
      // An empty or truncated reply still spent tokens.
      if (error instanceof CompletionError && error.usage) report(error.usage, Date.now() - started);
      throw error;
    }
  } catch (error: any) {
    // Best-effort only: log the failure reason (never the query text itself)
    // and fall back, rather than letting a rewrite outage fail the whole
    // search. Warn, not debug: a rewrite that always fails (a refused
    // parameter, a model the tenant does not serve) must be visible.
    if (error instanceof CompletionError && error.reason === 'no_deployment') {
      logger.debug('QueryRewriter', 'Query rewrite skipped, using the original query (reason=no_deployment)');
    } else if (error instanceof CompletionError && (error.reason === 'empty_response' || error.reason === 'truncated')) {
      logger.warn('QueryRewriter', `Query rewrite fell back to the original query (reason=${error.reason})`, { model: rewriteModel });
    } else {
      logger.warn('QueryRewriter', 'Query rewrite fell back to the original query (reason=request_failed)', {
        status: error?.status, error: error?.message,
      });
    }
    return query;
  }
}
