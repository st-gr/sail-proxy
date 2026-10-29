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
 *    correct). Inputs go out in sequential requests of at most
 *    `EMBED_BATCH_SIZE` (256, plan Decision 8) inputs and at most
 *    `EMBED_REQUEST_TOKEN_BUDGET` estimated tokens, so a large file no longer
 *    depends on one request finishing inside one timeout; there is no
 *    parallel fan-out. The token cap exists because SAP rejects a request over
 *    300,000 tokens (HTTP 400 "maximum request size is 300000 tokens", probed
 *    2026-10-07) and `estimateTokens` under-counts real chunks by about 1.8x
 *    (1,119 real vs 637 estimated on markdown), so 256 dense chunks overflow.
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
 *    requested value — the store's `embedding_dim` (verified working: returns
 *    vectors of exactly that length) — and MUST reject a response whose vector
 *    length disagrees with it; without the guard, every chunk insert against
 *    the fixed-width column fails. The model name is likewise the caller's
 *    (the store's `embedding_model`), never read from config here.
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
import { sapRequest, sapTiming, markResponseArrived, SapAttempt } from '../utils/sapRequest';
import { estimateTokens } from './chunker';

const logger = getDefaultLogger();

/** Upper bound on one `embed()` call across all of its sub-batch requests. It stays below
 *  the ingestion and re-embed lease (15 minutes, ingestWorker.ts), so a call that is still
 *  embedding can never outlive its claim and race a second worker that re-claimed the row. */
export const EMBED_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;

export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

/** One billed `/v2/embeddings` request: its usage and how long it took. */
export interface EmbeddingRequestUsage extends EmbeddingUsage {
  elapsedMs: number;
}

export interface EmbedResult<V = number[]> {
  vectors: V[];
  usage: EmbeddingUsage;
}

/** A document vector: float32, as pgvector stores it (`vector` is float4), half the memory of a
 *  JS number array. Converted per request, so one request's JSON numbers are the only doubles alive. */
export type DocumentVector = Float32Array;

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

/** The model and dimension a request embeds with. Callers that know the store pass the
 *  store's own `embedding_model` / `embedding_dim` (plan Decision 2: one model per store);
 *  a caller with no store passes `configuredEmbeddingTarget()` explicitly. */
export interface EmbedTarget {
  model: string;
  dimensions: number;
}

/** The configured model and dimension, for callers that embed for no particular store. */
export function configuredEmbeddingTarget(): EmbedTarget {
  const config = configService.getFileSearchConfig();
  return { model: config.embeddingModel, dimensions: config.embeddingDimensions };
}

/** Most inputs sent in one `/v2/embeddings` request (plan Decision 8). A large file is
 *  embedded as several requests, each with its own timeout, instead of one request that
 *  has to finish inside a single 30 s window. */
export const EMBED_BATCH_SIZE = 256;

/** Most estimated tokens in one request, after scaling by `EMBED_TOKEN_ESTIMATE_FACTOR`.
 *  SAP's own cap is 300,000 tokens; this leaves headroom for the estimate's error. */
export const EMBED_REQUEST_TOKEN_BUDGET = 250000;

/** `estimateTokens` under-counts real chunks by about 1.76x (measured 2026-10-07); the
 *  budget is checked against the estimate times this factor. */
export const EMBED_TOKEN_ESTIMATE_FACTOR = 1.8;

/** Split the inputs into consecutive requests, each closing at `EMBED_BATCH_SIZE` inputs
 *  or before its scaled token estimate would pass `EMBED_REQUEST_TOKEN_BUDGET`. An input
 *  over the budget on its own gets a request to itself: it is never dropped, SAP decides. */
function planRequests(texts: string[]): Array<{ start: number; end: number }> {
  const requests: Array<{ start: number; end: number }> = [];
  let start = 0;
  let tokens = 0;
  texts.forEach((text, i) => {
    const scaled = estimateTokens(text) * EMBED_TOKEN_ESTIMATE_FACTOR;
    if (i > start && (i - start >= EMBED_BATCH_SIZE || tokens + scaled > EMBED_REQUEST_TOKEN_BUDGET)) {
      requests.push({ start, end: i });
      start = i;
      tokens = 0;
    }
    tokens += scaled;
  });
  requests.push({ start, end: texts.length });
  return requests;
}

/**
 * Thrown when the orchestration does not serve the requested embedding model — a store
 * pinned to a model that has since been retired. Recognised only from the tenant's own
 * answer, probed live 2026-10-06: HTTP 400 with
 *   "400 - Embedding Module: Model name '<model>' is not supported. Model name must be one of: …"
 * and only when the quoted name is the model this request asked for. Every other failure
 * (another 400, a 5xx, a timeout) is rethrown unchanged.
 */
export class EmbeddingModelUnavailableError extends Error {
  constructor(readonly model: string) {
    super(`The embedding model '${model}' is not served by the SAP AI Core orchestration deployment`);
    this.name = 'EmbeddingModelUnavailableError';
  }
}

/**
 * Thrown when the sub-batches of one `embed()` call together took longer than
 * `EMBED_TOTAL_TIMEOUT_MS`, or ran past the caller's `deadline`. Transient: a
 * later attempt may well be faster.
 */
export class EmbeddingDeadlineExceededError extends Error {
  constructor(readonly elapsedMs: number, readonly completedInputs: number, readonly totalInputs: number) {
    super(`Embedding ${totalInputs} inputs exceeded the time limit `
      + `after ${completedInputs} of them (${elapsedMs} ms)`);
    this.name = 'EmbeddingDeadlineExceededError';
  }
}

function isModelNotServed(status: unknown, body: any, model: string): boolean {
  if (status !== 400) return false;
  const message = body?.error?.message;
  return typeof message === 'string' && message.includes(`Model name '${model}' is not supported`);
}

/**
 * Embed texts through SAP AI Core orchestration, in requests of at most `EMBED_BATCH_SIZE`
 * inputs and `EMBED_REQUEST_TOKEN_BUDGET` estimated tokens.
 * The requests run one after another; the vectors come back in input order and the
 * usage is summed over all requests.
 *
 * @param texts - chunk or query text; embedded raw (never masked — masking either
 *   side would put corpus and query into different vector spaces).
 * @param inputType - 'document' for ingestion, 'query' for search. Documents
 *   call-site intent only: the orchestration `/v2/embeddings` schema rejects
 *   `input.input_type` with HTTP 400, so this is deliberately NOT sent on the
 *   wire. Do not add it to the payload below.
 * @param target - the model and dimension to embed with; every vector is checked
 *   against `target.dimensions`.
 * @param options.deadline - an absolute time (`Date.now()` scale) the call must not
 *   run past, when it is earlier than the call's own `EMBED_TOTAL_TIMEOUT_MS`: a
 *   caller that embeds several times inside one lease shares one deadline.
 * @param options.onUsage - called after each successful request with that request's own
 *   usage, so every billed request is recorded even when a later one fails. A hook that
 *   throws is logged and ignored; it never fails the embedding.
 */
export async function embed(
  texts: string[], inputType: 'document', target: EmbedTarget, options?: EmbedOptions,
): Promise<EmbedResult<DocumentVector>>;
export async function embed(
  texts: string[], inputType: 'query', target: EmbedTarget, options?: EmbedOptions,
): Promise<EmbedResult<number[]>>;
export async function embed(
  texts: string[],
  inputType: 'document' | 'query',
  target: EmbedTarget,
  options: EmbedOptions = {},
): Promise<EmbedResult<DocumentVector> | EmbedResult<number[]>> {
  // inputType is not sent on the wire (see above); it only picks the vectors' type: documents
  // as float32 (stored as float4), queries as the numbers SAP returned (unchanged search input).
  const float32 = inputType === 'document';

  if (texts.length === 0) {
    return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
  }

  const sapConfig = configService.getSAPAICoreConfig();
  const [accessToken, deploymentId] = await Promise.all([
    configService.getAccessToken(),
    configService.getDeploymentId(),
  ]);

  if (!deploymentId) {
    throw new Error('No SAP AI Core orchestration deployment available for embeddings');
  }

  const url = `${sapConfig.url}/v2/inference/deployments/${deploymentId}/v2/embeddings`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'AI-Resource-Group': sapConfig.resourceGroup || 'default',
    'Content-Type': 'application/json',
  };

  const vectors: Array<number[] | DocumentVector> = [];
  let promptTokens = 0;
  let totalTokens = 0;
  const startedAt = Date.now();
  const endsAt = Math.min(startedAt + EMBED_TOTAL_TIMEOUT_MS, options.deadline ?? Infinity);
  // A query is one short input and a search waits on it; a document batch is up to 256 inputs.
  const attemptTimeoutMs = float32 ? sapTiming().documentEmbeddingAttemptMs : sapTiming().queryEmbeddingAttemptMs;
  const requests = planRequests(texts);
  for (const { start: offset, end } of requests) {
    // The whole call is bounded, not only each request: each attempt gets at most
    // the time that is left, none starts once the budget is spent, and a retry only
    // when a full attempt still fits (sapRequest).
    if (endsAt - Date.now() <= 0) {
      throw new EmbeddingDeadlineExceededError(Date.now() - startedAt, offset, texts.length);
    }
    const requestStartedAt = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const part = await embedOneRequest(url, headers, texts.slice(offset, end), target, offset, {
      attemptTimeoutMs, deadline: endsAt,
    });
    if (options.onUsage) {
      try {
        options.onUsage({ ...part.usage, elapsedMs: Date.now() - requestStartedAt });
      } catch (hookError: any) {
        logger.warn('Embedder', `Embedding usage hook failed: ${hookError?.message ?? hookError}`);
      }
    }
    for (const vector of part.vectors) vectors.push(float32 ? Float32Array.from(vector) : vector);
    promptTokens += part.usage.promptTokens;
    totalTokens += part.usage.totalTokens;
  }

  // Debug only, and metadata-only: chunk/query text is user document content
  // and must never be logged.
  logger.debug('Embedder', 'Embeddings request completed', {
    count: texts.length,
    requests: requests.length,
    promptTokens,
    totalTokens,
  });

  return { vectors, usage: { promptTokens, totalTokens } } as EmbedResult<DocumentVector> | EmbedResult<number[]>;
}

