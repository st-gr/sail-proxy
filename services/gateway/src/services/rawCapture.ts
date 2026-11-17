/**
 * Raw capture: the stage-by-stage payloads of the requests of selected credentials, unmasked, for
 * error analysis. An administrator starts a session on the Logs page; the admin service writes the
 * running sessions to the Valkey key `sap-llm-gateway:raw-capture` and says so on the channel
 * `sap-llm-gateway:raw-capture-changed` (configService reads the key at start and on each message).
 *
 * Key shape: `{ "sessions": [{ "id": string, "credentialIds": string[], "endsAt": ISO 8601 string or epoch ms }] }`.
 * The gateway ends a session itself at `endsAt`, also when no message arrives.
 *
 * A request of a credential in a session gets a collector (middlewares/rawCaptureTap.ts opens it once
 * authentication has passed); every stage the payload logger sees under its request id is copied into
 * it at call time, also for a short grace period after the response (a stream's upstream summary is
 * saved after the client got [DONE]); then the stages are sealed and published once to the `raw-traces`
 * stream. Nothing waits for Valkey; what cannot be published is dropped and counted.
 *
 * `sealedStages` opens (openSealed of @libs/trace-seal) to the JSON text of an array, in recording order
 * except that `zz_client_response` is always last:
 *   [{ "name": "00_arrival", "content": "<JSON text of the stage>" }, ..., { "name": "zz_client_response", "content": "..." }]
 * Names are unique within a request: a name recorded again is published as `<name>#2`, `#3`, ...
 * in recording order (the first keeps the plain name), in `stageIndex` and here alike.
 * Each `content` is the JSON text of
 *   { timestamp, httpMethod?, url?, queryParams?, requestHeaders?, statusCode?, responseHeaders?, payload }
 * (the payload logger's file shape: the request facts only when the stage came with `req`, the response
 * facts only with `res`, URL, query and headers redacted with the payload logger's functions).
 * `zz_client_response` also holds `complete` (false when the client went away first) and `bytesSent`, and
 * its `payload` is the bytes the client received as UTF-8 text. A `content` that was cut (its
 * `stageIndex` entry says `cut: true`) is the leading bytes of that text and no longer valid JSON.
 * Room is kept for `zz_client_response`: the stages before it may use request_max_bytes less
 * min(stage_max_bytes, request_max_bytes / 4).
 */
import { Request, Response } from 'express';
import { Stream } from 'stream';
import { sealText } from '@libs/trace-seal';
import { getDefaultLogger } from '@libs/logger';
import securityEventEmitter from './securityEventEmitter';
import { stageFacts } from '../utils/sensitiveHeaders';
import { DropCounter } from '../utils/dropCounter';
import { warnOnceIfSealKeyWeak, resetSealKeyWarning } from '../utils/sealKeyWarning';

const logger = getDefaultLogger();

export const CLIENT_STAGE = 'zz_client_response';
const MAX_OPEN_COLLECTORS = 50;
const MAX_TIMER_MS = 2_147_483_647; // setTimeout's limit; a later end is re-armed when it fires

export interface RawCaptureLimits { stageMaxBytes: number; maxStages: number; requestMaxBytes: number }

export interface RawTraceMessage {
  v: 1;
  requestId: string;
  sessionId: string;
  /** When the request arrived (the collector opened). */
  capturedAt: string;
  credentialId: string;
  /** Names, stored sizes in bytes and cut marks, in recording order. Not content. */
  stageIndex: { name: string; bytes: number; cut: boolean }[];
  /** One envelope of @libs/trace-seal; see the top of this file for what it opens to. */
  sealedStages: string;
  /** A stage was dropped (max_stages, request_max_bytes) or cut by the request's total. */
  cutStages: boolean;
}

interface ActiveSession { id: string; endsAt: number }

interface StoredStage { name: string; content: string; bytes: number; cut: boolean }

interface Collector {
  sessionId: string;
  credentialId: string;
  limits: RawCaptureLimits;
  capturedAt: string;
  stages: StoredStage[];
  total: number;
  cutStages: boolean;
  clientRecorded: boolean;
}

