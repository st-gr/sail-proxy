/**
 * FINAL WHOLE-BRANCH REVIEW, CRITICAL #2 — a NUL byte in `attributes`/`metadata` reaching
 * Postgres as an unhandled 500.
 *
 * THE COMMENT THAT WAS WRONG. `parseOptionalName` guarded `name` against a NUL and
 * justified NOT guarding `metadata`/`attributes` on the grounds that "JSON.stringify
 * escapes an embedded NUL byte to a six-character escape sequence, which is why those two
 * are safe without this check". The first half is true and the conclusion does not follow.
 * Confirmed live against pgvector:
 *
 *     JSON.stringify -> {"dept":"leg\u0000al"}
 *     jsonb REJECTED    code=22P05  unsupported Unicode escape sequence
 *     err.status        undefined
 *
 * `jsonb` stores DECODED text, so it rejects the `\u0000` escape specifically — the escape
 * is exactly the thing it cannot represent. No `status` means no mapping in
 * `handleKnownError`, so it falls through to `next(err)` and the caller gets a 500 for
 * what is plainly a malformed request.
 *
 * `nulByteGuard` does not cover this: that middleware scans `file_ids`, `file_id` and
 * `vector_store_ids` only.
 *
 * WHY THIS SUITE DRIVES THE CONTROLLERS. A unit call on `validateAttributes` alone would
 * not have caught the original defect — `validateAttributes` was being called, and passed;
 * the bug was that the four entry points below then bound its output into `jsonb`. What
 * has to be pinned is the STATUS the caller sees at each entry point, which is why every
 * test here goes through a handler and asserts 400 rather than asserting a throw.
 *
 * The real-Postgres proof that the un-guarded payload is a 500 and not merely a different
 * 400 lives in test/fileSearch/integration/attributeNulByte.test.ts.
 *
 * `test/fileSearch/vectorStoresController.test.ts` is deliberately not extended: the fix
 * wave was allowed to touch it only to delete the false comment it had inherited.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const loggerError = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...args: any[]) => loggerError(...args),
    warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const dbState: { available: boolean } = { available: true };
const poolQuery: any = jest.fn();
jest.mock('../../src/fileSearch/db', () => ({
  isFileSearchAvailable: () => dbState.available,
  getPool: () => ({ query: poolQuery }),
}));

jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({
    embeddingModel: 'text-embedding-3-large',
    embeddingDimensions: 1536,
    limits: { maxFilesPerStore: 10000 },
  }),
}));

jest.mock('../../src/fileSearch/repository', () => {
  // `validateAttributes` stays REAL — it is the function under test. Only the
  // DB-touching primitives are stubbed, so "the store was never created" is a
  // meaningful assertion.
  const actual: any = jest.requireActual('../../src/fileSearch/repository');
  return { ...actual, createStore: jest.fn(), attachFile: jest.fn(), enqueueIngestion: jest.fn() };
});

import * as vectorStoresController from '../../src/controllers/vectorStoresController';
import { validateAttributes, createStore, attachFile } from '../../src/fileSearch/repository';

const mockCreateStore = createStore as any;
const mockAttachFile = attachFile as any;

/** Built via fromCharCode, never a literal escape, so no raw NUL byte lives in this file
 *  — the same reasoning as every NUL_BYTE constant in `src/`. */
const NUL = String.fromCharCode(0);

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  res.set = jest.fn(() => res);
  res.send = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}

function baseReq(overrides: Record<string, any> = {}): any {
  return {
    headers: {}, params: {}, query: {}, body: {},
    apiKeyInfo: { email: 'owner@example.com' },
    ...overrides,
  };
}

const STORE_ID = 'vs_aaaaaaaaaaaaaaaaaaaaaaaa';
const FILE_ID = 'file-aaaaaaaaaaaaaaaaaaaaaaaa';

beforeEach(() => {
  dbState.available = true;
  poolQuery.mockReset();
  mockCreateStore.mockReset();
  mockAttachFile.mockReset();
  loggerError.mockReset();
});

/**
 * All four entry points `validateAttributes` guards. Each is asserted on the STATUS, the
 * error `code`, and on the database never having been reached — a handler that rejected
 * with the right code only after issuing its UPDATE would still have shipped the payload.
 */
