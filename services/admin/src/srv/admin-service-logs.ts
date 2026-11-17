/**
 * GET /api/logs/gateway/export: the stored gateway log as a text file, one line per entry in the
 * console format (`<timestamp> [<request id>] <LEVEL> [<component>] <message>`, then the error).
 * Admin only (admin-caller.ts). The entries are read in pages by key (loggedAt, seq, ID) and written
 * to the response as they are read, so the admin never holds the whole result; at most `maxLines`
 * lines, and when the cap cuts the result the last line says so.
 *
 * The search is the same as the OData `$search` on GatewayLog (gateway-log-search.ts): the whole
 * trimmed text, literally and case-insensitively, in message, component or requestId, on both
 * databases. Range conditions are chained `where` calls (an object with two operators on one field
 * renders without AND on PostgreSQL in cds 8.9.7). Every field written is escaped (exportLine).
 */
import express from 'express';
import { getDefaultLogger } from '@libs/logger';
import { adminOf } from './admin-caller';
import { GATEWAY_LOG_ENTITY } from '../services/gatewayLogIngest';
import { gatewayLogSearchCondition } from './gateway-log-search';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

const MAX_LINES = 100_000;
const PAGE_SIZE = 1000;
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

class BadRequest extends Error {}

/** A query value that is one plain string; absent is undefined; anything else (array, bracketed object) is refused. */
function param(req: express.Request, name: string): string | undefined {
  const value: unknown = (req.query as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequest(`The parameter "${name}" must be given once, as plain text.`);
  return value;
}

function timeParam(req: express.Request, name: string): string | undefined {
  const raw = param(req, name);
  if (raw === undefined || raw === '') return undefined;
  // a "+" in a query string arrives as a space: "…T10:00:00 01:00" is "…T10:00:00+01:00". Only a
  // space AFTER a time of day is one; the space between the date and the time stays.
  const text = raw.trim().replace(/([T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?) (\d{2}:?\d{2})$/, '$1+$2');
  const date = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(text) ? new Date(text) : new Date(NaN);
  if (Number.isNaN(date.getTime())) throw new BadRequest(`The parameter "${name}" must be an ISO 8601 timestamp such as 2026-11-11T10:00:00Z.`);
  return date.toISOString();
}

function levelsFrom(req: express.Request): string[] | undefined {
  const raw = param(req, 'level');
  if (raw === undefined || raw === '') return undefined;
  const at = LEVELS.indexOf(raw.trim().toUpperCase());
  if (at === -1) throw new BadRequest(`The parameter "level" must be one of ${LEVELS.join(', ')}.`);
  return LEVELS.slice(at);
}

// A backslash, the C0 controls, DEL, the C1 controls and the Unicode line and paragraph separators.
const UNSAFE = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const NAMED: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\t': '\\t' };

/**
 * One entry as one line, safe to print to a terminal: a backslash is written as \\, a line break as
 * \n (CRLF and a lone CR too), a tab as \t, every other control character and U+2028/U+2029 as \uXXXX.
 */
export function exportLine(row: any): string {
  const oneLine = (v: unknown): string => String(v ?? '').replace(/\r\n|\r/g, '\n')
    .replace(UNSAFE, (c) => NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const when = new Date(row.loggedAt).toISOString();
  const request = row.requestId ? ` [${oneLine(row.requestId)}]` : '';
  const error = row.error ? ` Error: ${oneLine(row.error)}` : '';
  return `${when}${request} ${oneLine(row.level).padEnd(5)} [${oneLine(row.component)}] ${oneLine(row.message)}${error}`;
}

type Filters = { from?: string; to?: string; levels?: string[]; search?: string };
type Key = { loggedAt: any; seq: any; ID: string };

/** The entries after `after` (by loggedAt, seq, ID), at most `limit`. */
export async function readPage(filters: Filters, after: Key | undefined, limit: number): Promise<any[]> {
  const { SELECT } = cds.ql;
  const q = SELECT.from(GATEWAY_LOG_ENTITY).columns('ID', 'loggedAt', 'seq', 'level', 'component', 'requestId', 'message', 'error')
    .orderBy('loggedAt', 'seq', 'ID').limit(limit);
  if (filters.from) q.where({ loggedAt: { '>=': filters.from } });
  if (filters.to) q.where({ loggedAt: { '<=': filters.to } });
  if (filters.levels) q.where({ level: { in: filters.levels } });
  const search = gatewayLogSearchCondition(filters.search);
  if (search) q.where(search);
  if (after) {
    const col = (name: string) => ({ ref: [name] });
    const val = (v: unknown) => ({ val: v });
    q.where([{ xpr: [
      { xpr: [col('loggedAt'), '>', val(after.loggedAt)] }, 'or',
      { xpr: [col('loggedAt'), '=', val(after.loggedAt), 'and', { xpr: [
        { xpr: [col('seq'), '>', val(after.seq)] }, 'or',
        { xpr: [col('seq'), '=', val(after.seq), 'and', col('ID'), '>', val(after.ID)] }
      ] }] }
    ] }]);
  }
  return cds.tx(async (tx: any) => tx.run(q)); // one short transaction per page, closed before anything is written
}

export function createGatewayLogExportRouter(options: { maxLines?: number; pageSize?: number } = {}): express.Router {
  const maxLines = options.maxLines ?? MAX_LINES;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const router: express.Router = express.Router();

  router.get('/gateway/export', async (req, res) => {
    if (!adminOf(req, res)) return;
    let filters: Filters;
    try {
      filters = { from: timeParam(req, 'from'), to: timeParam(req, 'to'), levels: levelsFrom(req), search: param(req, 'search')?.trim() || undefined };
    } catch (error) {
      if (error instanceof BadRequest) { res.status(400).json({ error: 'bad_request', message: error.message }); return; }
      throw error;
    }

    let closed = false;
    res.on('close', () => { closed = true; });
    // Waits for the first of drain and close: a client that left never drains.
    const write = async (text: string): Promise<void> => {
      if (!text || closed || res.write(text)) return;
      await new Promise<void>((resolve) => {
        const done = (): void => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done);
        res.once('close', done);
      });
    };
    try {
      // maxLines + 1 entries are read to learn whether the cap cuts the result. When it does, the
      // file holds maxLines - 1 entries and the notice, so it never exceeds maxLines lines.
      const wanted = maxLines + 1;
      let page = await readPage(filters, undefined, Math.min(pageSize, wanted));
      res.status(200);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="gateway-log-${new Date().toISOString().slice(0, 10)}.txt"`);
      let read = 0;
      const held: any[] = [];
      while (page.length > 0 && !closed) {
        let out = '';
        for (const r of page) {
          if (read < maxLines - 1) out += `${exportLine(r)}\n`; else held.push(r);
          read++;
        }
        await write(out);
        if (page.length < pageSize || read >= wanted) break;
        if (closed) break;
        const last = page[page.length - 1];
        try {
          page = await readPage(filters, { loggedAt: last.loggedAt, seq: last.seq, ID: last.ID }, Math.min(pageSize, wanted - read));
        } catch (error) {
          // The response has started, so the status cannot change: say in the file that it stops early.
          logger.error('GatewayLogExport', 'Reading a page of the gateway log export failed', error as Error);
          await write('The export stopped here because of an error; the file is incomplete.\n');
          res.end();
          return;
        }
      }
      if (!closed) {
        await write(read <= maxLines
          ? held.map((r) => `${exportLine(r)}\n`).join('')
          : `The export stops here: it is limited to ${maxLines} lines. Narrow the time range or the search to see the rest.\n`);
      }
      res.end();
    } catch (error) {
      logger.error('GatewayLogExport', 'The gateway log export failed', error as Error);
      if (!res.headersSent) res.status(500).json({ error: 'export_failed', message: 'The gateway log could not be read.' });
      else res.end();
    }
  });

  return router;
}

export const gatewayLogExportRouter: express.Router = createGatewayLogExportRouter();
