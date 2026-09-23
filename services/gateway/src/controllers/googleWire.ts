/**
 * The wire conventions of the `/google` route — the things both
 * googleController.ts and googleDispatch.ts have to agree on, byte for byte,
 * and which neither of them owns alone:
 *
 *  - what a Gemini client is SHOWN when something fails (spec section 5.9),
 *  - how a streamed turn is framed and torn down (spec section 5.7),
 *  - how SAP's orchestration counts are FOLDED into the usage metrics
 *    (spec section 5.8).
 *
 * Split out of the controller/dispatch pair purely so those two stay readable;
 * nothing here decides anything about a request.
 */
import { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import { executeAfterPlugins } from '../services/pluginExecutor';
import { foldExclusiveUsage, foldInclusiveUsage } from '../utils/usageFolding';
import { readUpstreamErrorBody } from '../utils/upstreamErrorBody';
import { parseFrame, sseBlock } from '../utils/sseFraming';
import { geminiError, usageFromGemini } from '../services/googleGeminiService';
import { mapCachedTokens } from '../responses/orchestrationBridge/cacheBreakpoints';
import { UnsupportedGeminiInputError } from '../google/orchestrationBridge/requestTranslator';

const logger = getDefaultLogger();

/** A refusal in the Gemini envelope: `{error:{code,message,status}}`, never the OpenAI one. */
export function refuse(res: Response, status: number, message: string): void {
  res.status(status).json(geminiError(status, message));
}

/** The `message` a client is shown for an upstream body, whatever shape it arrived in. */
function upstreamMessage(body: any): string | null {
  if (!body) return null;
  if (typeof body === 'string') return body;
  if (typeof body.error?.message === 'string') return body.error.message;
  // SAP's inference proxy: `{"error":"BadRequest","message":"Subpath ... is not allowed ..."}`.
  if (typeof body.message === 'string') return body.message;
  if (typeof body.error === 'string') return body.error;
  return null;
}

/** A transport failure (no HTTP response at all) rather than a bug in this process. */
function isTransportError(error: any): boolean {
  return typeof error?.code === 'string' || error?.isAxiosError === true;
}

/**
 * Any failure → the status and message a Gemini client is shown (spec 5.9):
 * a translator refusal is 400 INVALID_ARGUMENT naming the offending item, an
 * upstream JSON error is relayed with its own status (SAP's "Subpath ... is not
 * allowed" already IS a 400), and a transport failure is 502.
 */
export async function geminiFailure(error: any): Promise<{ status: number; message: string }> {
  if (error instanceof UnsupportedGeminiInputError) return { status: 400, message: error.message };
  const upstream = error?.response;
  const status = upstream?.status || error?.status || (isTransportError(error) ? 502 : 500);
  // Streaming requests use responseType:'stream', so on an error status axios
  // hands back a live IncomingMessage; draining it first is what keeps a
  // circular object out of JSON.stringify.
  const body = upstream ? await readUpstreamErrorBody(upstream) : error?.details;
  return { status, message: upstreamMessage(body) || error?.message || 'request failed' };
}

/**
 * The four headers a Gemini client's SSE reader needs. `X-Accel-Buffering` is
 * the one that is not obvious: nginx and Istio buffer a proxied response by
 * default, which turns a token-by-token stream into one delivery at the end.
 */
export function openSseStream(res: Response): void {
  if (res.headersSent) return;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

/**
 * Run `onAbandoned` when the client goes away mid-stream.
 *
 * Only `res` is listened to, deliberately. Measured on this stack (see
 * `forwardStream` in responsesController.ts): `req` is destroyed within ~5ms of
 * route entry on EVERY request, so a `req.on('close')` handler would abort a
 * turn that is proceeding normally. `writableEnded` is load-bearing for the same
 * reason in the other direction: res 'close' also fires on normal completion.
 */
export function onClientClose(res: Response, onAbandoned: () => void): void {
  if (typeof (res as any).on !== 'function') return;
  res.on('close', () => { if (!res.writableEnded) onAbandoned(); });
}

/**
 * One translated frame through the after-plugin chain, then back to SSE text.
 *
 * This is how plugins reach a streamed Gemini turn on the bridge: they are handed
 * the FRAME — a whole `GenerateContentResponse` — which is the shape the
 * pseudonymization plugin's `unmaskGeminiOutput` site understands. The raw
 * orchestration chunks are never shown to them (`streamChatCompletion` is called
 * WITHOUT a hookConfig, for the reason responsesController.ts records at length:
 * an `after` handler written against a response object cannot read
 * `{final_result:{choices:[{delta}]}}`).
 *
 * A plugin that throws must not take the stream down with it — the frame goes out
 * as it stood.
 */
export async function pluginFrame(req: Request, res: Response, hookConfig: any, block: string): Promise<string> {
  const frame = parseFrame(block);
  if (!frame) return block;
  try {
    const out = await executeAfterPlugins(req, res, frame, hookConfig);
    return out === undefined ? block : sseBlock(out);
  } catch (error: any) {
    logger.error('googleController', `after-plugin failed on a Gemini stream frame: ${error?.message || error}`);
    return block;
  }
}

/**
 * SAP orchestration `usage` → the usage metrics.
 *
 * EXCLUSIVE: `prompt_tokens` is full-rate input as-is and BOTH cache counters are
 * separate line items ADDED alongside it, with no subtraction — the regime measured
 * for this payload shape and recorded at length on `recordOrchestrationUsage` in
 * responsesController.ts, which this mirrors field for field. `foldExclusiveUsage`
 * is the marker that says so; going through it rather than calling
 * `updateTokenCounts` directly is what keeps the two orchestration folds from
 * drifting apart.
 *
 * Spec section 5.8 writes the call as `updateTokenCounts(metrics, input, output, 0,
 * cacheRead)`. That literal 0 was a defect, not a ruling: SAP reports
 * `prompt_tokens_details.cache_creation_tokens` on this route too, and admin's cost
 * SQL prices cache-write as its own line item, so passing 0 under-billed every
 * cached bridge turn.
 */
export function foldOrchestrationUsage(metrics: any, usage: any): void {
  if (!usage) return;
  foldExclusiveUsage(
    metrics,
    usage.prompt_tokens ?? 0,
    usage.completion_tokens ?? 0,
    // Cache WRITE. Priced separately by admin's cost SQL and — like the read count —
    // reported by SAP ALONGSIDE `prompt_tokens`, never inside it.
    usage.prompt_tokens_details?.cache_creation_tokens ?? 0,
    mapCachedTokens(usage).cachedTokens,
  );
}

/**
 * A native Gemini `usageMetadata` → the usage metrics.
 *
 * INCLUSIVE, and the opposite of `foldOrchestrationUsage` above. Google's API
 * reference is explicit about `promptTokenCount`: "Number of tokens in the prompt.
 * When `cachedContent` is set, this is still the total effective prompt size meaning
 * this includes the number of tokens in the cached content."
 * (ai.google.dev/api/generate-content, GenerateContentResponse.UsageMetadata.)
 *
 * Admin's cost SQL prices the four categories separately and ADDS them, so folding
 * `promptTokenCount` raw as full-rate input while ALSO recording
 * `cachedContentTokenCount` as cache-read billed the cached prefix twice — once at
 * the full input rate and once at the cache-read rate. `foldInclusiveUsage`
 * subtracts it out of the full-rate figure, which is what that helper exists for.
 *
 * Gemini reports no cache-WRITE count of its own (a Gemini context cache is created
 * by a separate `cachedContents` call this route does not serve), hence the 0.
 */
export function foldNativeGeminiUsage(metrics: any, usageMetadata: any): void {
  const counted = usageFromGemini(usageMetadata);
  foldInclusiveUsage(metrics, counted.inputTokens, counted.outputTokens, 0, counted.cacheReadTokens);
  // The modality split rides beside the inclusive totals: image input is what the
  // admin already prices at the image rate, image output is priced at its own rate.
  metrics.imageInputTokens = (metrics.imageInputTokens || 0) + counted.imageInputTokens;
  metrics.imageOutputTokens = (metrics.imageOutputTokens || 0) + counted.imageOutputTokens;
}