export interface EmbedOptions { deadline?: number; onUsage?: (u: EmbeddingRequestUsage) => void }

/** One `/v2/embeddings` request. `offset` is the position of `texts[0]` in the caller's
 *  whole input, so an error names the input's real index. */
async function embedOneRequest(
  url: string,
  headers: Record<string, string>,
  texts: string[],
  target: EmbedTarget,
  offset: number,
  budget: { attemptTimeoutMs: number; deadline: number },
): Promise<EmbedResult> {
  const payload = {
    input: { text: texts },
    config: {
      modules: {
        embeddings: {
          model: {
            name: target.model,
            params: { dimensions: target.dimensions },
          },
        },
      },
    },
  };

  let response;
  try {
    // One retry on a stall, reset or 502/503/504: an embedding has no side effect and the
    // same input gives the same vectors. Never once the answer has arrived (postEmbeddings).
    response = await sapRequest(
      { kind: 'embeddings', attemptTimeoutMs: budget.attemptTimeoutMs, retry: true, deadline: budget.deadline },
      (attempt) => postEmbeddings(url, payload, headers, attempt),
    );
  } catch (error: any) {
    // Never JSON.stringify an axios error: error.response.data can be a
    // circular IncomingMessage stream on the error path.
    const upstreamBody = await readUpstreamErrorBody(error?.response);
    if (isModelNotServed(error?.response?.status, upstreamBody, target.model)) {
      // An expected condition with a known remedy (re-embed the store), not a fault
      // of this service: a warning, not an error.
      logger.warn('Embedder', `The embedding model '${target.model}' is not served by the orchestration`, {
        status: error?.response?.status,
      });
      throw new EmbeddingModelUnavailableError(target.model);
    }
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

  const expectedDim = target.dimensions;
  vectors.forEach((vector, idx) => {
    if (!Array.isArray(vector) || vector.length !== expectedDim) {
      throw new Error(
        `Embedding at index ${offset + idx} has dimension ${vector?.length ?? 0}, expected ${expectedDim} ` +
        `(the requested dimensions) — refusing to insert a vector that would ` +
        `silently corrupt the pinned vector(${expectedDim}) column`
      );
    }
  });

  const usage = response.data?.final_result?.usage;
  return {
    vectors,
    usage: { promptTokens: usage?.prompt_tokens ?? 0, totalTokens: usage?.total_tokens ?? 0 },
  };
}

/**
 * One `/v2/embeddings` POST. The body is read as a stream so that the moment SAP's answer
 * arrives is known: SAP has billed the request by then, so a failure from here on (a body that
 * stalls past the attempt's time, a body that is not JSON) is marked as arrived and never
 * re-sent, even though it is a timeout or a reset.
 */
async function postEmbeddings(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  { timeoutMs, signal }: SapAttempt,
): Promise<{ data: SapEmbeddingResponse }> {
  const response = await axios.post(url, payload, { headers, timeout: timeoutMs, signal, responseType: 'stream' });
  try {
    return { data: await readJsonBody(response.data, signal, timeoutMs) };
  } catch (error) {
    throw markResponseArrived(error);
  }
}

/**
 * Reads a JSON response body until it ends, the stream fails or `signal` aborts. Once the
 * attempt's time is up, whichever error ends the read (axios may cancel the stream first) is
 * reported as the timeout.
 */
function readJsonBody(body: any, signal: AbortSignal, timeoutMs: number): Promise<SapEmbeddingResponse> {
  if (!body || typeof body.on !== 'function') return Promise.resolve(body);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let ended = false;
    const fail = (error: Error) => {
      signal.removeEventListener('abort', onAbort);
      body.on('error', () => undefined);
      body.destroy?.();
      reject(signal.aborted ? Object.assign(
        new Error(`The embeddings response did not finish within the request time limit of ${timeoutMs} ms`),
        { code: 'ETIMEDOUT' },
      ) : error);
    };
    const onAbort = () => fail(new Error('aborted'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    body.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    body.on('error', (error: Error) => fail(error));
    body.on('close', () => { if (!ended) fail(new Error('The embeddings response closed before it ended')); });
    body.on('end', () => {
      ended = true;
      signal.removeEventListener('abort', onAbort);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error: any) {
        reject(new Error(`The embeddings response is not JSON: ${error.message}`));
      }
    });
  });
}
