/**
 * The rows of payload traces and raw traces as the ingest (payloadTraceIngest.ts) stores them: a stream
 * message is checked and turned into a row, or refused (null). Nothing sealed is opened here. A light
 * row keeps `prompt` and `answer` only for a masked request and `sealedPrompt` only for one that was
 * not masked; a raw row keeps the stages' names, sizes and cut marks in the clear and the stages as
 * the gateway sealed them. A sealed value that is not a seal envelope refuses the message, so a clear
 * value can never be stored as a sealed one. Text is cut to its column, well-formed and without NUL
 * characters (PostgreSQL text cannot hold a lone surrogate or NUL).
 */
import { isSealEnvelope } from '@libs/trace-seal';

const LIMITS = { requestId: 60, endpoint: 500, model: 200, authType: 40, credentialId: 100, omitted: 30, stageName: 100 };

/** Well-formed (no lone surrogate) and without NUL characters. */
function clean(value: string): string {
  const noNul = value.replace(/\u0000/g, '');
  return typeof (noNul as any).toWellFormed === 'function'
    ? (noNul as any).toWellFormed()
    : noNul.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/** A string cut to its column (never inside a surrogate pair); null for anything that is not a non-empty string. */
function text(value: unknown, limit?: number): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const whole = value.replace(/\u0000/g, '');
  if (limit === undefined || whole.length <= limit) return clean(whole);
  let cut = whole.slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return clean(cut);
}

const integer = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= 2_147_483_647 ? v : null);
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const timeOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/** The row of a light trace (PayloadTraceMessage), or null when the message is not one. `keyName` and `userEmail` are added by the ingest. */
export function traceRow(id: string, m: unknown): Record<string, any> | null {
  if (!isObject(m) || m.v !== 1 || typeof m.requestId !== 'string' || !m.requestId || typeof m.masked !== 'boolean') return null;
  const capturedAt = timeOf(m.capturedAt);
  if (!capturedAt) return null;
  if (!m.masked && m.sealedPrompt !== undefined && m.sealedPrompt !== null && !isSealEnvelope(m.sealedPrompt)) return null;
  return {
    ID: id,
    requestId: text(m.requestId, LIMITS.requestId),
    capturedAt,
    endpoint: text(m.endpoint, LIMITS.endpoint),
    model: text(m.model, LIMITS.model),
    authType: text(m.authType, LIMITS.authType),
    credentialId: text(m.credentialId, LIMITS.credentialId),
    statusCode: integer(m.statusCode),
    durationMs: integer(m.durationMs),
    inputTokens: integer(m.inputTokens),
    outputTokens: integer(m.outputTokens),
    masked: m.masked,
    truncated: m.truncated === true,
    omitted: text(m.omitted, LIMITS.omitted),
    // Masked text may be stored in the clear; the prompt of a request that was not masked only sealed.
    prompt: m.masked ? text(m.prompt) : null,
    answer: m.masked ? text(m.answer) : null,
    sealedPrompt: m.masked ? null : text(m.sealedPrompt),
    raw: m.raw === true
  };
}

/** The row of a raw trace (RawTraceMessage), or null when the message is not one. The stage index keeps names, sizes and cut marks only. */
export function rawRow(id: string, m: unknown): Record<string, any> | null {
  if (!isObject(m) || m.v !== 1 || typeof m.requestId !== 'string' || !m.requestId || typeof m.sessionId !== 'string' || !m.sessionId) return null;
  if (!isSealEnvelope(m.sealedStages) || !Array.isArray(m.stageIndex)) return null;
  const capturedAt = timeOf(m.capturedAt);
  if (!capturedAt) return null;
  const stageIndex = m.stageIndex.filter((s: unknown) => isObject(s) && typeof s.name === 'string')
    .map((s: any) => ({ name: text(s.name, LIMITS.stageName) ?? '', bytes: integer(s.bytes) ?? 0, cut: s.cut === true }));
  return {
    ID: id,
    requestId: text(m.requestId, LIMITS.requestId),
    sessionId: text(m.sessionId, LIMITS.requestId),
    credentialId: text(m.credentialId, LIMITS.credentialId),
    capturedAt,
    stageIndex: JSON.stringify(stageIndex),
    cutStages: m.cutStages === true,
    stages: m.sealedStages
  };
}
