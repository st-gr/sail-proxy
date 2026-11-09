/**
 * The gateway's own chat completions through SAP orchestration, for file_search's internal
 * calls (the query rewriter, the chunk context writer). One place for what every such call
 * needs:
 *
 * - deployment discovery (`configService.getDeploymentId`, the deployment embeddings and
 *   reranking reach) and `POST …/v2/completion`;
 * - the payload layout: the template carries ONLY the fixed instruction, as one system
 *   message; every caller-supplied text goes in `messages_history`, and so does every image
 *   (a base64 data-URL `image_url` part ahead of its message's text — the shape SAP
 *   orchestration accepts, measured live; responses/orchestrationBridge/requestTranslator.ts). SAP's templating parses
 *   `{{?name}}` placeholders in the template and nowhere else, so user or document text in
 *   the template could turn into a 400 (requestTranslator.ts `literalPlaceholderValues`).
 *   Template and history are disjoint, the shape the Responses bridge sends;
 * - the sampling parameters the model refuses are dropped (`dropUnsupportedSampling`);
 * - prompt-cache breakpoints when `resolvePromptCachingSupport` says the model takes them
 *   (Claude by default): `applyCacheBreakpoints` marks the system message and the message
 *   before the newest, so a caller that puts its large stable text (a document) first and
 *   the varying part last gets that prefix cached;
 * - a per-call timeout through an AbortSignal, linked to the caller's own signal;
 * - the reply's usage folded per model family (`fullRatePromptTokens`, usageFolding.ts).
 *
 * Throws `CompletionError` with a reason code (a reply cut off at the output limit is
 * `truncated`, not a result); the callers decide what a failure means (both are best-effort). Never logs prompt or reply text.
 */
import axios from 'axios';
import configService from '../services/configService';
import { dropUnsupportedSampling } from '../utils/samplingSupport';
import { resolvePromptCachingSupport } from '../utils/promptCachingSupport';
import { fullRatePromptTokens } from '../utils/usageFolding';
import { applyCacheBreakpoints } from '../responses/orchestrationBridge/cacheBreakpoints';
import type { SapV2CompletionRequest } from '../services/sapOrchestrationTypes';

/**
 * Token usage of one completion, split so the parts are disjoint and priced differently:
 *
 * - `input`: input tokens NOT read from a prompt cache — the uncached tail PLUS any tokens
 *   written to the cache on this call (`fs_jobs.context_input_tokens` counts exactly this);
 * - `cacheWrite`: the part of `input` that was written to the cache (a subset of `input`,
 *   billed at the cache-write rate; 0 for families that report no write);
 * - `cachedRead`: input tokens read from the cache (`fs_jobs.context_cached_tokens`);
 *   disjoint from `input`, so `input + cachedRead` is the whole prompt;
 * - `output`: completion tokens.
 *
 * How the family reports it (usageFolding.ts `cacheRegimeFor`): Claude and Nova report
 * `prompt_tokens` EXCLUSIVE of both cache counts; OpenAI-family and Gemini INCLUSIVE.
 */
export interface CompletionUsage {
  input: number;
  cacheWrite: number;
  cachedRead: number;
  output: number;
}

export const ZERO_USAGE: Readonly<CompletionUsage> = Object.freeze({ input: 0, cacheWrite: 0, cachedRead: 0, output: 0 });

export interface CompletionMessage {
  /** Default 'user'. */
  role?: 'user' | 'assistant';
  text: string;
  /** Images as base64 data URLs (`data:image/png;base64,…`; PNG, JPEG, WebP or GIF), sent as
   *  `image_url` parts before the text. A remote URL or any other data is refused. */
  images?: string[];
}

export interface CompletionRequest {
  /** The SAP orchestration model name. */
  model: string;
  /** The fixed instruction: the template's only message. */
  system: string;
  /** In order; put the stable, cacheable text first and the varying part last. */
  messages: CompletionMessage[];
  /** Model params (temperature, max_tokens, …); refused sampling keys are dropped. */
  params?: Record<string, any>;
}

export interface CompletionCall extends CompletionRequest {
  /** Abort the call after this long. */
  timeoutMs: number;
  /** The caller's own cancellation. */
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  usage: CompletionUsage;
  elapsedMs: number;
}

/** `truncated`: the reply stopped at the output limit (`finish_reason: 'length'`); its text is not used. */
export type CompletionFailure = 'no_deployment' | 'request_failed' | 'timeout' | 'aborted' | 'empty_response' | 'truncated';

export class CompletionError extends Error {
  constructor(
    readonly reason: CompletionFailure,
    message: string,
    readonly status?: number,
    /** What the call spent although it failed (an empty or truncated reply still bills its prompt). */
    readonly usage?: CompletionUsage,
  ) {
    super(message);
    this.name = 'CompletionError';
  }
}

