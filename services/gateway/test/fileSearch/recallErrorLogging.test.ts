/**
 * FINAL WHOLE-BRANCH REVIEW, CRITICAL #1 — the SECOND of the two log lines that carried the
 * caller's filter value.
 *
 * `descriptor.ts`'s catch (covered in test/responses-filesearch-error-gate.test.ts) logged
 * it at WARN. This one, in `recallCandidates`, logged it at ERROR, and logged it twice
 * over: once interpolated into the message, and once again inside the error OBJECT handed
 * to `logger.error`'s third parameter, which the logger serializes as
 * `{name, message, stack}`.
 *
 * The stack is the half that a careless redaction misses. V8 builds `stack` as
 * `${name}: ${message}\n    at …`, so passing the original error through after replacing
 * only the message string still ships the message — in the stack's first line.
 *
 * @see ../../src/fileSearch/repository.ts - driverErrorCode / redactDriverError
 * @see ./ordinalFilterValue.test.ts - the helpers in isolation, and the 400 that now
 *      prevents this particular error from being raised at all
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const loggerError = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...args: any[]) => loggerError(...args),
    warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const poolQuery = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({ query: (...a: any[]) => poolQuery(...a) }),
}));

jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => ({
    embeddingDimensions: 3,
    hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 },
  }),
}));

import { recallCandidates } from '../../src/fileSearch/repository';

/** The live reproduction's error, verbatim. */
const CALLER_VALUE = 'Jane Doe, MRN 4471';
function pgDatabaseError(): any {
  const err: any = new Error(`invalid input syntax for type numeric: "${CALLER_VALUE}"`);
  err.name = 'error';
  err.code = '22P02';
  return err;
}

/** Everything handed to `logger.error` this run, flattened to one searchable string —
 *  including the Error object's own fields, because that is what the logger serializes. */
function loggedText(): string {
  return loggerError.mock.calls
    .map((args: any[]) => args.map((a) => {
      if (a instanceof Error) return `${a.name}|${a.message}|${a.stack}`;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' '))
    .join('\n');
}

const recall = () => recallCandidates({
  storeIds: ['vs_1'],
  ownerEmail: 'owner@example.com',
  queryText: 'hello world',
  queryEmbedding: [1, 0, 0],
});

beforeEach(() => {
  poolQuery.mockReset();
  loggerError.mockReset();
});

describe('recallCandidates never logs a driver error\'s message', () => {
  beforeEach(() => { poolQuery.mockRejectedValue(pgDatabaseError()); });

  it('keeps the caller\'s value out of every argument the logger receives', async () => {
    await expect(recall()).rejects.toBeDefined();

    expect(loggerError).toHaveBeenCalled();
    const logged = loggedText();
    expect(logged).not.toContain(CALLER_VALUE);
    expect(logged).not.toContain('Jane');
    expect(logged).not.toContain('invalid input syntax');
  });

  it('keeps it out of the STACK too, where the message reappears as the first line', async () => {
    await expect(recall()).rejects.toBeDefined();

    const errorArg = loggerError.mock.calls[0][2] as Error;
    expect(errorArg).toBeInstanceOf(Error);
    expect(errorArg.message).toBe('22P02');
    expect(errorArg.stack).not.toContain(CALLER_VALUE);
    expect(errorArg.stack).not.toContain('invalid input syntax');
    expect(errorArg.stack!.split('\n')[0]).toBe('error: 22P02');
  });

  it('still logs the SQLSTATE and the operational metadata, so the failure is diagnosable', async () => {
    await expect(recall()).rejects.toBeDefined();

    const [component, message, , meta] = loggerError.mock.calls[0] as any[];
    expect(component).toBe('FileSearchRepository');
    expect(message).toContain('22P02');
    expect(meta).toMatchObject({ storeCount: 1, lexicalEnabled: true });
  });

  it('still RETHROWS the original error untouched — redaction is for the log, not the caller', async () => {
    // The engine classifies on the real error; swapping the redacted stand-in into the
    // throw would break `execute`'s `instanceof` dispatch for every genuine failure.
    await expect(recall()).rejects.toMatchObject({
      code: '22P02',
      message: `invalid input syntax for type numeric: "${CALLER_VALUE}"`,
    });
  });
});
