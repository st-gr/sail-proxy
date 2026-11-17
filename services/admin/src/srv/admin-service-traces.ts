/**
 * Opening stored payload traces (spec 4.4, 5): the functions openPayloadTrace and openRawStage on
 * AdminService and the downloads GET /api/logs/traces/:id/download and GET /api/logs/raw/:id/download
 * (all stages, or one with `?stage=<name>`). All admin only (admin-service.cds, admin-caller.ts).
 *
 * - A masked trace's text is stored in the clear and is returned without an audit event; so is a
 *   facts-only trace (not masked, nothing sealed): nothing unmasked is handed out.
 * - The prompt of a trace that was not masked, and every raw stage, is stored sealed; it is opened
 *   here with the admin's METADATA_ENCRYPTION_KEY, and every such open or download writes an audit
 *   event (`payload.trace.open|download`, `raw.trace.open|download`, severity high) that names the
 *   actor, the request id and the stage, never the content. A seal the admin cannot open (another
 *   key, or a damaged envelope) gives `problem` (`keys-differ`, `malformed`) and a `failure` event.
 * - Opened content is never logged and never written anywhere: it goes to the caller only, with
 *   `Cache-Control: no-store` so no browser or proxy keeps a copy.
 * - The row is read in its own short transaction and the audit event written in another, so no
 *   transaction is open across another await (the admin's SQLite has one connection).
 */
import express from 'express';
import { openSealed } from '@libs/trace-seal';
import { getDefaultLogger } from '@libs/logger';
import { adminOf } from './admin-caller';
import { recordAuditEvent } from '../services/auditEventService';
import { clientContext } from '../utils/clientIp';
import { PAYLOAD_TRACE_ENTITY, RAW_TRACE_ENTITY } from '../services/payloadTraceIngest';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

type Problem = 'keys-differ' | 'malformed';
type StageEntry = { name: string; bytes: number; cut: boolean };

const TRACE_FACTS = ['ID', 'requestId', 'capturedAt', 'endpoint', 'model', 'authType', 'credentialId', 'keyName', 'userEmail',
  'statusCode', 'durationMs', 'inputTokens', 'outputTokens', 'masked', 'truncated', 'omitted', 'raw'];
const RAW_FACTS = ['ID', 'requestId', 'sessionId', 'credentialId', 'capturedAt', 'cutStages'];
const BOOLEANS = ['masked', 'truncated', 'raw', 'cutStages'];

const PROBLEM_TEXT: Record<Problem, string> = {
  'keys-differ': 'The trace cannot be opened: it was sealed with another key. The admin service and the gateway hold different values of METADATA_ENCRYPTION_KEY.',
  malformed: 'The stored trace cannot be read.'
};

const readOne = (entity: string, columns: string[], id: unknown): Promise<any> => (typeof id === 'string' && id !== ''
  ? cds.tx(async (tx: any) => tx.run(cds.ql.SELECT.one.from(entity).columns(...columns).where({ ID: id })))
  : Promise.resolve(null));

const readTrace = (id: unknown) => readOne(PAYLOAD_TRACE_ENTITY, [...TRACE_FACTS, 'prompt', 'answer', 'sealedPrompt'], id);
const readRaw = (id: unknown) => readOne(RAW_TRACE_ENTITY, [...RAW_FACTS, 'stageIndex', 'stages'], id);

/** The row's facts, with the booleans as booleans on both databases. */
function factsOf(row: any, columns: string[]): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const c of columns) facts[c] = BOOLEANS.includes(c) && row[c] !== null && row[c] !== undefined ? Boolean(row[c]) : row[c] ?? null;
  return facts;
}

/** Whether handing out a trace's text hands out something unmasked: a sealed prompt is stored. */
const opensSealed = (row: any): boolean => !row.masked && !!row.sealedPrompt;

/** The text of a trace: as stored when masked; the sealed prompt opened when not (it has no answer). */
function textOf(row: any): { prompt: string | null; answer: string | null; problem?: Problem } {
  if (row.masked) return { prompt: row.prompt ?? null, answer: row.answer ?? null };
  if (!row.sealedPrompt) return { prompt: null, answer: null };
  const opened = openSealed(row.sealedPrompt, process.env);
  return opened.ok ? { prompt: opened.text, answer: null } : { prompt: null, answer: null, problem: opened.reason };
}

