/**
 * Raw capture sessions (spec 4.2, 5.2, 5.5; D3, D4, D7, D9): an administrator starts a session for
 * API keys and/or e-mail addresses, for 15, 60 or 240 minutes (at most
 * `payload_capture.raw.max_duration_minutes`) with a reason. The addresses are resolved to every API
 * key and AWS credential they own at the start; a credential created later is not captured.
 *
 * The running sessions travel to the gateway through Valkey (services/gateway/src/services/rawCapture.ts):
 * the key `sap-llm-gateway:raw-capture` holds `{ sessions: [{ id, credentialIds, endsAt }] }` and the
 * channel `sap-llm-gateway:raw-capture-changed` says it changed. The gateway drops every session when
 * one entry is malformed, so only well-formed entries are written. The gateway matches a request by
 * ApiKeys.ID for an API key, AwsCredentials.ID on the unified AWS path and the access key id on the
 * legacy one, so an AWS credential contributes both of its ids.
 *
 * A start or stop is refused when Valkey cannot be reached (the gateway would not learn of it), and is
 * undone when writing the key fails. The gateway ends a session at `endsAt` by itself; here the expiry
 * timer (every 30 s, first a few seconds after the start) marks it ended, writes `raw.capture.end` by
 * `system`, and rewrites the key; it also rewrites the key at the admin's start, so a gateway that
 * missed a message catches up. Every read and write is its own short transaction, and none is open
 * while Valkey is called (the admin's SQLite has one connection).
 */
import { v4 as uuidv4 } from 'uuid';
import { sealKeyStatus, SealKeyStatus } from '@libs/trace-seal';
import { getDefaultLogger } from '@libs/logger';
import { quotaStateStore } from './quotaStateStore';
import { recordAuditEvent } from './auditEventService';
import { activeRawCaptureMaxMinutes } from './gatewayLogRetention';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export const RAW_CAPTURE_KEY = 'sap-llm-gateway:raw-capture';
export const RAW_CAPTURE_CHANNEL = 'sap-llm-gateway:raw-capture-changed';
export const RAW_CAPTURE_SESSIONS_ENTITY = 'sap.llm.gateway.admin.RawCaptureSessions';
const API_KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS_CREDENTIALS = 'sap.llm.gateway.admin.AwsCredentials';
const DURATIONS = [15, 60, 240];
const REASON_MAX = 500;
const AUDIT_DETAILS_MAX = 1000;
// Longer than any session (at most 240 minutes); the key is rewritten on every change and at start.
const KEY_TTL_SECONDS = 86_400;
const INTERVAL_MS = 30_000;
const FIRST_RUN_MS = 5_000;

/** A refused start or stop: `key` is a message of _i18n/messages*.properties, `args` fill its {0}. */
export class RawCaptureError extends Error {
  constructor(public status: number, public key: string, public args: string[] = []) {
    super(key);
  }
}

export interface RawCaptureActor { id: string; clientIP?: string; userAgent?: string }
export interface RawCaptureStart { apiKeyIds?: unknown; emails?: unknown; minutes?: unknown; reason?: unknown }

type SessionRow = { ID: string; startedAt: string; endsAt: string; endedAt: string | null; startedBy: string; reason: string;
  apiKeyIds: string; emails: string; credentialIds: string; endedBy: string | null };

// The gateway has learnt nothing yet after a start of the admin, or a write failed since.
let republishOwed = true;

const read = (query: any): Promise<any> => cds.tx(async (tx: any) => tx.run(query));
const iso = (v: unknown): string => new Date(v as string).toISOString();

/** Trimmed, non-empty, distinct strings of a list (anything else is left out). */
function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v !== ''))];
}

function parseList(json: unknown): string[] | null {
  try {
    const value = JSON.parse(String(json));
    return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
  } catch {
    return null;
  }
}

/** The audit details: as many keys and addresses as fit in 1,000 characters, and how many were left out. */
function auditDetails(row: Pick<SessionRow, 'reason' | 'apiKeyIds' | 'emails'>, extra: Record<string, unknown> = {}): string {
  const keys = parseList(row.apiKeyIds) ?? [];
  const emails = parseList(row.emails) ?? [];
  const total = { keys: keys.length, emails: emails.length };
  const text = (reason: string): string => JSON.stringify({
    reason, ...extra, apiKeyIds: keys, emails,
    ...(keys.length < total.keys ? { apiKeyIdsLeftOut: total.keys - keys.length } : {}),
    ...(emails.length < total.emails ? { emailsLeftOut: total.emails - emails.length } : {})
  });
  while (text(row.reason).length > AUDIT_DETAILS_MAX && (keys.length || emails.length)) (keys.length >= emails.length ? keys : emails).pop();
  let reason = row.reason;
  while (text(reason).length > AUDIT_DETAILS_MAX && reason.length) reason = reason.slice(0, -10);
  return text(reason);
}

