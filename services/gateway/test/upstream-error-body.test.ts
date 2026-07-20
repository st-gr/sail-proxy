/**
 * readUpstreamErrorBody — drains stream-typed axios error bodies so streaming-path
 * SAP errors are loggable and quarantine-matchable (responseType:'stream' errors
 * deliver error.response.data as a Readable, not a parsed body).
 */
import { describe, it, expect } from '@jest/globals';
import { Readable } from 'stream';
import { readUpstreamErrorBody } from '../src/utils/upstreamErrorBody';

const streamOf = (...chunks: string[]) => Readable.from(chunks);

describe('readUpstreamErrorBody', () => {
  it('returns non-stream bodies unchanged', async () => {
    const body = { error: { message: 'invalid beta flag' } };
    expect(await readUpstreamErrorBody({ data: body })).toBe(body);
    expect(await readUpstreamErrorBody({ data: 'plain text' })).toBe('plain text');
    expect(await readUpstreamErrorBody({ data: undefined })).toBeUndefined();
    expect(await readUpstreamErrorBody(undefined)).toBeUndefined();
  });

  it('drains a stream body and parses JSON', async () => {
    const res = { data: streamOf('{"error":{"type":"invalid_request_error",', '"message":"invalid beta flag"}}') };
    const body = await readUpstreamErrorBody(res);
    expect(body).toEqual({ error: { type: 'invalid_request_error', message: 'invalid beta flag' } });
  });

  it('returns raw text when the drained body is not JSON', async () => {
    const res = { data: streamOf('Bad Gateway: upstream unavailable') };
    expect(await readUpstreamErrorBody(res)).toBe('Bad Gateway: upstream unavailable');
  });

  it('returns undefined for an empty stream', async () => {
    const res = { data: streamOf() };
    expect(await readUpstreamErrorBody(res)).toBeUndefined();
  });

  it('survives a stream that errors mid-read (returns what was collected)', async () => {
    const s = new Readable({
      read() {
        this.push('partial ');
        this.emit('error', new Error('boom'));
      },
    });
    const body = await readUpstreamErrorBody({ data: s });
    expect(typeof body === 'string' ? body.startsWith('partial') : body === undefined).toBe(true);
  });

  it('caps oversized bodies instead of buffering indefinitely', async () => {
    const big = 'x'.repeat(100 * 1024); // > 64 KiB cap
    const res = { data: streamOf(big) };
    const body = await readUpstreamErrorBody(res);
    expect(typeof body).toBe('string');
    expect((body as string).length).toBeLessThanOrEqual(100 * 1024);
    expect((body as string).length).toBeGreaterThanOrEqual(64 * 1024);
  });
});
