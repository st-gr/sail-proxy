/**
 * Runs the gateway's Express admission middlewares (unified auth, service auth, quota
 * enforcement) against a WebSocket upgrade request, which never enters Express. The request is
 * the raw IncomingMessage extended with what the middlewares read; the response is a recording
 * shim; a recorded refusal is written to the raw socket as a complete HTTP/1.1 response.
 */
import { IncomingMessage, STATUS_CODES } from 'http';

export interface RecordedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  finished: boolean;
}

export type Middleware = (req: any, res: any, next: (err?: unknown) => void) => unknown;

export interface UpgradeRequest extends IncomingMessage {
  originalUrl: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, never>;
  params: Record<string, never>;
  ip: string;
  protocol: string;
  debugRequestId: string;
  get(name: string): string | undefined;
  header(name: string): string | undefined;
}

/** Same request-id shape as the Express request-context middleware in index.ts. */
function newRequestId(): string {
  return `gateway-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function prepareUpgradeRequest(req: IncomingMessage): UpgradeRequest {
  const r = req as UpgradeRequest;
  const rawUrl = req.url || '/';
  const url = new URL(rawUrl, 'http://localhost');
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => { if (!(key in query)) query[key] = value; });
  r.originalUrl = rawUrl;
  r.path = url.pathname;
  r.query = query;
  r.body = {};
  r.params = {};
  r.ip = req.socket?.remoteAddress || '';
  r.protocol = 'http';
  r.debugRequestId = newRequestId();
  const header = (name: string): string | undefined => {
    const value = req.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value.join(', ') : value;
  };
  r.get = header;
  r.header = header;
  return r;
}

/** The subset of express.Response the admission middlewares call, recording instead of writing. */
export function createRecordingResponse(onFinish?: () => void): any {
  const recorded: RecordedResponse = { statusCode: 200, headers: {}, body: '', finished: false };
  const finish = () => {
    const first = !recorded.finished;
    recorded.finished = true;
    if (first) onFinish?.();
  };
  const res: any = {
    recorded,
    locals: {},
    headersSent: false,
    get statusCode() { return recorded.statusCode; },
    set statusCode(code: number) { recorded.statusCode = code; },
    status(code: number) { recorded.statusCode = code; return res; },
    setHeader(name: string, value: string | number | string[]) {
      recorded.headers[String(name).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      return res;
    },
    getHeader(name: string) { return recorded.headers[String(name).toLowerCase()]; },
    removeHeader(name: string) { delete recorded.headers[String(name).toLowerCase()]; },
    set(field: string | Record<string, unknown>, value?: unknown) {
      if (typeof field === 'object') for (const [k, v] of Object.entries(field)) res.setHeader(k, v as string);
      else res.setHeader(field, value as string);
      return res;
    },
    json(body: unknown) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      recorded.body = JSON.stringify(body);
      finish();
      return res;
    },
    send(body: unknown) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) { recorded.body = body.toString(); finish(); return res; }
      return res.json(body);
    },
    end(body?: unknown) {
      if (body != null) recorded.body = String(body);
      finish();
      return res;
    },
  };
  res.header = res.set;
  return res;
}

/**
 * 'next' = admitted. 'refused' = the middleware wrote a response (or called next(err) / threw,
 * recorded as a 500). Settles exactly once, whichever happens first.
 */
export function runMiddleware(mw: Middleware, req: any): Promise<{ outcome: 'next' | 'refused'; recorded: RecordedResponse }> {
  return new Promise((resolve) => {
    let settled = false;
    let res: any;
    const settle = (outcome: 'next' | 'refused') => {
      if (settled) return;
      settled = true;
      resolve({ outcome, recorded: res.recorded });
    };
    res = createRecordingResponse(() => settle('refused'));
    const next = (err?: unknown) => {
      if (err) {
        if (!res.recorded.finished) res.status(500).json({ error: { type: 'server_error', message: err instanceof Error ? err.message : String(err) } });
        return;
      }
      settle('next');
    };
    Promise.resolve().then(() => mw(req, res, next)).catch((err) => next(err ?? new Error('middleware failed')));
  });
}

/** A refusal the handler composes itself (404 model_not_found, 502 upstream …). */
export function refusal(statusCode: number, body: unknown, headers: Record<string, string> = {}): RecordedResponse {
  return { statusCode, headers: { ...headers }, body: JSON.stringify(body), finished: true };
}

/** Writes the recorded refusal to the raw socket as one HTTP/1.1 response and ends it. */
export function writeRefusal(socket: { writable: boolean; end(data: Buffer): unknown; destroy(): unknown }, recorded: RecordedResponse): void {
  if (!socket.writable) { socket.destroy(); return; }
  const body = Buffer.from(recorded.body || '', 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    ...recorded.headers,
    'content-length': String(body.length),
    connection: 'close',
  };
  const head = [
    `HTTP/1.1 ${recorded.statusCode} ${STATUS_CODES[recorded.statusCode] || 'Error'}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '', '',
  ].join('\r\n');
  socket.end(Buffer.concat([Buffer.from(head, 'latin1'), body]));
}
