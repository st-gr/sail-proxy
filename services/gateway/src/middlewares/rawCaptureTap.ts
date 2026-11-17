/**
 * The raw capture tap. createUnifiedTokenAuth chains it after a successful authentication while a raw
 * capture session runs, so a request refused by authentication is never captured and one refused later
 * (quota, policy, model access) is. For a request of a credential in a session it opens the collector,
 * records the arrival (`00_arrival`), keeps the bytes the client receives (`zz_client_response`, recorded
 * when the response has finished or the client went away) and closes the collector a grace period later,
 * so stages the request still saves after the client's response (a stream's upstream summary) land too.
 *
 * Captured: inference calls, i.e. POST requests with a JSON body. Not captured: file uploads, the Files,
 * Uploads and Vector Store routes, model lists, the model cache clear and realtime (WebSocket) sessions.
 *
 * @see ../services/rawCapture.ts
 */
import { Request, Response, NextFunction } from 'express';
import { credentialIdOf } from '../utils/usageTracker';
import { getCachedConfig, payloadCaptureSettings } from '../services/configService';
import { rawCaptureRunning, activeSessionAt, openCollector, recordStage, recordClientResponse, closeCollectorAfter } from '../services/rawCapture';
import securityEventEmitter from '../services/securityEventEmitter';

/** How long after the client's response a request's late stages are still collected. Nothing waits for it. */
export const RAW_CAPTURE_CLOSE_GRACE_MS = 2000;

// Checked only for a request of a credential in a session.
const NOT_CAPTURED_PATH = /\/(files|uploads|vector_stores)(\/|$)|^\/(openai\/)?v1\/models\/cache\/clear\/?$/i;

function capturable(req: Request): boolean {
  if (req.method !== 'POST' || req.headers.upgrade) return false;
  if (typeof req.is === 'function' && req.is('multipart/*')) return false;
  return !NOT_CAPTURED_PATH.test((req.originalUrl || req.url || '').split('?')[0]);
}

export function rawCaptureTap(req: Request, res: Response, next: NextFunction): void {
  if (!rawCaptureRunning()) return next();
  const credentialId = credentialIdOf(req);
  const session = activeSessionAt(credentialId, Date.now());
  if (!session || credentialId === undefined || !capturable(req)) return next();

  const requestId = (req as any).debugRequestId;
  if (typeof requestId !== 'string') return next();
  const limits = payloadCaptureSettings(getCachedConfig()).raw;
  if (!openCollector(requestId, session.id, credentialId, limits)) return next();

  // The light trace reports the request as raw (services/payloadTrace.ts).
  (req as any).__rawCaptureSessionId = session.id;
  recordStage(requestId, '00_arrival', req.body, req);
  keepClientBytes(res, requestId, limits.stageMaxBytes);
  next();
}

/** Wraps res.write and res.end to keep what the client receives, at most `maxBytes` of it (all of it is counted). */
function keepClientBytes(res: Response, requestId: string, maxBytes: number): void {
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let bytesSent = 0;
  const keep = (chunk: unknown, encoding: unknown): void => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    try {
      const buffer = typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
        : Buffer.from(chunk as Uint8Array); // a copy: the caller may reuse its buffer
      bytesSent += buffer.length;
      if (keptBytes < maxBytes) {
        const part = buffer.subarray(0, maxBytes - keptBytes);
        kept.push(part);
        keptBytes += part.length;
      }
    } catch {
      // Whatever the chunk is, the client still gets it; the stage only misses it.
    }
  };

  const write = res.write;
  const end = res.end;
  res.write = function (this: Response, chunk: any, ...rest: any[]) {
    keep(chunk, rest[0]);
    return (write as any).call(this, chunk, ...rest);
  } as any;
  res.end = function (this: Response, chunk?: any, ...rest: any[]) {
    keep(chunk, rest[0]);
    return (end as any).call(this, chunk, ...rest);
  } as any;

  let closed = false;
  // Runs in a 'finish' / 'close' listener and a timer: a throw there would be an uncaught exception.
  const close = (complete: boolean): void => {
    if (closed) return;
    closed = true;
    try {
      recordClientResponse(requestId, res, Buffer.concat(kept).toString('utf8'), bytesSent, complete);
    } catch {
      securityEventEmitter.countDroppedRawTrace();
    }
    closeCollectorAfter(requestId, RAW_CAPTURE_CLOSE_GRACE_MS, { statusCode: res.statusCode, complete });
  };
  res.once('finish', () => close(true));
  // After 'finish' a no-op; before it the client went away mid-response.
  res.once('close', () => close(res.writableFinished));
}
