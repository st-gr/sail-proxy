// Worker-thread entry of the PowerPoint/Excel reader (ooxmlThread.ts starts it). Imports the
// reader only — no logger, no configuration, no path aliases — so it loads as plain compiled
// JavaScript next to this file, or through ts-node when the gateway runs from TypeScript.
import { parentPort } from 'worker_threads';
import { DocumentReadError, OoxmlLimits } from './limits';
import { readPptx } from './pptx';
import { readXlsx } from './xlsx';
import { ExtractionTimeoutError } from '../runners';

export interface OfficeReadRequest {
  format: 'pptx' | 'xlsx';
  /** The file's bytes (a copy transferred to this thread). */
  bytes: ArrayBuffer;
  timeoutMs?: number;
  limits?: Partial<OoxmlLimits>;
}

export type OfficeReadReply =
  | { ok: true; text: string; elapsedMs: number }
  | { ok: false; error: 'document'; kind: DocumentReadError['kind']; reason: string }
  | { ok: false; error: 'timeout' }
  | { ok: false; error: 'other'; message: string };

parentPort?.on('message', async (request: OfficeReadRequest) => {
  const started = Date.now();
  let reply: OfficeReadReply;
  try {
    const read = request.format === 'pptx' ? readPptx : readXlsx;
    const text = await read(Buffer.from(request.bytes), { timeoutMs: request.timeoutMs, limits: request.limits });
    reply = { ok: true, text, elapsedMs: Date.now() - started };
  } catch (error: any) {
    if (error instanceof DocumentReadError) reply = { ok: false, error: 'document', kind: error.kind, reason: error.reason };
    else if (error instanceof ExtractionTimeoutError) reply = { ok: false, error: 'timeout' };
    else reply = { ok: false, error: 'other', message: String(error?.message ?? error) };
  }
  parentPort!.postMessage(reply);
});

// Loaded: the main thread counts a failure before this as "cannot start".
parentPort?.postMessage({ ready: true });
