/**
 * SAP AI Core embeddings client for file_search (document retrieval).
 *
 * Turns chunk text (ingestion) and query text (search) into vectors via the
 * orchestration `/v2/embeddings` endpoint. There is no standalone embedding-model
 * deployment in this tenant; embeddings are only reachable through a RUNNING
 * orchestration deployment, discovered the same way `searchExecutor.ts` discovers
 * one for chat completions (`configService.getDeploymentId()`, which wraps
 * `deploymentDiscoveryService` with caching).
 *
 * Verified live against the tenant (2026-07-30). The spec's open item 1
 * ("does /v2/embeddings accept an array of inputs, or only a single string?")
 * and two further assumptions in the original task brief are resolved here,
 * with the brief's assumptions corrected as follows:
 *
 * 1. BATCHING — `input.text` accepts an ARRAY. `{"input":{"text":["a","b"]}}`
 *    returns one vector per input, in an `index`-tagged array (index 0, 1, ...
 *    correct). A whole chunk batch is therefore ONE request; no bounded-fan-out
 *    is implemented here, unlike the extract/chunk stages which do use
 *    `ingestion.concurrency` for their own, unrelated fan-out.
 *
 * 2. `input.input_type` IS REJECTED — HTTP 400: "Additional properties are not
 *    allowed ('input_type' was unexpected) - 'input'". It must never be placed
 *    on the wire. `inputType` remains a parameter on `embed()` because Task 11
 *    (ingestion) and Task 12 (search) call it as 'document' / 'query'
 *    respectively and it documents intent at every call site — see the comment
 *    at the call site below before "fixing" this back onto the payload. Because
 *    the schema rejects it, corpus and query embeddings share one vector space
 *    by construction, which is exactly what makes retrieval work.
 *
 * 3. RESPONSE SHAPE has a wrapper: `{ request_id, final_result: { object, data:
 *    [{ index, embedding }], model, usage: { prompt_tokens, total_tokens } } }`.
 *    A flat `{ data: [{ embedding }] }` (the brief's mocked shape) is the INNER
 *    shape only. Each element's `index` is honoured rather than assuming array
 *    order, since chunk N's vector must belong to chunk N. Because `index` is
 *    attacker/upstream-controlled, it is validated (integer, in-range,
 *    non-duplicate) BEFORE being used to place a vector, so a malformed
 *    response can't leave a hole in the array that the length check and the
 *    dimension guard below would silently miss — `Array.prototype.forEach`
 *    skips holes in a sparse array, so a length-correct response with an
 *    out-of-range or duplicated index used to pass both guards.
 *
 * 4. DIMENSIONS — `text-embedding-3-large` returns 3072-dim vectors by default,
 *    but the pgvector column is pinned to `vector(embeddingDimensions)`
 *    (`getFileSearchConfig().embeddingDimensions`, 1536 by default). This client
 *    MUST send `config.modules.embeddings.model.params.dimensions` set to the
 *    configured value (verified working: returns vectors of exactly that
 *    length) and MUST reject a response whose vector length disagrees with it —
 *    without the guard, every chunk insert against the fixed-width column fails.
 *
 * 5. USAGE — `final_result.usage.prompt_tokens` / `total_tokens` are returned
 *    and surfaced on `EmbedResult.usage` so ingestion can attribute cost against
 *    the uploader (Plan 3). Token counts are logged at debug; chunk text itself
 *    is never logged (it is user document content).
 */
import axios from 'axios';
import configService from '../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { readUpstreamErrorBody } from '../utils/upstreamErrorBody';

const logger = getDefaultLogger();

const EMBEDDINGS_TIMEOUT_MS = 30000;

export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface EmbedResult {
  vectors: number[][];
  usage: EmbeddingUsage;
}

interface SapEmbeddingDatum {
  index?: number;
  embedding: number[];
}

