/**
 * The `usage`-category SIEM event: one per completed request, carrying model, endpoint,
 * status, request id and — only when an operator has asked for it — the conversation
 * content in its masked form.
 *
 * This is where the two content gates are enforced for the FIRST of two times. The second
 * is the admin dispatcher, which strips per sink copy at send (services/admin/src/siem/
 * dispatcher.ts). Enforcing here as well is the ruling this feature was built under:
 * `credential_material` is carried through the durable outbox and stripped at send, but a
 * credential hint is small and a conversation is not. Content that no enabled sink asked
 * for must never be written to Postgres at all, so:
 *
 *   - content is attached only when at least one ENABLED sink has `include_content: true`;
 *   - UNMASKED content is attached only when at least one enabled sink has BOTH
 *     `include_content` and `allow_unmasked_content`.
 *
 * "At least one enabled sink" is read from the same `api_config.observability.siem` block the admin
 * dispatcher builds its sinks from, resolved per request through configService so a
 * configuration change applies on the next request without a restart. A sink is "enabled"
 * here by exactly the test the dispatcher uses: its own `enabled` is true (the master
 * `siem.enabled` is checked separately, first).
 *
 * The two halves read the same configuration but not at the same instant, and that is
 * deliberate rather than a race to be closed: an event is written with whatever content the
 * configuration in force AT EMISSION allowed. A sink enabled, or opted into content, after
 * an event was already in the outbox therefore receives that event WITHOUT content — the
 * text was never captured and there is nowhere to recover it from. That is the correct
 * direction to fail. The opposite (retroactively enriching stored events when a flag is
 * flipped) would mean the flag governs disclosure of conversations recorded before anyone
 * consented to record them.
 */

import { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import configService, { getTrustForwardedFor } from './configService';
import securityEventEmitter from './securityEventEmitter';
import { getStreamCapture, installStreamCapture } from './siemStreamCapture';
import { getClientIp } from '../utils/clientIp';
import { SiemUsageEvent, SiemUsageContent, SiemUsagePseudonymization } from '../types/security';

const logger = getDefaultLogger();

/** The `siem.content_max_bytes` default, matching the shipped api_config.json. */
export const DEFAULT_CONTENT_MAX_BYTES = 8192;

export const USAGE_EVENT_TYPE = 'request_completed';

/** What the configuration in force right now permits this request to carry. */
export interface ContentGates {
  /** SIEM export is on AND `usage` is among the exported categories. */
  emit: boolean;
  /** Some enabled sink has `include_content`. */
  includeContent: boolean;
  /** Some enabled sink has `include_content` AND `allow_unmasked_content`. */
  allowUnmasked: boolean;
  /** `siem.content_max_bytes`, per field, in bytes. */
  maxBytes: number;
}

const NO_EMIT: ContentGates = { emit: false, includeContent: false, allowUnmasked: false, maxBytes: 0 };

/**
 * Reads the gates out of a parsed `siem` block. Pure, so the decision table is testable
 * without a configService or a request.
 *
 * `categories` mirrors the admin ingest default (securityEventSubscriber.ts): unset or empty
 * means every category. But note the shipped api_config.json sets it to
 * ["security", "audit"] explicitly, so exporting usage events is an opt-in — an operator
 * adds "usage" to that list. Without it nothing is emitted at all, and the per-request cost
 * of this whole path is one property read.
 */
export function resolveContentGates(siem: any): ContentGates {
  if (!siem || siem.enabled !== true) return NO_EMIT;

  const categories = Array.isArray(siem.categories) && siem.categories.length > 0
    ? siem.categories
    : ['security', 'audit', 'usage'];
  if (!categories.includes('usage')) return NO_EMIT;

  const sinks: any[] = Array.isArray(siem.sinks) ? siem.sinks : [];
  const enabled = sinks.filter(s => s?.enabled === true);
  const includeContent = enabled.some(s => s.include_content === true);
  const allowUnmasked = enabled.some(s => s.include_content === true && s.allow_unmasked_content === true);

  const configured = siem.content_max_bytes;
  const maxBytes = typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_CONTENT_MAX_BYTES;

  return { emit: true, includeContent, allowUnmasked, maxBytes };
}

/**
 * Cuts a string to at most `maxBytes` UTF-8 bytes. Counted in bytes, not characters,
 * because the cap exists to bound what is written to Postgres and pushed to a sink, and a
 * character-count cap bounds neither for non-ASCII text.
 */
function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  // A cut inside a multi-byte sequence decodes to U+FFFD rather than to half a character;
  // the alternative (walking back to a code-point boundary) buys nothing here, since the
  // value is human-read diagnostic text, never re-parsed.
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/** Every string in a message's `content`, whether it is a plain string or a block array. */
function textOfMessage(message: any): string[] {
  if (typeof message?.content === 'string') return [message.content];
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text);
}

