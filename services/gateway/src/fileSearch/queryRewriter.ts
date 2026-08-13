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
 * See `docs/developer/chapter-16-file-search-tool.md`.
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
 * caller's original query, logged at debug only. Never throws.
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
 * `getFileSearchConfig().rewriteQueryModel` (default `'gpt-4o-mini'`,
 * confirmed working: ~1.3s, clean single-line rewrite) rather than a
 * constant. Do not restore `gpt-35-turbo-16k` here.
 */
import axios from 'axios';
import configService from '../services/configService';
import { getDefaultLogger } from '@libs/logger';

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
 */
export async function rewriteSearchQuery(query: string): Promise<string> {
  try {
    const deploymentId = await configService.getDeploymentId();
    if (!deploymentId) {
      logger.debug('QueryRewriter', 'No orchestration deployment available; using the original query');
      return query;
    }

    const sapConfig = configService.getSAPAICoreConfig();
    const accessToken = await configService.getAccessToken();
    const url = `${sapConfig.url}/v2/inference/deployments/${deploymentId}/v2/completion`;
    const rewriteModel = configService.getFileSearchConfig().rewriteQueryModel;

    const payload = {
      config: {
        modules: {
          prompt_templating: {
            prompt: {
              template: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: query },
              ],
            },
            model: { name: rewriteModel, params: { temperature: 0 } },
          },
        },
      },
    };

    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'AI-Resource-Group': sapConfig.resourceGroup || 'default',
        'Content-Type': 'application/json',
      },
      timeout: REWRITE_TIMEOUT_MS,
    });

    const rewritten = response.data?.final_result?.choices?.[0]?.message?.content;
    if (typeof rewritten !== 'string' || rewritten.trim().length === 0) {
      logger.debug('QueryRewriter', 'Rewrite returned no usable text; using the original query');
      return query;
    }
    return rewritten.trim();
  } catch (error: any) {
    // Best-effort only: log the failure reason (never the query text itself)
    // at debug and fall back, rather than letting a rewrite outage fail the
    // whole search.
    logger.debug('QueryRewriter', `Query rewrite failed, falling back to the original query: ${error.message}`);
    return query;
  }
}
