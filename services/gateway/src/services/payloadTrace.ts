/**
 * The light payload trace: one per inference request while payload capture is on, and one with the
 * facts only for a request of a raw capture session while it is off; published to the
 * `payload-traces` Valkey stream for the admin service to ingest.
 *
 * Content rules: masked text (the pseudonymization plugin's own output) may travel in the clear; an
 * unmasked prompt travels only sealed with the key derived from METADATA_ENCRYPTION_KEY, and its answer
 * is never captured. A request masked by anonymization keeps its masked prompt; its answer is not
 * captured either, because the plugin does not hold it in masked form.
 */
import { Request } from 'express';
import { sealText } from '@libs/trace-seal';
import { redactUrl } from '../utils/redactUrl';
import { warnOnceIfSealKeyWeak } from '../utils/sealKeyWarning';
import { capBytes, promptOf, payloadCaptureOn, DEFAULT_CONTENT_MAX_BYTES } from './siemUsageEvent';
import { getStreamCapture } from './siemStreamCapture';
import securityEventEmitter from './securityEventEmitter';

export interface PayloadTraceMessage {
  v: 1;
  requestId: string;
  capturedAt: string;
  endpoint: string;
  model: string;
  authType?: string;
  credentialId?: string;
  statusCode: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  masked: boolean;
  truncated: boolean;
  omitted?: 'not-captured' | 'stream-incomplete';
  /** Masked requests only. */
  prompt?: string;
  /** Masked requests only. */
  answer?: string;
  /** Requests that were not masked only: the prompt, sealed. */
  sealedPrompt?: string;
  /** The request was part of a raw capture session. */
  raw: boolean;
}

export interface PayloadTraceContext {
  model: string;
  statusCode: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** The caller's credential, when the usage tracker resolved one. */
  credentialId?: string;
  authType?: string;
}

/** The facts of a request, without any content. */
function factsOf(r: any, ctx: PayloadTraceContext): Omit<PayloadTraceMessage, 'masked' | 'truncated'> {
  return {
    v: 1,
    requestId: typeof r.debugRequestId === 'string' ? r.debugRequestId : 'unknown',
    capturedAt: new Date().toISOString(),
    endpoint: redactUrl(r.originalUrl || r.url || '').split('?')[0],
    model: ctx.model,
    authType: ctx.authType,
    credentialId: ctx.credentialId,
    statusCode: ctx.statusCode,
    durationMs: ctx.durationMs,
    inputTokens: ctx.inputTokens,
    outputTokens: ctx.outputTokens,
    raw: Boolean(r.__rawCaptureSessionId),
  };
}

/**
 * The trace of a finished request, or null when capture is off here and the request is in no raw
 * capture session. With capture off, a request of a raw session gets its facts only (no prompt,
 * answer or sealed prompt): the light trace outlives the raw stages, and the operator has not
 * switched content capture on. Never reads configuration beyond memory.
 */
export function buildPayloadTrace(req: Request, ctx: PayloadTraceContext, env: NodeJS.ProcessEnv): PayloadTraceMessage | null {
  const r: any = req;
  if (!payloadCaptureOn()) {
    if (!r.__rawCaptureSessionId) return null;
    const masked = Array.isArray(r.__pseudonymization?.maskedInputs);
    return { ...factsOf(r, ctx), masked, truncated: false, omitted: 'not-captured' };
  }

  const prompt = promptOf(req);
  const cappedPrompt = capBytes(prompt.text, DEFAULT_CONTENT_MAX_BYTES);

  const message: PayloadTraceMessage = {
    ...factsOf(r, ctx),
    masked: prompt.masked,
    truncated: cappedPrompt.truncated,
  };

  if (!prompt.masked) {
    // Outside a raw session an unmasked request keeps its prompt sealed and no answer.
    if (cappedPrompt.text) {
      warnOnceIfSealKeyWeak(env);
      message.sealedPrompt = sealText(cappedPrompt.text, env);
    }
    message.omitted = 'not-captured';
    return message;
  }

  if (cappedPrompt.text) message.prompt = cappedPrompt.text;

  const captured = r.__siemMaskedResponse;
  if (r.__pseudonymization?.config?.method !== 'anonymization' && typeof captured === 'string') {
    const answer = capBytes(captured, DEFAULT_CONTENT_MAX_BYTES);
    message.answer = answer.text;
    message.truncated = message.truncated || answer.truncated || r.__siemMaskedResponseTruncated === true;
  } else {
    message.omitted = r.__siemStreamIncomplete === true ? 'stream-incomplete' : 'not-captured';
  }
  return message;
}

/**
 * Publishes the request's light trace. Never throws and never waits for Valkey: it waits only for a
 * streamed answer to finish (like the SIEM usage event, it is dispatched with `void` from the usage
 * tracker), then hands the message to the emitter, which does not await the XADD.
 */
export async function emitPayloadTrace(req: Request, ctx: PayloadTraceContext): Promise<void> {
  try {
    if (!payloadCaptureOn() && !(req as any).__rawCaptureSessionId) return;
    const capture = getStreamCapture(req);
    if (capture) await capture.settled();

    const message = buildPayloadTrace(req, ctx, process.env);
    if (!message) return;
    securityEventEmitter.publishPayloadTrace(JSON.stringify(message));
  } catch {
    // Never a log line per request: counted with the publish drops, reported once a minute.
    securityEventEmitter.countDroppedPayloadTrace();
  }
}