describe('a NUL byte in attributes/metadata is a 400 at every entry point, never a 500', () => {
  it('createVectorStore: metadata VALUE containing a NUL is rejected, no store created', async () => {
    const req = baseReq({ body: { name: 'ok', metadata: { dept: `leg${NUL}al` } } });
    const res = makeRes();

    await vectorStoresController.createVectorStore(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_attributes');
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(mockCreateStore).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('createVectorStore: metadata KEY containing a NUL is rejected too', async () => {
    // The key is bound into the same jsonb document and is just as unrepresentable.
    const req = baseReq({ body: { metadata: { [`de${NUL}pt`]: 'legal' } } });
    const res = makeRes();

    await vectorStoresController.createVectorStore(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_attributes');
    expect(mockCreateStore).not.toHaveBeenCalled();
  });

  it('modifyVectorStore: metadata containing a NUL is rejected before the UPDATE runs', async () => {
    const req = baseReq({ params: { id: STORE_ID }, body: { metadata: { a: `x${NUL}y` } } });
    const res = makeRes();

    await vectorStoresController.modifyVectorStore(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_attributes');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('createVectorStoreFile: attributes containing a NUL is rejected before the store lookup', async () => {
    const req = baseReq({ params: { id: STORE_ID }, body: { file_id: FILE_ID, attributes: { a: `x${NUL}y` } } });
    const res = makeRes();

    await vectorStoresController.createVectorStoreFile(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_attributes');
    expect(mockAttachFile).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('modifyVectorStoreFile: attributes containing a NUL is rejected before the UPDATE runs', async () => {
    const req = baseReq({
      params: { id: STORE_ID, file_id: FILE_ID },
      body: { attributes: { a: `x${NUL}y` } },
    });
    const res = makeRes();

    await vectorStoresController.modifyVectorStoreFile(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_attributes');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('never calls next() — a 500 through the error middleware is the defect, not the fix', async () => {
    // The original bug's signature: the driver error carries no `status`, so
    // `handleKnownError` falls through to `next(err)` and the client gets a 500. If this
    // guard is removed the handler proceeds, and against a real pool this is exactly the
    // path that fires.
    const next = jest.fn();
    const res = makeRes();

    await vectorStoresController.createVectorStore(
      baseReq({ body: { metadata: { dept: `leg${NUL}al` } } }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });
});

describe('the guard is narrow — only a NUL, and only where one can appear', () => {
  it('accepts the six-character LITERAL "\\u0000", which is not a NUL byte', () => {
    // A caller may legitimately send the backslash-u-zero-zero-zero-zero text. It survives
    // JSON round-tripping as six ordinary characters and jsonb stores it happily; a guard
    // that string-matched the escape instead of the byte would break this.
    expect(validateAttributes({ note: '\\u0000' })).toEqual({ note: '\\u0000' });
  });

  it('accepts other control characters, which jsonb represents fine', () => {
    // Only U+0000 is unrepresentable. Widening the check to "any control character" would
    // reject data OpenAI accepts.
    const value = `a${String.fromCharCode(1)}b${String.fromCharCode(31)}c`;
    expect(validateAttributes({ note: value })).toEqual({ note: value });
  });

  it('leaves number and boolean values untouched — they cannot carry a byte at all', () => {
    expect(validateAttributes({ n: 42, b: true })).toEqual({ n: 42, b: true });
  });

  it('does not echo the offending key or value into the message', () => {
    // This message is returned to the caller AND logged. Interpolating the value would put
    // a raw NUL into both, and interpolating the key does the same when the key is what
    // carries it.
    expect(() => validateAttributes({ [`de${NUL}pt`]: 'x' })).toThrow(/keys must not contain a NUL byte/);
    try {
      validateAttributes({ [`de${NUL}pt`]: 'x' });
    } catch (err: any) {
      expect(err.message).not.toContain(NUL);
    }
  });

  it('names the offending key for a VALUE-side NUL, which carries no NUL itself', () => {
    expect(() => validateAttributes({ dept: `x${NUL}y` })).toThrow(/"dept" must not contain a NUL byte/);
  });
});