interface SapEmbeddingResponse {
  request_id?: string;
  final_result?: {
    object?: string;
    data?: SapEmbeddingDatum[];
    model?: string;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
}

/**
 * Embed a batch of texts through SAP AI Core orchestration.
 *
 * @param texts - chunk or query text; embedded raw (never masked — masking either
 *   side would put corpus and query into different vector spaces).
 * @param inputType - 'document' for ingestion, 'query' for search. Documents
 *   call-site intent only: the orchestration `/v2/embeddings` schema rejects
 *   `input.input_type` with HTTP 400, so this is deliberately NOT sent on the
 *   wire. Do not add it to the payload below.
 */
export async function embed(
  texts: string[],
  inputType: 'document' | 'query'
): Promise<EmbedResult> {
  void inputType;

  if (texts.length === 0) {
    return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
  }

  const fileSearchConfig = configService.getFileSearchConfig();
  const sapConfig = configService.getSAPAICoreConfig();
  const [accessToken, deploymentId] = await Promise.all([
    configService.getAccessToken(),
    configService.getDeploymentId(),
  ]);

  if (!deploymentId) {
    throw new Error('No SAP AI Core orchestration deployment available for embeddings');
  }

  const url = `${sapConfig.url}/v2/inference/deployments/${deploymentId}/v2/embeddings`;

  const payload = {
    input: { text: texts },
    config: {
      modules: {
        embeddings: {
          model: {
            name: fileSearchConfig.embeddingModel,
            params: { dimensions: fileSearchConfig.embeddingDimensions },
          },
        },
      },
    },
  };

  let response;
  try {
    response = await axios.post<SapEmbeddingResponse>(url, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'AI-Resource-Group': sapConfig.resourceGroup || 'default',
        'Content-Type': 'application/json',
      },
      timeout: EMBEDDINGS_TIMEOUT_MS,
    });
  } catch (error: any) {
    // Never JSON.stringify an axios error: error.response.data can be a
    // circular IncomingMessage stream on the error path.
    const upstreamBody = await readUpstreamErrorBody(error?.response);
    logger.error('Embedder', `Embeddings request failed: ${error.message}`, error, {
      status: error?.response?.status,
      upstreamBody,
    });
    throw error;
  }

  const data = response.data?.final_result?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(
      `SAP embeddings response returned ${data?.length ?? 0} vectors for ${texts.length} inputs`
    );
  }

  // Validate index density BEFORE building the vectors array. A response can
  // carry the correct number of data points (passing the length check above)
  // while its `index` values are out of range or duplicated — that leaves
  // holes in `vectors` that the dimension guard below would silently skip,
  // since `Array.prototype.forEach` never visits holes in a sparse array.
  // Rejecting bad indices here guarantees every slot in `vectors` gets
  // written exactly once, i.e. the array handed to the dimension guard is
  // provably dense.
  const seenIndices = new Set<number>();
  data.forEach((datum, position) => {
    const idx = typeof datum.index === 'number' ? datum.index : position;
    if (!Number.isInteger(idx) || idx < 0 || idx >= texts.length) {
      throw new Error(
        `SAP embeddings response carried an out-of-range index: ${idx} (expected 0..${texts.length - 1})`
      );
    }
    if (seenIndices.has(idx)) {
      throw new Error(`SAP embeddings response carried a duplicate index: ${idx}`);
    }
    seenIndices.add(idx);
  });

  const vectors: number[][] = new Array(texts.length);
  data.forEach((datum, position) => {
    const idx = typeof datum.index === 'number' ? datum.index : position;
    vectors[idx] = datum.embedding;
  });

  const expectedDim = fileSearchConfig.embeddingDimensions;
  vectors.forEach((vector, idx) => {
    if (!Array.isArray(vector) || vector.length !== expectedDim) {
      throw new Error(
        `Embedding at index ${idx} has dimension ${vector?.length ?? 0}, expected ${expectedDim} ` +
        `(configured embeddingDimensions) — refusing to insert a vector that would ` +
        `silently corrupt the pinned vector(${expectedDim}) column`
      );
    }
  });

  const usage = response.data?.final_result?.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? 0;

  // Debug only, and metadata-only: chunk/query text is user document content
  // and must never be logged.
  logger.debug('Embedder', 'Embeddings request completed', {
    count: texts.length,
    promptTokens,
    totalTokens,
  });

  return { vectors, usage: { promptTokens, totalTokens } };
}