/** The stage index (names, sizes, cut marks); empty when it cannot be read. */
function indexOf(row: any): StageEntry[] {
  try {
    const parsed = JSON.parse(row.stageIndex);
    return Array.isArray(parsed) ? parsed.filter((s) => s && typeof s.name === 'string') : [];
  } catch {
    return [];
  }
}

/** The stages of a raw trace, opened: their names and content texts, in recording order. */
function stagesOf(row: any): { stages: { name: string; content: string }[] } | { problem: Problem } {
  if (typeof row.stages !== 'string' || !row.stages) return { problem: 'malformed' };
  const opened = openSealed(row.stages, process.env);
  if (!opened.ok) return { problem: opened.reason };
  try {
    const parsed = JSON.parse(opened.text);
    if (Array.isArray(parsed) && parsed.every((s) => s && typeof s.name === 'string' && typeof s.content === 'string')) return { stages: parsed };
  } catch { /* below */ }
  return { problem: 'malformed' };
}

async function audit(actorId: string, action: string, resourceType: string, resourceId: string, problem: Problem | undefined,
  details: Record<string, unknown>, context: { clientIP: string; userAgent: string }): Promise<void> {
  await cds.tx(() => recordAuditEvent({
    actorId, actorType: 'admin_user', action, resourceType, resourceId, outcome: problem ? 'failure' : 'success', severity: 'high',
    ...context, details: JSON.stringify(problem ? { ...details, problem } : details)
  }));
}

/** No browser or proxy cache keeps a response that carries trace content. */
const noStore = (req: any): void => { req.http?.res?.setHeader?.('Cache-Control', 'no-store'); };

async function openPayloadTrace(req: any): Promise<any> {
  noStore(req);
  const row = await readTrace(req.data?.ID);
  if (!row) return req.reject({ status: 404, code: 'PAYLOAD_TRACE_NOT_FOUND', message: 'PAYLOAD_TRACE_NOT_FOUND', args: [String(req.data?.ID ?? '')] });
  const text = textOf(row);
  if (opensSealed(row)) {
    await audit(req.user?.id || 'anonymous', 'payload.trace.open', 'PayloadTrace', row.ID, text.problem, { requestId: row.requestId }, clientContext(req));
  }
  return { masked: Boolean(row.masked), prompt: text.prompt, answer: text.answer, problem: text.problem ?? null };
}

async function openRawStage(req: any): Promise<any> {
  noStore(req);
  const { ID: id, stage } = req.data ?? {};
  const row = await readRaw(id);
  if (!row) return req.reject({ status: 404, code: 'RAW_TRACE_NOT_FOUND', message: 'RAW_TRACE_NOT_FOUND', args: [String(id ?? '')] });
  const entry = indexOf(row).find((s) => s.name === stage);
  if (!entry) return req.reject({ status: 404, code: 'RAW_STAGE_NOT_FOUND', message: 'RAW_STAGE_NOT_FOUND', args: [String(stage ?? ''), String(id)] });
  const opened = stagesOf(row);
  let problem: Problem | undefined = 'problem' in opened ? opened.problem : undefined;
  let content: string | null = null;
  if (!problem) {
    const found = (opened as { stages: { name: string; content: string }[] }).stages.find((s) => s.name === stage);
    if (found) content = found.content; else problem = 'malformed';
  }
  await audit(req.user?.id || 'anonymous', 'raw.trace.open', 'RawTrace', row.ID, problem, { requestId: row.requestId, stage }, clientContext(req));
  return { stage, content, cut: entry.cut === true, problem: problem ?? null };
}

export function registerTraceHandlers(service: any): void {
  service.on('openPayloadTrace', openPayloadTrace);
  service.on('openRawStage', openRawStage);
}

/** A file name part of safe characters only (it goes into a header). */
const fileSafe = (value: unknown): string => String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');

/** A stage's content for the file: the JSON it holds, or its text when it was cut or is not JSON. */
function contentForFile(content: string, cut: boolean): unknown {
  if (cut) return content;
  try { return JSON.parse(content); } catch { return content; }
}

function sendFile(res: express.Response, name: string, body: unknown): void {
  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body, null, 2));
}

/** One stage as its own file: its JSON, or its text (`.txt`) when it was cut and is no longer JSON. */
function sendStage(res: express.Response, baseName: string, content: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.txt"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(content);
    return;
  }
  sendFile(res, `${baseName}.json`, parsed);
}