const sessionsByCredential = new Map<string, ActiveSession>();
let expiryTimer: NodeJS.Timeout | undefined;
const collectors = new Map<string, Collector>();
/** The grace period timers of collected requests not yet closed (closeCollectorAfter). */
const closeTimers = new Set<NodeJS.Timeout>();
const stageFailures = new DropCounter((n) => logger.warn('RawCapture', 'Raw capture stages could not be recorded and were left out', { droppedSinceStart: n }));
const notCaptured = new DropCounter((n) => logger.warn('RawCapture',
  `Requests of a raw capture session were not captured: ${MAX_OPEN_COLLECTORS} were already being collected`, { droppedSinceStart: n }));

// ---------------------------------------------------------------- sessions

/** The sessions of the key's value, [] for no key, or 'malformed'. */
function parseSessions(json: string | null): { id: string; credentialIds: string[]; endsAt: number }[] | 'malformed' {
  if (json === null || json === '') return [];
  let value: any;
  try { value = JSON.parse(json); } catch { return 'malformed'; }
  if (!value || typeof value !== 'object' || !Array.isArray(value.sessions)) return 'malformed';
  const sessions: { id: string; credentialIds: string[]; endsAt: number }[] = [];
  for (const s of value.sessions) {
    const endsAt = typeof s?.endsAt === 'number' ? s.endsAt : typeof s?.endsAt === 'string' ? Date.parse(s.endsAt) : NaN;
    if (typeof s?.id !== 'string' || !s.id || !Array.isArray(s.credentialIds)
      || !s.credentialIds.every((c: unknown) => typeof c === 'string') || !Number.isFinite(endsAt)) return 'malformed';
    sessions.push({ id: s.id, credentialIds: s.credentialIds, endsAt });
  }
  return sessions;
}

/** Replaces the running sessions with those of the key's value (null: no key). Malformed input leaves none, with one warning. */
export function applySessions(json: string | null, now: Date): void {
  const parsed = parseSessions(json);
  sessionsByCredential.clear();
  if (parsed === 'malformed') {
    logger.warn('RawCapture', 'The raw capture sessions in Valkey are malformed; no request is captured raw until they are written again');
  } else {
    const nowMs = now.getTime();
    for (const s of parsed) {
      if (s.endsAt < nowMs) continue;
      const session: ActiveSession = { id: s.id, endsAt: s.endsAt };
      for (const credentialId of s.credentialIds) {
        const held = sessionsByCredential.get(credentialId);
        if (!held || held.endsAt < session.endsAt) sessionsByCredential.set(credentialId, session);
      }
    }
  }
  scheduleExpiry();
}

/** Ends the sessions whose end has passed when the earliest of them is due, so none outlives its end unseen. */
function scheduleExpiry(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  let earliest = Infinity;
  for (const s of sessionsByCredential.values()) earliest = Math.min(earliest, s.endsAt);
  if (earliest === Infinity) return;
  const delay = Math.min(Math.max(earliest - Date.now() + 1, 0), MAX_TIMER_MS);
  expiryTimer = setTimeout(() => {
    const nowMs = Date.now();
    for (const [credentialId, s] of sessionsByCredential) if (s.endsAt < nowMs) sessionsByCredential.delete(credentialId);
    scheduleExpiry();
  }, delay);
  expiryTimer.unref?.();
}

/** Whether any session is running: the one check a request pays while none is. */
export function rawCaptureRunning(): boolean {
  return sessionsByCredential.size > 0;
}

/** The session of a credential at `nowMs` (until its end, inclusive): one Map lookup, no allocation. */
export function activeSessionAt(credentialId: string | undefined, nowMs: number): { id: string } | undefined {
  if (credentialId === undefined) return undefined;
  const session = sessionsByCredential.get(credentialId);
  return session && nowMs <= session.endsAt ? session : undefined;
}

export function activeSessionFor(credentialId: string | undefined, now: Date): { id: string } | undefined {
  return activeSessionAt(credentialId, now.getTime());
}