/**
 * The request's prompt as text.
 *
 * When the pseudonymization plugin ran, its own `maskedInputs` is the answer: those are
 * exactly the strings it produced after masking, so what is captured here is the pipeline's
 * output rather than a second, independent reading of it. (It also excludes the
 * placeholder-handling instruction the plugin appends to `system`, which is the gateway
 * talking to the model, not conversation content.)
 *
 * With no pseudonymization state there was no masking, and the text is read from the body
 * as it stands — raw. It is marked `masked: false` and gated accordingly; this function
 * never guesses that untouched text is safe because it happens to contain no PII.
 */
function promptOf(req: Request): { text: string; masked: boolean } {
  const state = (req as any).__pseudonymization;
  if (state && Array.isArray(state.maskedInputs)) {
    return { text: state.maskedInputs.join('\n'), masked: true };
  }

  const body: any = (req as any).body ?? {};
  const parts: string[] = [];
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) parts.push(...textOfMessage(message));
  }
  if (typeof body.input === 'string') parts.push(body.input);
  if (Array.isArray(body.input)) {
    for (const item of body.input) parts.push(...textOfMessage(item));
  }
  return { text: parts.join('\n'), masked: false };
}

/**
 * The response half as it reached this point. `truncated` is what the STREAMING capture
 * already knows — it stops retaining chunks once the cap is passed, so the string handed
 * here can be short of what the model actually produced even before `capBytes` sees it.
 */
export interface CapturedResponse {
  text: string;
  truncated: boolean;
}

/**
 * Builds the content block, or returns undefined when nothing may be attached.
 *
 * Returning `{ omitted: 'not-masked' }` rather than undefined matters: a sink that asked for
 * content and receives an event with none should be able to tell "this request had no
 * content" from "this request had content that masking never touched, so it was withheld".
 *
 * `streamIncomplete` is the same idea for the third case a streamed request adds: the stream
 * errored, or the client hung up, so there IS no whole response and none is invented. The
 * prompt still ships (it was whole before the first byte came back) and
 * `omitted: 'stream-incomplete'` says why the response is not beside it.
 */
export function buildContent(
  prompt: { text: string; masked: boolean },
  response: CapturedResponse | undefined,
  gates: ContentGates,
  streamIncomplete = false,
): SiemUsageContent | undefined {
  if (!gates.includeContent) return undefined;
  if (!prompt.masked && !gates.allowUnmasked) return { omitted: 'not-masked' };
  if (!prompt.text && !response) return undefined;

  const cappedPrompt = capBytes(prompt.text, gates.maxBytes);
  const cappedResponse = response === undefined
    ? undefined
    : capBytes(response.text, gates.maxBytes);

  const content: SiemUsageContent = {
    prompt: cappedPrompt.text || undefined,
    response: cappedResponse?.text || undefined,
    truncated: cappedPrompt.truncated
      || cappedResponse?.truncated === true
      || response?.truncated === true,
    masked: prompt.masked,
  };
  if (streamIncomplete && content.response === undefined) {
    content.omitted = 'stream-incomplete';
  }
  return content;
}

/**
 * The saturation report the pseudonymization plugin left on the request, if it ran.
 *
 * Read from request-scoped state the same way `__siemMaskedResponse` is, and gated by
 * `gates.emit` alone — NOT by the content gates. The block is counts, never text: an
 * operator exporting usage events but no content still needs to see that a request masked
 * two hundred values, and that is exactly the case the content gates exist to withhold text
 * from. Shape-checked rather than trusted, so a partially-written state object cannot put a
 * malformed block on the wire.
 */
function pseudonymizationOf(req: Request): SiemUsagePseudonymization | undefined {
  const report = (req as any).__pseudonymizationSaturation;
  if (!report || typeof report.masked_values !== 'number' || typeof report.saturated !== 'boolean') {
    return undefined;
  }
  return {
    masked_values: report.masked_values,
    categories: report.categories && typeof report.categories === 'object' ? report.categories : {},
    saturated: report.saturated,
  };
}

export interface UsageEventContext {
  model: string;
  statusCode: number;
  requestId?: string;
  credentialId?: string;
  authType?: string;
  endpoint?: string;
  /**
   * Resolved by emitSiemUsageEvent from the request, using the same trust_forwarded_for
   * setting the rest of the gateway honours. Overridable so buildUsageEvent stays testable
   * without a configuration.
   */
  clientIP?: string;
}