async function audit(action: string, actor: RawCaptureActor | 'system', row: Pick<SessionRow, 'ID' | 'reason' | 'apiKeyIds' | 'emails'>,
  extra: Record<string, unknown> = {}): Promise<void> {
  const by = actor === 'system' ? { actorId: 'system', actorType: 'system' as const } : {
    actorId: actor.id, actorType: 'admin_user' as const, clientIP: actor.clientIP, userAgent: actor.userAgent };
  await cds.tx(() => recordAuditEvent({ ...by, action, resourceType: 'RawCaptureSession', resourceId: row.ID,
    outcome: 'success', severity: 'high', details: auditDetails(row, extra) }));
}

/** `email` (lower-cased) is one of `lowered`: CQN `tolower`, which SQLite and PostgreSQL each render themselves. */
const emailIn = (lowered: string[]): any[] => [{ xpr: [{ func: 'tolower', args: [{ ref: ['email'] }] }, 'in', { list: lowered.map((val) => ({ val })) }] }];

/**
 * The credential ids of the keys and addresses: refused when a key is unknown or an address owns none.
 * An address matches whatever its case, on either side.
 */
async function resolveCredentials(apiKeyIds: string[], emails: string[]): Promise<{ credentialIds: string[]; credentialCount: number }> {
  const lowered = [...new Set(emails.map((e) => e.toLowerCase()))];
  const [keysById, awsById, keysByEmail, awsByEmail]: any[][] = await cds.tx(async (tx: any) => {
    const select = (list: string[], query: () => any): Promise<any[]> => (list.length ? tx.run(query()) : Promise.resolve([]));
    return [
      await select(apiKeyIds, () => cds.ql.SELECT.from(API_KEYS).columns('ID').where({ ID: { in: apiKeyIds }, deletedAt: null })),
      await select(apiKeyIds, () => cds.ql.SELECT.from(AWS_CREDENTIALS).columns('ID', 'accessKeyId').where({ ID: { in: apiKeyIds } })),
      await select(lowered, () => cds.ql.SELECT.from(API_KEYS).columns('ID', 'email').where(emailIn(lowered)).and({ deletedAt: null })),
      await select(lowered, () => cds.ql.SELECT.from(AWS_CREDENTIALS).columns('ID', 'accessKeyId', 'email').where(emailIn(lowered)))
    ];
  });
  const found = new Set([...keysById, ...awsById].map((r) => r.ID));
  const unknown = apiKeyIds.filter((id) => !found.has(id));
  if (unknown.length) throw new RawCaptureError(400, 'RAW_CAPTURE_UNKNOWN_KEY', [unknown.join(', ')]);
  const owners = new Set([...keysByEmail, ...awsByEmail].map((r) => String(r.email).toLowerCase()));
  const without = emails.filter((e) => !owners.has(e.toLowerCase()));
  if (without.length) throw new RawCaptureError(400, 'RAW_CAPTURE_ADDRESS_WITHOUT_CREDENTIALS', [without.join(', ')]);
  const credentials = new Map<string, string[]>();
  for (const r of [...keysById, ...keysByEmail]) credentials.set(r.ID, [r.ID]);
  for (const r of [...awsById, ...awsByEmail]) credentials.set(r.ID, [r.ID, r.accessKeyId].filter((v) => typeof v === 'string' && v !== ''));
  return { credentialIds: [...new Set([...credentials.values()].flat())], credentialCount: credentials.size };
}

/** The sessions running at `now`, earliest end first. */
function runningSessions(now: Date): Promise<SessionRow[]> {
  return read(cds.ql.SELECT.from(RAW_CAPTURE_SESSIONS_ENTITY).where({ endedAt: null, endsAt: { '>': now.toISOString() } }).orderBy('endsAt', 'startedAt'));
}

function requireValkey(): void {
  if (!quotaStateStore.available()) throw new RawCaptureError(503, 'RAW_CAPTURE_NO_VALKEY');
}

let publishing: Promise<unknown> = Promise.resolve();

