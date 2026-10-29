/**
 * sseWriter.writeError: every input shape a gateway caller passes becomes an OpenAI-style error
 * frame `{"error":{"message","type","code"}}` with the real message text. A plain
 * `{ message, type }` object (openaiController's retry and chunk-error frames) used to fall
 * through to String(err) and reach the client as "[object Object]".
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import { writeError } from '../src/utils/sseWriter';

function mockRes() {
  const r: any = { writable: true, writableEnded: false, chunks: [] as string[] };
  r.write = (s: string) => { r.chunks.push(s); return true; };
  r.end = () => { r.writableEnded = true; };
  return r;
}

function frameOf(err: any): any {
  const res = mockRes();
  writeError(res, err);
  expect(res.chunks).toHaveLength(1);
  expect(res.chunks[0].startsWith('data: ')).toBe(true);
  expect(res.chunks[0].endsWith('\n\n')).toBe(true);
  expect(res.writableEnded).toBe(true);
  return JSON.parse(res.chunks[0].slice('data: '.length));
}

describe('sseWriter.writeError input shapes', () => {
  it('string: unchanged frame', () => {
    expect(frameOf('plain failure')).toEqual({ error: { message: 'plain failure' } });
  });

  it('Error: unchanged frame (message, api_error, status or 500)', () => {
    expect(frameOf(new Error('boom'))).toEqual({ error: { message: 'boom', type: 'api_error', code: 500 } });
    expect(frameOf(Object.assign(new Error('slow down'), { status: 429 })))
      .toEqual({ error: { message: 'slow down', type: 'api_error', code: 429 } });
  });

  it('already formatted { error: {...} }: passed through unchanged', () => {
    const formatted = { error: { message: 'x', type: 'sap_ai_core_error', code: 502 } };
    expect(frameOf(formatted)).toEqual(formatted);
  });

  it('{ message, type }: the real message and type, code null', () => {
    expect(frameOf({ message: 'Error in emulation: upstream unavailable', type: 'processing_error' }))
      .toEqual({ error: { message: 'Error in emulation: upstream unavailable', type: 'processing_error', code: null } });
  });

  it('{ message, type, code, details }: message/type/code only, the raw details are not forwarded', () => {
    const frame = frameOf({ message: 'rate limited', type: 'sap_ai_core_error', code: 429, details: { raw: 'upstream body', token: 'secret-value' } });
    expect(frame).toEqual({ error: { message: 'rate limited', type: 'sap_ai_core_error', code: 429 } });
    expect(JSON.stringify(frame)).not.toContain('secret-value');
  });

  it('{ message } without type: defaults type to api_error', () => {
    expect(frameOf({ message: 'odd failure' })).toEqual({ error: { message: 'odd failure', type: 'api_error', code: null } });
  });

  it('axios-style error with response.data.error: the upstream error message, type and status', () => {
    const axiosErr = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { error: { message: 'max_tokens is too large', type: 'invalid_request_error' } }, headers: { authorization: 'Bearer secret-value' } },
      config: { headers: { Authorization: 'Bearer secret-value' } },
    });
    const frame = frameOf(axiosErr);
    expect(frame).toEqual({ error: { message: 'max_tokens is too large', type: 'invalid_request_error', code: 400 } });
    expect(JSON.stringify(frame)).not.toContain('secret-value');
  });

  it('axios-style error with a string response.data.error', () => {
    expect(frameOf(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503, data: { error: 'service unavailable' } } })))
      .toEqual({ error: { message: 'service unavailable', type: 'api_error', code: 503 } });
  });

  it('an object with no usable message: a generic message, never "[object Object]" or the raw object', () => {
    const frame = frameOf({ weird: { apiKey: 'secret-value' } });
    expect(frame.error.message).not.toBe('[object Object]');
    expect(JSON.stringify(frame)).not.toContain('secret-value');
  });
});