/** The api_config provider key an orchestration model name belongs to ('' when unknown). */
function providerOf(model: string): string {
  const name = model.toLowerCase();
  if (name.startsWith('anthropic--')) return 'anthropic';
  if (name.startsWith('amazon--')) return 'aws-bedrock';
  if (name.startsWith('gemini')) return 'google';
  if (/^(?:gpt-|o[1-9])/.test(name)) return 'openai';
  return '';
}

/** Whether `model` gets cache breakpoints: config flags first, else Claude only. */
export function promptCachingFor(model: string): boolean {
  const provider = providerOf(model);
  return resolvePromptCachingSupport({
    provider,
    modelFlag: configService.getSupportsPromptCaching(undefined, model),
    providerFlag: provider ? configService.getSupportsPromptCaching(provider, undefined) : undefined,
  });
}

const textBlock = (text: string) => [{ type: 'text', text }];

/** A base64 data URL of an image format the models read. Remote URLs are never fetched here. */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** A message's content: its images (in order), then its text last — so a cache breakpoint, which
 *  marks a message's last block, always lands on text. */
function messageContent(m: CompletionMessage): any[] {
  if (!m.images || m.images.length === 0) return textBlock(m.text);
  const parts: any[] = m.images.map((url) => {
    if (typeof url !== 'string' || !IMAGE_DATA_URL.test(url)) {
      throw new CompletionError('request_failed', 'An image must be a base64 PNG, JPEG, WebP or GIF data URL');
    }
    return { type: 'image_url', image_url: { url } };
  });
  return [...parts, ...textBlock(m.text)];
}

/** The `/v2/completion` body for `req`. Pure: the caller's params are not mutated. Throws
 *  `CompletionError` ('request_failed') for an image that is not a base64 image data URL. */
export function buildCompletionPayload(req: CompletionRequest, opts: { caching: boolean }): SapV2CompletionRequest {
  const params: Record<string, any> = { ...(req.params ?? {}) };
  dropUnsupportedSampling(req.model, params);
  const payload: SapV2CompletionRequest = {
    config: {
      modules: {
        prompt_templating: {
          prompt: { template: [{ role: 'system', content: textBlock(req.system) }] },
          model: { name: req.model, params },
        },
      },
    },
    messages_history: req.messages.map((m) => ({ role: m.role ?? 'user', content: messageContent(m) })),
  };
  return applyCacheBreakpoints(payload, { enabled: opts.caching });
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** One orchestration usage object → the disjoint split of `CompletionUsage`, per family. */
export function foldCompletionUsage(model: string, usage: any): CompletionUsage {
  const prompt = count(usage?.prompt_tokens);
  const details = usage?.prompt_tokens_details;
  const cachedRead = count(details?.cached_tokens);
  const cacheWrite = count(details?.cache_creation_tokens);
  const fullRate = fullRatePromptTokens(model, prompt, cacheWrite, cachedRead);
  return { input: fullRate + cacheWrite, cacheWrite, cachedRead, output: count(usage?.completion_tokens) };
}

/** Run one completion. Resolves with the trimmed reply text; throws `CompletionError`. */
export async function orchestrationComplete(call: CompletionCall): Promise<CompletionResult> {
  if (call.signal?.aborted) throw new CompletionError('aborted', 'Completion aborted before it started');
  const deploymentId = await configService.getDeploymentId();
  if (!deploymentId) throw new CompletionError('no_deployment', 'No orchestration deployment found');

  const sapConfig = configService.getSAPAICoreConfig();
  const accessToken = await configService.getAccessToken();
  const url = `${sapConfig.url}/v2/inference/deployments/${deploymentId}/v2/completion`;
  const payload = buildCompletionPayload(call, { caching: promptCachingFor(call.model) });

  // The awaits above (discovery, token) leave a window in which the caller may have aborted.
  if (call.signal?.aborted) throw new CompletionError('aborted', 'Completion aborted before it was sent');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, call.timeoutMs);
  const onOuterAbort = () => controller.abort();
  call.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const started = Date.now();
  let data: any;
  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'AI-Resource-Group': sapConfig.resourceGroup || 'default',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    data = response?.data;
  } catch (error: any) {
    if (timedOut) throw new CompletionError('timeout', `Completion timed out after ${call.timeoutMs} ms`);
    if (call.signal?.aborted) throw new CompletionError('aborted', 'Completion aborted');
    throw new CompletionError('request_failed', error?.message ?? String(error), error?.response?.status);
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', onOuterAbort);
  }

  const elapsedMs = Date.now() - started;
  const usage = foldCompletionUsage(call.model, data?.final_result?.usage);
  const choice = data?.final_result?.choices?.[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason === 'length') {
    throw new CompletionError('truncated', 'Completion stopped at the output limit', undefined, usage);
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new CompletionError('empty_response', 'Completion returned no text', undefined, usage);
  }
  return { text: content.trim(), usage, elapsedMs };
}