// ---------------------------------------------------------------- collectors

/** Starts collecting a request's stages. False when it is already collected or 50 are open (then counted). */
export function openCollector(requestId: string, sessionId: string, credentialId: string, limits: RawCaptureLimits): boolean {
  if (collectors.has(requestId)) return false;
  if (collectors.size >= MAX_OPEN_COLLECTORS) {
    notCaptured.count();
    return false;
  }
  warnOnceIfSealKeyWeak(process.env);
  collectors.set(requestId, { sessionId, credentialId, limits, capturedAt: new Date().toISOString(), stages: [], total: 0, cutStages: false, clientRecorded: false });
  return true;
}

/** Whether a request's stages are being collected: lets a stage that costs work to build be built only then. No allocation. */
export function isRawCaptured(requestId: string | number | undefined | null): boolean {
  if (collectors.size === 0 || requestId === undefined || requestId === null || requestId === '') return false;
  return collectors.has(typeof requestId === 'string' ? requestId : String(requestId));
}

/**
 * Copies a stage of a collected request (no-op for every other request). The data is serialised now,
 * so a later change of the object does not reach the stage; then it is cut to the limits.
 */
export function recordStage(requestId: string | number, stage: string, data: unknown, req?: Request, res?: Response): void {
  if (collectors.size === 0) return;
  const collector = collectors.get(typeof requestId === 'string' ? requestId : String(requestId));
  if (!collector) return;
  try {
    addStage(collector, stage, snapshot(stageView(data, req, res), collector.limits.stageMaxBytes));
  } catch {
    // Called on the request path (savePayload): a stage that cannot be built is left out, never thrown.
    stageFailures.count();
  }
}

/** The client's stage: what it received (as text), the status and whether the response completed. */
export function recordClientResponse(requestId: string, res: Response, body: string, bytesSent: number, complete: boolean): void {
  const collector = collectors.get(requestId);
  if (!collector) return;
  try {
    const view = stageView(body, undefined, res);
    addStage(collector, CLIENT_STAGE, snapshot({ ...view, complete, bytesSent }, collector.limits.stageMaxBytes));
  } catch {
    stageFailures.count();
  }
}

/**
 * Each stage under a name of its own: the payload logger uses some names at several call sites, so a
 * name recorded again in the same request becomes `<name>#2`, `#3`, ... in order; the first keeps it.
 */
function uniqueNames(stages: StoredStage[]): StoredStage[] {
  const used = new Set<string>();
  const seen = new Map<string, number>();
  return stages.map((s) => {
    let name = s.name;
    let n = seen.get(s.name) ?? 1;
    while (used.has(name)) name = `${s.name}#${++n}`;
    seen.set(s.name, n);
    used.add(name);
    return name === s.name ? s : { ...s, name };
  });
}

/** Seals the stages and publishes them once, then forgets the request. Never throws. */
export function closeCollector(requestId: string, outcome: { statusCode: number; complete: boolean }): void {
  const collector = collectors.get(requestId);
  if (!collector) return;
  collectors.delete(requestId);
  try {
    // Arrival, the stages, then what the client received, also when a stage came in during the grace period.
    const stages = uniqueNames([...collector.stages.filter((s) => s.name !== CLIENT_STAGE), ...collector.stages.filter((s) => s.name === CLIENT_STAGE)]);
    const plaintext = JSON.stringify(stages.map((s) => ({ name: s.name, content: s.content })));
    const message: RawTraceMessage = {
      v: 1,
      requestId,
      sessionId: collector.sessionId,
      capturedAt: collector.capturedAt,
      credentialId: collector.credentialId,
      stageIndex: stages.map((s) => ({ name: s.name, bytes: s.bytes, cut: s.cut })),
      sealedStages: sealText(plaintext, process.env),
      cutStages: collector.cutStages,
    };
    securityEventEmitter.publishRawTrace(JSON.stringify(message));
    logger.debug('RawCapture', 'Raw trace handed over', { requestId, stages: collector.stages.length, statusCode: outcome.statusCode, complete: outcome.complete });
  } catch {
    securityEventEmitter.countDroppedRawTrace();
  }
}

