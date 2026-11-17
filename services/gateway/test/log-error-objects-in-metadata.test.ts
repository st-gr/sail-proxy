/**
 * Metadata is printed on the console as JSON. An HTTP client's error object serialises its
 * request configuration, Authorization header included, and a stream cannot be serialised at
 * all: neither may be handed to the logger as metadata.
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { Readable } from 'stream';
import { writeError } from '../src/utils/sseWriter';
import { loggableBody } from '../src/utils/upstreamErrorLogText';

// Invented: bearer-shaped, not a credential.
const FAKE_BEARER = 'Bearer FAKE-TOKEN-for-log-tests-0123456789';

const axiosLike = (): Error => Object.assign(new Error('Request failed with status code 401'), {
  name: 'AxiosError', code: 'ERR_BAD_REQUEST',
  config: { headers: { Authorization: FAKE_BEARER } },
  toJSON(): any { return { message: 'Request failed with status code 401', config: { headers: { Authorization: FAKE_BEARER } } }; },
});

describe('error objects and streams never reach the metadata serialiser', () => {
  const saved = process.env.DEBUG;
  afterEach(() => { jest.restoreAllMocks(); if (saved === undefined) delete process.env.DEBUG; else process.env.DEBUG = saved; });

  it("sseWriter's DEBUG line logs the error's name, message and code, not the object", () => {
    process.env.DEBUG = 'true';
    const lines: string[] = [];
    for (const m of ['debug', 'info'] as const) jest.spyOn(console, m).mockImplementation((l: unknown) => { lines.push(String(l)); });
    const { getDefaultLogger } = jest.requireActual('@libs/logger') as any;
    getDefaultLogger().applyLoggingConfig({ defaultLevel: 'debug' });
    try {
      const res: any = { writable: true, writableEnded: false, headersSent: true, write: () => true, end: () => {}, setHeader: () => {} };
      writeError(res, axiosLike());
    } finally {
      getDefaultLogger().applyLoggingConfig(undefined);
    }
    const line = lines.find((l) => l.includes('Writing SSE error'));
    expect(line).toBeDefined();
    expect(line).toContain('Request failed with status code 401');
    expect(line).toContain('ERR_BAD_REQUEST');
    expect(line).not.toContain('FAKE-TOKEN');
  });

  it('loggableBody: plain values pass, a stream or an error object becomes a short placeholder', () => {
    expect(loggableBody({ error: { message: 'x' } })).toEqual({ error: { message: 'x' } });
    expect(loggableBody('text body')).toBe('text body');
    expect(loggableBody(undefined)).toBeUndefined();
    expect(loggableBody(Readable.from(['a']))).toBe('[Readable not read]');
    expect(JSON.stringify(loggableBody(axiosLike()))).not.toContain('FAKE-TOKEN');
  });
});