/**
 * Assembles the event a completed request should publish, or null when the configuration
 * says to publish nothing. Separated from the emit below so the gate decisions are testable
 * without a Valkey client.
 */
export function buildUsageEvent(
  req: Request,
  context: UsageEventContext,
  gates: ContentGates,
): SiemUsageEvent | null {
  if (!gates.emit) return null;

  const prompt = promptOf(req);
  // Set by the pseudonymization plugin's after-handler, from the response text as it stood
  // BEFORE unmasking — the masked form, matching the prompt. For a STREAMED response the
  // same property is written by services/siemStreamCapture.ts at end of stream, from the
  // deltas accumulated in memory as they passed the same handler; either way what is read
  // here is one masked string and this function cannot tell which path produced it.
  const captured = (req as any).__siemMaskedResponse;
  const response: CapturedResponse | undefined = typeof captured === 'string'
    ? { text: captured, truncated: (req as any).__siemMaskedResponseTruncated === true }
    : undefined;

  return {
    eventId: '',                       // filled by the emitter, like every other event
    category: 'usage',
    eventType: USAGE_EVENT_TYPE,
    severity: 'low',
    timestamp: new Date().toISOString(),
    credentialId: context.credentialId,
    authType: context.authType,
    clientIP: context.clientIP,
    userAgent: typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    endpoint: context.endpoint,
    requestId: context.requestId,
    statusCode: context.statusCode,
    model: context.model,
    source: 'gateway',
    content: buildContent(prompt, response, gates, (req as any).__siemStreamIncomplete === true),
    pseudonymization: pseudonymizationOf(req),
  };
}

/**
 * Starts accumulating a streamed response's masked text, but only when the configuration in
 * force right now says a sink will actually receive it.
 *
 * Called from the pseudonymization plugin's before handler, which is where a streamed
 * response's masked deltas are visible. The three conditions are all cheap and all
 * necessary:
 *
 *   - `stream: true` on the body — a non-streaming response is already captured whole by the
 *     after handler, and installing a capture for it would buy nothing;
 *   - a real `res` to hang the lifecycle listeners on;
 *   - `resolveContentGates(...).includeContent` — the point of this check. A gateway whose
 *     sinks are not opted into content allocates NOTHING per request: no capture object, no
 *     array, and `appendStreamContent` on the per-chunk path degrades to one property read.
 *
 * Never throws: a SIEM export problem must not change the outcome of a request.
 */
export function beginStreamContentCapture(req: Request, res: Response | undefined): void {
  try {
    if (!res) return;
    if ((req as any).body?.stream !== true) return;

    let siem: any;
    try {
      siem = configService.getConfig()?.api_config?.observability?.siem;
    } catch {
      return;
    }

    const gates = resolveContentGates(siem);
    if (!gates.emit || !gates.includeContent) return;

    installStreamCapture(req, res, gates.maxBytes);
  } catch (error) {
    logger.warn('SiemUsageEvent', 'Failed to start streamed content capture', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Fire-and-forget emission at request completion. Never throws: a SIEM export problem must
 * not change the outcome of a request that already finished.
 */
export async function emitSiemUsageEvent(req: Request, context: UsageEventContext): Promise<void> {
  try {
    let siem: any;
    try {
      siem = configService.getConfig()?.api_config?.observability?.siem;
    } catch {
      // getConfig throws while the gateway is still waiting for its first configuration.
      // No configuration means no operator opt-in, so nothing is emitted.
      return;
    }

    const gates = resolveContentGates(siem);
    if (!gates.emit) return;

    // A streamed response is only whole once the stream has ended, and a controller calls the
    // usage tracker at completion without knowing whether the last byte has been flushed.
    // Waiting here costs the caller nothing: emitSiemUsageEvent is dispatched with `void`
    // from emitUsageEvent and has never been on the response path. The promise settles on
    // `finish` or on `close`, both of which Node always emits, so this cannot hang a request.
    const capture = getStreamCapture(req);
    if (capture) await capture.settled();

    const event = buildUsageEvent(req, {
      ...context,
      clientIP: context.clientIP ?? getClientIp(req, getTrustForwardedFor()),
    }, gates);
    if (!event) return;

    await securityEventEmitter.emitUsage(event);
  } catch (error) {
    logger.warn('SiemUsageEvent', 'Failed to emit usage SIEM event', {
      requestId: context.requestId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