/**
 * Writes the sessions running at `now` to the Valkey key and announces it. Throws RawCaptureError (503)
 * when Valkey cannot take it. One write at a time, each reading the sessions after the previous one
 * finished, so two overlapping changes cannot leave the older set in the key. `undo` reverts the change
 * whose write failed, still inside this step, so the next write never reads it; a rewrite is then owed,
 * because a write queued before this one may have read the change and put it into the key.
 */
export function publishActiveSessions(now: Date, undo?: () => Promise<void>): Promise<void> {
  const next = publishing.then(async () => {
    try {
      await writeActiveSessions(now);
    } catch (error) {
      if (undo) {
        try {
          await undo();
        } catch (undoError) {
          logger.error('RawCapture', `A raw capture change whose write to Valkey failed could not be undone: ${undoError instanceof Error ? undoError.message : String(undoError)}`);
        }
        republishOwed = true;
      }
      throw error;
    }
  });
  publishing = next.catch(() => undefined);
  return next;
}

async function writeActiveSessions(now: Date): Promise<void> {
  const sessions: { id: string; credentialIds: string[]; endsAt: string }[] = [];
  for (const row of await runningSessions(now)) {
    const credentialIds = parseList(row.credentialIds);
    const endsAt = new Date(row.endsAt);
    if (!credentialIds || Number.isNaN(endsAt.getTime())) {
      logger.warn('RawCapture', 'A raw capture session cannot be read and is not passed to the gateway', { sessionId: row.ID });
      continue;
    }
    sessions.push({ id: row.ID, credentialIds, endsAt: endsAt.toISOString() });
  }
  const written = quotaStateStore.available()
    && await quotaStateStore.setJson(RAW_CAPTURE_KEY, { sessions }, KEY_TTL_SECONDS)
    && await quotaStateStore.publish(RAW_CAPTURE_CHANNEL, JSON.stringify({ version: Date.now() }));
  republishOwed = !written;
  if (!written) throw new RawCaptureError(503, 'RAW_CAPTURE_NO_VALKEY');
}

export async function startRawCaptureSession(input: RawCaptureStart, actor: RawCaptureActor, now: Date)
  : Promise<{ ID: string; endsAt: string; credentialCount: number; keyStatus: SealKeyStatus }> {
  const apiKeyIds = cleanList(input.apiKeyIds);
  const emails = cleanList(input.emails);
  if (!apiKeyIds.length && !emails.length) throw new RawCaptureError(400, 'RAW_CAPTURE_NOTHING_SELECTED');
  const minutes = input.minutes;
  if (minutes === undefined || minutes === null) throw new RawCaptureError(400, 'RAW_CAPTURE_DURATION_MISSING');
  if (typeof minutes !== 'number' || !DURATIONS.includes(minutes)) throw new RawCaptureError(400, 'RAW_CAPTURE_DURATION_INVALID', [String(minutes)]);
  const maxMinutes = await activeRawCaptureMaxMinutes();
  if (minutes > maxMinutes) throw new RawCaptureError(400, 'RAW_CAPTURE_DURATION_TOO_LONG', [String(maxMinutes)]);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw new RawCaptureError(400, 'RAW_CAPTURE_REASON_REQUIRED');
  if (reason.length > REASON_MAX) throw new RawCaptureError(400, 'RAW_CAPTURE_REASON_TOO_LONG', [String(REASON_MAX)]);
  const { credentialIds, credentialCount } = await resolveCredentials(apiKeyIds, emails);
  requireValkey();

  const row: SessionRow = { ID: uuidv4(), startedAt: now.toISOString(), endsAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    endedAt: null, startedBy: actor.id, reason, apiKeyIds: JSON.stringify(apiKeyIds), emails: JSON.stringify(emails),
    credentialIds: JSON.stringify(credentialIds), endedBy: null };
  await cds.tx(async (tx: any) => { await tx.run(cds.ql.INSERT.into(RAW_CAPTURE_SESSIONS_ENTITY).entries(row)); });
  // When the gateway cannot be told, the session never ran: it is removed again.
  await publishActiveSessions(now, () => cds.tx(async (tx: any) => {
    await tx.run(cds.ql.DELETE.from(RAW_CAPTURE_SESSIONS_ENTITY).where({ ID: row.ID }));
  }));
  await audit('raw.capture.start', actor, row, { minutes, credentialCount });
  return { ID: row.ID, endsAt: row.endsAt, credentialCount, keyStatus: sealKeyStatus(process.env) };
}