/** The `stage` query parameter: undefined when absent, null when it is not one non-empty plain string. */
function stageParam(req: express.Request): string | undefined | null {
  const value: unknown = (req.query as Record<string, unknown>).stage;
  if (value === undefined) return undefined;
  return typeof value === 'string' && value !== '' ? value : null;
}

const notFound = (res: express.Response, what: string): void => { res.status(404).json({ error: 'not_found', message: `No ${what} has this id.` }); };
const refused = (res: express.Response, problem: Problem): void => { res.status(409).json({ error: problem, message: PROBLEM_TEXT[problem] }); };
const context = (req: express.Request) => clientContext({ http: { req } });

export function createTraceDownloadRouter(): express.Router {
  const router: express.Router = express.Router();

  router.get('/traces/:id/download', async (req, res) => {
    const actor = adminOf(req, res);
    if (!actor) return;
    try {
      const row = await readTrace(req.params.id);
      if (!row) { notFound(res, 'payload trace'); return; }
      const text = textOf(row);
      if (opensSealed(row)) await audit(actor.id, 'payload.trace.download', 'PayloadTrace', row.ID, text.problem, { requestId: row.requestId }, context(req));
      if (text.problem) { refused(res, text.problem); return; }
      sendFile(res, `payload-trace-${fileSafe(row.requestId)}.json`, { ...factsOf(row, TRACE_FACTS), prompt: text.prompt, answer: text.answer });
    } catch (error) {
      logger.error('TraceDownload', 'Reading a payload trace for its download failed', error as Error);
      if (!res.headersSent) res.status(500).json({ error: 'download_failed', message: 'The trace could not be read.' });
    }
  });

  router.get('/raw/:id/download', async (req, res) => {
    const actor = adminOf(req, res);
    if (!actor) return;
    try {
      const stage = stageParam(req);
      if (stage === null) { res.status(400).json({ error: 'bad_request', message: 'The parameter "stage" must be given once, as a stage name.' }); return; }
      const row = await readRaw(req.params.id);
      if (!row) { notFound(res, 'raw trace'); return; }
      if (stage !== undefined) { await downloadStage(req, res, actor.id, row, stage); return; }
      const opened = stagesOf(row);
      const problem = 'problem' in opened ? opened.problem : undefined;
      await audit(actor.id, 'raw.trace.download', 'RawTrace', row.ID, problem, { requestId: row.requestId }, context(req));
      if (problem) { refused(res, problem); return; }
      const index = indexOf(row);
      // The index and the sealed stages are in the same order: pair them by position, not by name.
      const stages = (opened as { stages: { name: string; content: string }[] }).stages.map((s, i) => {
        const cut = index[i]?.cut === true;
        return { name: s.name, cut, content: contentForFile(s.content, cut) };
      });
      sendFile(res, `raw-trace-${fileSafe(row.requestId)}.json`, { ...factsOf(row, RAW_FACTS), stageIndex: index, stages });
    } catch (error) {
      logger.error('TraceDownload', 'Reading a raw trace for its download failed', error as Error);
      if (!res.headersSent) res.status(500).json({ error: 'download_failed', message: 'The trace could not be read.' });
    }
  });

  return router;
}

/** One stage of a raw trace as its own file (`raw-trace-<request id>-<stage>.json`, or `.txt` for a cut stage). */
async function downloadStage(req: express.Request, res: express.Response, actorId: string, row: any, stage: string): Promise<void> {
  if (!indexOf(row).some((s) => s.name === stage)) { res.status(404).json({ error: 'not_found', message: 'This raw trace has no stage of this name.' }); return; }
  const opened = stagesOf(row);
  let problem: Problem | undefined = 'problem' in opened ? opened.problem : undefined;
  const found = problem ? undefined : (opened as { stages: { name: string; content: string }[] }).stages.find((s) => s.name === stage);
  if (!problem && !found) problem = 'malformed';
  await audit(actorId, 'raw.trace.download', 'RawTrace', row.ID, problem, { requestId: row.requestId, stage }, context(req));
  if (problem) { refused(res, problem); return; }
  sendStage(res, `raw-trace-${fileSafe(row.requestId)}-${fileSafe(stage)}`, found!.content);
}

export const traceDownloadRouter: express.Router = createTraceDownloadRouter();