/** Closes a collected request's collector `delayMs` from now (its grace period). Nothing waits for it; never throws. */
export function closeCollectorAfter(requestId: string, delayMs: number, outcome: { statusCode: number; complete: boolean }): void {
  // Runs in a 'finish' / 'close' listener and a timer: a throw there would be an uncaught exception.
  const timer = setTimeout(() => {
    closeTimers.delete(timer);
    try {
      closeCollector(requestId, outcome);
    } catch {
      securityEventEmitter.countDroppedRawTrace();
    }
  }, delayMs);
  timer.unref?.();
  closeTimers.add(timer);
}

export function openCollectorCount(): number {
  return collectors.size;
}

/** Tests only: no sessions, no collectors, no pending grace period, the key warning not yet given. */
export function clearRawCaptureState(): void {
  sessionsByCredential.clear();
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  for (const timer of closeTimers) clearTimeout(timer);
  closeTimers.clear();
  collectors.clear();
  resetSealKeyWarning();
}

// ---------------------------------------------------------------- stages

/** The payload logger's file shape for a stage. */
function stageView(data: unknown, req?: Request, res?: Response): Record<string, unknown> {
  return { timestamp: new Date().toISOString(), ...stageFacts(req, res), payload: data };
}

/**
 * JSON text of a value as it is now. A repeated object becomes '[Circular Reference]' (as in the
 * payload logger), a Buffer its base64 (at most `maxBytes` of it), a stream a marker, a BigInt its digits.
 */
function snapshot(value: unknown, maxBytes: number): string {
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(value, function (this: any, key: string, v: unknown) {
      const original = this ? this[key] : v;
      if (Buffer.isBuffer(original)) return { buffer: 'base64', bytes: original.length, data: original.subarray(0, maxBytes).toString('base64') };
      if (original instanceof Stream) return '[stream: not captured]';
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular Reference]';
        seen.add(v);
      }
      return v;
    });
    return text === undefined ? 'null' : text;
  } catch {
    return '{"__error":"this stage could not be serialised"}';
  }
}

/**
 * The bytes of request_max_bytes kept for the client's stage, the most useful one: the stages recorded
 * before it may use request_max_bytes less min(stage_max_bytes, request_max_bytes / 4). A stage recorded
 * after it (the grace period) may use what it left.
 */
function clientReserve(limits: RawCaptureLimits): number {
  return Math.min(limits.stageMaxBytes, Math.floor(limits.requestMaxBytes / 4));
}

/** Keeps a stage within the limits; the last of max_stages and some of request_max_bytes are kept for the client's stage. */
function addStage(collector: Collector, name: string, content: string): void {
  const { stageMaxBytes, maxStages, requestMaxBytes } = collector.limits;
  const isClient = name === CLIENT_STAGE;
  // The client's stage may already be in (a stage of the grace period): count the others apart from it.
  const noPlace = isClient ? collector.stages.length >= maxStages : collector.stages.length - (collector.clientRecorded ? 1 : 0) >= maxStages - 1;
  if (noPlace) {
    collector.cutStages = true;
    return;
  }
  const budget = isClient || collector.clientRecorded ? requestMaxBytes : requestMaxBytes - clientReserve(collector.limits);
  const room = Math.min(stageMaxBytes, budget - collector.total);
  if (room <= 0) {
    collector.cutStages = true;
    return;
  }
  const full = Buffer.from(content, 'utf8');
  let stored = content;
  let bytes = full.length;
  const cut = bytes > room;
  if (cut) {
    // Back to the start of a UTF-8 sequence, so the cut text holds no half character.
    let end = room;
    while (end > 0 && (full[end] & 0xc0) === 0x80) end--;
    stored = full.subarray(0, end).toString('utf8');
    bytes = end;
    if (room < stageMaxBytes) collector.cutStages = true;
  }
  collector.total += bytes;
  if (isClient) collector.clientRecorded = true;
  collector.stages.push({ name, content: stored, bytes, cut });
}