export async function stopRawCaptureSession(id: unknown, actor: RawCaptureActor, now: Date): Promise<void> {
  const row: SessionRow | null = typeof id === 'string' && id !== ''
    ? await read(cds.ql.SELECT.one.from(RAW_CAPTURE_SESSIONS_ENTITY).where({ ID: id })) : null;
  if (!row) throw new RawCaptureError(404, 'RAW_CAPTURE_NOT_FOUND', [String(id ?? '')]);
  if (row.endedAt || new Date(row.endsAt).getTime() <= now.getTime()) throw new RawCaptureError(409, 'RAW_CAPTURE_ALREADY_ENDED', [row.ID]);
  requireValkey();
  const changed: number = await cds.tx(async (tx: any) => tx.run(
    cds.ql.UPDATE(RAW_CAPTURE_SESSIONS_ENTITY).set({ endedAt: now.toISOString(), endedBy: actor.id }).where({ ID: row.ID, endedAt: null })));
  if (!changed) throw new RawCaptureError(409, 'RAW_CAPTURE_ALREADY_ENDED', [row.ID]);
  // When the gateway cannot be told, it still captures: the session keeps running until stopped again or ended.
  await publishActiveSessions(now, () => cds.tx(async (tx: any) => {
    await tx.run(cds.ql.UPDATE(RAW_CAPTURE_SESSIONS_ENTITY).set({ endedAt: null, endedBy: null }).where({ ID: row.ID }));
  }));
  await audit('raw.capture.stop', actor, row);
}

/** The sessions running at `now`, for the cockpit's bar. */
export async function activeRawCaptureSessions(now: Date): Promise<{ ID: string; endsAt: string; startedBy: string; keyCount: number; addressCount: number }[]> {
  return (await runningSessions(now)).map((row) => ({
    ID: row.ID, endsAt: iso(row.endsAt), startedBy: row.startedBy,
    keyCount: (parseList(row.apiKeyIds) ?? []).length, addressCount: (parseList(row.emails) ?? []).length
  }));
}

/** Marks the sessions whose end has passed as ended by `system`, audits them and rewrites the key. Returns how many ended. */
export async function endExpiredSessions(now: Date): Promise<number> {
  const due: SessionRow[] = await read(cds.ql.SELECT.from(RAW_CAPTURE_SESSIONS_ENTITY).where({ endedAt: null, endsAt: { '<=': now.toISOString() } }));
  let ended = 0;
  for (const row of due) {
    const changed: number = await cds.tx(async (tx: any) => tx.run(
      cds.ql.UPDATE(RAW_CAPTURE_SESSIONS_ENTITY).set({ endedAt: iso(row.endsAt), endedBy: 'system' }).where({ ID: row.ID, endedAt: null })));
    if (!changed) continue;
    ended += 1;
    await audit('raw.capture.end', 'system', row);
  }
  if (ended) {
    try {
      await publishActiveSessions(now);
    } catch {
      // The gateway ends these sessions at their end by itself; the key is rewritten on the next run.
      logger.warn('RawCapture', 'The ended raw capture sessions could not be written to Valkey; the next check tries again');
    }
  }
  return ended;
}

const isTestProcess = (): boolean => process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;

export interface RawCaptureExpiryHandle { stop: () => void; timers: NodeJS.Timeout[] }

/**
 * Ends sessions on time and keeps the gateway's key current: a first run a few seconds after the start
 * (the Valkey client is still connecting) rewrites the key, so a gateway that missed a message catches
 * up; then a run every 30 s ends what is due and rewrites the key while a session runs (a Valkey restart
 * without persistence loses it) or when a write failed before. Unref-ed; null in a test process unless
 * allowed, and without VALKEY_URL (no session can run there).
 */
export function startRawCaptureExpiry(opts: { allowInTest?: boolean; intervalMs?: number; firstRunMs?: number } = {}): RawCaptureExpiryHandle | null {
  if ((isTestProcess() && !opts.allowInTest) || !process.env.VALKEY_URL) return null;
  let running = false;
  const run = async (startUp: boolean): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const ended = await endExpiredSessions(now);
      if (ended) logger.info('RawCapture', `${ended} raw capture session(s) ended`);
      if (startUp || republishOwed || (await runningSessions(now)).length) await publishActiveSessions(now);
    } catch (error) {
      logger.warn('RawCapture', `The raw capture sessions could not be checked or written: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => { void run(true); }, opts.firstRunMs ?? FIRST_RUN_MS);
  const every = setInterval(() => { void run(false); }, opts.intervalMs ?? INTERVAL_MS);
  first.unref();
  every.unref();
  return { timers: [first, every], stop: () => { clearTimeout(first); clearInterval(every); } };
}
