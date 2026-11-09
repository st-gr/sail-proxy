/**
 * Real streaming for `--deployed` chat models: the deployment's own SSE stream (OpenAI format, as
 * Azure OpenAI sends it) relayed chunk by chunk to the client. Each chunk with choices goes through
 * `transform` (the after-plugins: per-chunk unmasking) before it is written. Frames without choices
 * are not passed on as they are: the prompt-filter frame is dropped, the usage frame is read for
 * billing and forwarded only when the client asked for usage (stream_options.include_usage).
 */
import { Readable } from 'stream';
import { Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import * as sseWriter from '../utils/sseWriter';

const logger = getDefaultLogger();

export interface RelayResult {
  /** The deployment's usage (from its usage frame), or null when it sent none. */
  usage: any | null;
  /** Chunks written to the client. */
  written: number;
  /** Set when the upstream stream failed before it ended. */
  error?: Error;
}

export interface RelayOptions {
  upstream: Readable;
  res: Response;
  transform: (chunk: any) => Promise<any>;
  clientWantsUsage: boolean;
}

/** Fields of the deployment's chunks that describe its own infrastructure, not the answer. */
const INTERNAL_FIELDS = ['routing', 'latency_checkpoint', 'obfuscation'];

/** The chunk without the deployment's internal fields. */
function clientCopy(chunk: any): any {
  if (!chunk || typeof chunk !== 'object') return chunk;
  const copy = { ...chunk };
  for (const field of INTERNAL_FIELDS) delete copy[field];
  return copy;
}

/** The `data:` payload of one SSE event (several data lines join with a newline), or null. */
function dataOf(event: string): string | null {
  const lines = event.split(/\r?\n/).filter((line) => line.startsWith('data:'));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
}

export async function relayDeployedStream({ upstream, res, transform, clientWantsUsage }: RelayOptions): Promise<RelayResult> {
  const result: RelayResult = { usage: null, written: 0 };
  let buffered = '';
  let done = false;

  const handle = async (data: string): Promise<void> => {
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      logger.warn('deployedStreamRelay', 'Skipped an upstream SSE frame that is not JSON');
      return;
    }
    if (chunk?.usage) result.usage = chunk.usage;
    if (!Array.isArray(chunk?.choices) || chunk.choices.length === 0) {
      // The usage frame goes to clients that asked for it; the prompt-filter frame to nobody.
      if (chunk?.usage && clientWantsUsage) {
        sseWriter.writeChunk(res, JSON.stringify(clientCopy(chunk)));
        result.written++;
      } else if (chunk?.error) {
        sseWriter.writeChunk(res, JSON.stringify(chunk));
        result.written++;
      }
      return;
    }
    const out = await transform(chunk);
    sseWriter.writeChunk(res, JSON.stringify(clientCopy(out)));
    result.written++;
  };

  try {
    const decoder = new TextDecoder();
    for await (const piece of upstream) {
      buffered += typeof piece === 'string' ? piece : decoder.decode(piece, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffered))) {
        const event = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary[0].length);
        const data = dataOf(event);
        if (data !== null) await handle(data);
      }
    }
    const rest = dataOf(buffered.trim());
    if (rest !== null && buffered.trim()) await handle(rest);
  } catch (error: any) {
    result.error = error instanceof Error ? error : new Error(String(error));
    logger.warn('deployedStreamRelay', `The deployment's stream broke off: ${result.error.message}`);
    sseWriter.writeError(res, { error: { message: `The deployment's stream broke off: ${result.error.message}`, type: 'upstream_error' } });
    if (!res.writableEnded) res.end();
    return result;
  }
  if (!done) logger.debug('deployedStreamRelay', 'The deployment ended its stream without [DONE]');
  sseWriter.writeDone(res);
  return result;
}
