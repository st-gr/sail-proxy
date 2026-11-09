/**
 * filesController: availability guard, purpose validation, 404-not-403
 * ownership scoping, dedup opacity, and streaming size enforcement.
 * All dependencies (db, blobStore, configService) are mocked; sha256Of is
 * the real implementation so hashes in assertions are meaningful.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Readable } from 'stream';
import * as crypto from 'crypto';

const loggerError = jest.fn();
const loggerDebug = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...args: any[]) => loggerError(...args),
    warn: jest.fn(), info: jest.fn(),
    debug: (...args: any[]) => loggerDebug(...args),
    trace: jest.fn(),
  }),
}));

const dbState: { available: boolean } = { available: true };
const poolQuery: any = jest.fn();
jest.mock('../../src/fileSearch/db', () => ({
  isFileSearchAvailable: () => dbState.available,
  // deleteFile runs in a transaction on a connected client: the same query mock serves both.
  getPool: () => ({ query: poolQuery, connect: async () => ({ query: poolQuery, release: () => {} }) }),
}));

jest.mock('../../src/fileSearch/blob/blobStore', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/blob/blobStore');
  return {
    sha256Of: actual.sha256Of,
    // The REAL class, not a stand-in: filesController narrows on it with
    // `instanceof`, so a mocked-away constructor would make that check
    // vacuously false (or throw) and the 503 mapping untestable.
    UnsupportedBlobBackendError: actual.UnsupportedBlobBackendError,
    BlobUnavailableError: actual.BlobUnavailableError,
    retainBlob: jest.fn(),
    releaseBlob: jest.fn(),
    releaseBlobIn: jest.fn(),
    openBlob: jest.fn(),
  };
});

// DELETE /files/{id} detaches the file from every store and deletes it in one transaction; that
// transaction is the repository's (covered against a real database in the integration suites).
const detachingDelete: any = jest.fn();
jest.mock('../../src/fileSearch/repository', () => ({
  deleteFileDetachingEverywhere: (...args: any[]) => detachingDelete(...args),
}));

const configState: { maxFileBytes: number } = { maxFileBytes: 33554432 };
jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({ limits: { maxFileBytes: configState.maxFileBytes } }),
}));

import * as filesController from '../../src/controllers/filesController';
import {
  retainBlob, releaseBlob, releaseBlobIn, openBlob, UnsupportedBlobBackendError, BlobUnavailableError,
} from '../../src/fileSearch/blob/blobStore';

const mockRetainBlob = retainBlob as any;
const mockReleaseBlob = releaseBlob as any;
const mockReleaseBlobIn = releaseBlobIn as any;
const mockOpenBlob = openBlob as any;

/** The SQL statements the controller sent, in order (BEGIN/COMMIT/ROLLBACK included). */
const sqlSent = (): string[] => poolQuery.mock.calls.map((c: any[]) => String(c[0]));

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  res.set = jest.fn((..._args: any[]) => res);
  res.send = jest.fn((body: any) => { res.body = body; return res; });
  // The tooLarge branch registers `res.once('finish', ...)` (B11: destroy the
  // request only once the 413 has actually been flushed) — a no-op here since
  // this mock never actually finishes a response.
  res.once = jest.fn((..._args: any[]) => res);
  return res;
}

function baseReq(overrides: Record<string, any> = {}): any {
  return {
    headers: {},
    params: {},
    query: {},
    apiKeyInfo: { email: 'owner@example.com' },
    ...overrides,
  };
}

function buildMultipartBody(boundary: string, opts: {
  filename?: string; content: Buffer; contentType?: string; purpose?: string | null; omitFile?: boolean;
  extraField?: { name: string; content: Buffer };
}): Buffer {
  const parts: Buffer[] = [];
  if (!opts.omitFile) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename ?? 'test.txt'}"\r\n` +
      `Content-Type: ${opts.contentType ?? 'text/plain'}\r\n\r\n`, 'latin1'));
    parts.push(opts.content);
    parts.push(Buffer.from('\r\n', 'latin1'));
  }
  if (opts.purpose !== undefined && opts.purpose !== null) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${opts.purpose}\r\n`, 'latin1'));
  }
  if (opts.extraField) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${opts.extraField.name}"\r\n\r\n`, 'latin1'));
    parts.push(opts.extraField.content);
    parts.push(Buffer.from('\r\n', 'latin1'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** A fake `req` that is a real Readable stream (so filesController's own
 * `req.on('data'|'end'|'error')` wiring is exercised end-to-end), fed in
 * `chunkSize`-sized pieces on separate ticks to prove multipart boundary
 * detection is correct even when a boundary is split across chunks. */
function makeUploadReq(body: Buffer, opts: { boundary?: string; chunkSize?: number; email?: string; contentType?: string } = {}): any {
  const boundary = opts.boundary ?? 'testboundary123';
  const req: any = new Readable({ read() {} });
  req.headers = { 'content-type': opts.contentType ?? `multipart/form-data; boundary=${boundary}` };
  req.method = 'POST';
  req.params = {};
  req.query = {};
  req.apiKeyInfo = { email: opts.email ?? 'owner@example.com' };

  const chunkSize = opts.chunkSize ?? (body.length || 1);
  let offset = 0;
  const pushNext = () => {
    if (offset >= body.length) { req.push(null); return; }
    const end = Math.min(offset + chunkSize, body.length);
    req.push(body.slice(offset, end));
    offset = end;
    setImmediate(pushNext);
  };
  setImmediate(pushNext);
  return req;
}

beforeEach(() => {
  dbState.available = true;
  configState.maxFileBytes = 33554432;
  poolQuery.mockReset();
  detachingDelete.mockReset();
  mockRetainBlob.mockReset();
  mockReleaseBlob.mockReset();
  mockReleaseBlobIn.mockReset();
  mockOpenBlob.mockReset();
  loggerError.mockReset();
  loggerDebug.mockReset();
});

// ---------------------------------------------------------------------------
// Availability guard — every endpoint, not just the ones we remember.
// ---------------------------------------------------------------------------
describe('availability guard', () => {
  beforeEach(() => { dbState.available = false; });

  const expectUnavailable = (res: any) => {
    expect(res.statusCode).toBe(503);
    expect(res.body.error.type).toBe('file_search_unavailable');
    expect(res.body.error.code).toBe('file_search_unavailable');
  };

  it('uploadFile: 503 without a database', async () => {
    const req = makeUploadReq(buildMultipartBody('b', { content: Buffer.from('hi'), purpose: 'assistants' }));
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expectUnavailable(res);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('listFiles: 503 without a database', async () => {
    const res = makeRes();
    await filesController.listFiles(baseReq(), res, jest.fn());
    expectUnavailable(res);
  });

  it('retrieveFile: 503 without a database', async () => {
    const res = makeRes();
    await filesController.retrieveFile(baseReq({ params: { id: 'file-x' } }), res, jest.fn());
    expectUnavailable(res);
  });

  it('deleteFile: 503 without a database', async () => {
    const res = makeRes();
    await filesController.deleteFile(baseReq({ params: { id: 'file-x' } }), res, jest.fn());
    expectUnavailable(res);
  });

  it('downloadFileContent: 503 without a database', async () => {
    const res = makeRes();
    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' } }), res, jest.fn());
    expectUnavailable(res);
  });
});

// ---------------------------------------------------------------------------
// uploadFile
// ---------------------------------------------------------------------------
describe('uploadFile', () => {
  it('rejects a non-multipart request with 400', async () => {
    const req = baseReq({ headers: { 'content-type': 'application/json' } });
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_content_type');
  });

  it('rejects a purpose outside the supported vector-store value with 400', async () => {
    const req = makeUploadReq(buildMultipartBody('b1', { content: Buffer.from('hello'), purpose: 'fine-tune' }), { boundary: 'b1' });
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_purpose');
    expect(mockRetainBlob).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  // The purpose OpenAI's own file-search guide uploads with, and therefore the
  // one the OpenAI SDK sends. `'file_search'` — what this endpoint used to
  // demand — is not in OpenAI's documented enum at all, so a compliant client
  // was rejected on its first call. These two tests are a matched pair: the
  // accept test alone would still pass with the purpose check deleted outright,
  // and the reject tests alone would still pass if the accepted value regressed.
  it("accepts OpenAI's documented purpose \"assistants\"", async () => {
    mockRetainBlob.mockResolvedValue({ deduplicated: false });
    // The INSERT now RETURNS created_at (stamped by the database clock), so
    // this mock must yield a row. An empty result is not a shape that query
    // can produce — unlike the retrieve/delete mocks below, where empty rows
    // legitimately means 'no such file'.
    poolQuery.mockResolvedValue({ rows: [{ created_at: new Date() }] });
    const req = makeUploadReq(
      buildMultipartBody('bP1', { content: Buffer.from('hello'), purpose: 'assistants', filename: 'a.txt' }),
      { boundary: 'bP1' },
    );
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.purpose).toBe('assistants');
  });

  // OpenAI's "flexible file type for any purpose" (openai-node FilePurpose), which its file-search
  // guide's Java and Ruby samples upload with before attaching the file to a vector store.
  it('accepts purpose "user_data" and keeps it on the stored file', async () => {
    mockRetainBlob.mockResolvedValue({ deduplicated: false });
    poolQuery.mockResolvedValue({ rows: [{ created_at: new Date() }] });
    const req = makeUploadReq(
      buildMultipartBody('bP4', { content: Buffer.from('hello'), purpose: 'user_data', filename: 'u.txt' }),
      { boundary: 'bP4' },
    );
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.purpose).toBe('user_data');
    const insert = poolQuery.mock.calls.find(([sql]: any) => /INSERT INTO fs_files/.test(sql));
    expect(insert[1]).toContain('user_data');
  });

  it('rejects the undocumented purpose "file_search" this endpoint used to require, with 400', async () => {
    const req = makeUploadReq(buildMultipartBody('bP2', { content: Buffer.from('hello'), purpose: 'file_search' }), { boundary: 'bP2' });
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_purpose');
    expect(mockRetainBlob).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects "batch" — documented by OpenAI, deliberately unsupported here — with 400 naming the expected value', async () => {
    const req = makeUploadReq(buildMultipartBody('bP3', { content: Buffer.from('hello'), purpose: 'batch' }), { boundary: 'bP3' });
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_purpose');
    // The message has to name the value a caller should have sent, or it tells
    // them nothing they can act on.
    expect(res.body.error.message).toContain('"assistants"');
    expect(res.body.error.message).toContain('"user_data"');
    expect(mockRetainBlob).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects a missing purpose with 400', async () => {
    const req = makeUploadReq(buildMultipartBody('b2', { content: Buffer.from('hello'), purpose: null }), { boundary: 'b2' });
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_purpose');
  });

  it('rejects a request missing the file part with 400', async () => {
    const req = makeUploadReq(buildMultipartBody('b3', { content: Buffer.from(''), purpose: 'assistants', omitFile: true }), { boundary: 'b3' });
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('missing_file');
    expect(mockRetainBlob).not.toHaveBeenCalled();
  });

  it('413s once the streamed file exceeds maxFileBytes, without storing anything', async () => {
    configState.maxFileBytes = 10;
    const content = Buffer.alloc(1000, 'x'); // far bigger than the 10-byte cap
    const req = makeUploadReq(
      buildMultipartBody('b4', { content, purpose: 'assistants' }),
      { boundary: 'b4', chunkSize: 16 },
    );
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
    expect(mockRetainBlob).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('stores the file and responds with the OpenAI file object shape', async () => {
    mockRetainBlob.mockResolvedValue({ deduplicated: false });
    // The INSERT now RETURNS created_at (stamped by the database clock), so
    // this mock must yield a row. An empty result is not a shape that query
    // can produce — unlike the retrieve/delete mocks below, where empty rows
    // legitimately means 'no such file'.
    poolQuery.mockResolvedValue({ rows: [{ created_at: new Date() }] });
    const content = Buffer.from('hello world');
    const req = makeUploadReq(
      buildMultipartBody('b5', { content, purpose: 'assistants', filename: 'doc.txt', contentType: 'text/plain' }),
      { boundary: 'b5' },
    );
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      object: 'file', bytes: content.length, filename: 'doc.txt', purpose: 'assistants',
    });
    // OpenAI's File object carries `status`; a stored file is ready at once (the SDK's
    // waitForProcessing polls for 'processed').
    expect(res.body.status).toBe('processed');
    expect(res.body.status_details).toBeNull();
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id).toMatch(/^file-[0-9a-f]{24}$/);
    expect(typeof res.body.created_at).toBe('number');

    const expectedSha = crypto.createHash('sha256').update(content).digest('hex');
    expect(mockRetainBlob).toHaveBeenCalledWith(expectedSha, content, 'text/plain');

    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO fs_files/);
    // created_at is NOT bound: it comes from the database clock via now(), and
    // the stored value is read back with RETURNING so the response reports what
    // was actually written. A bound Date here would be the old behaviour, where
    // RETURNING merely echoed the application's own guess. The last parameter is
    // the expires_after seconds: null, as no expiry was asked for.
    expect(params).toEqual([res.body.id, 'owner@example.com', 'doc.txt', 'assistants', expectedSha, content.length, null]);
    expect(sql).toMatch(/now\(\)/);
    expect(sql).toMatch(/RETURNING created_at/);
  });

  it('reconstructs the file correctly when the multipart body arrives split across many small chunks', async () => {
    mockRetainBlob.mockResolvedValue({ deduplicated: false });
    // The INSERT now RETURNS created_at (stamped by the database clock), so
    // this mock must yield a row. An empty result is not a shape that query
    // can produce — unlike the retrieve/delete mocks below, where empty rows
    // legitimately means 'no such file'.
    poolQuery.mockResolvedValue({ rows: [{ created_at: new Date() }] });
    const content = crypto.randomBytes(500); // binary-safe, includes bytes that could coincidentally resemble boundary text
    const req = makeUploadReq(
      buildMultipartBody('boundaryXYZ', { content, purpose: 'assistants', filename: 'bin.dat', contentType: 'application/octet-stream' }),
      { boundary: 'boundaryXYZ', chunkSize: 3 }, // deliberately smaller than the boundary marker
    );
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    const expectedSha = crypto.createHash('sha256').update(content).digest('hex');
    expect(mockRetainBlob).toHaveBeenCalledWith(expectedSha, content, 'application/octet-stream');
    expect(res.body.bytes).toBe(content.length);
  });

  it('rolls back the blob refcount if the database insert fails', async () => {
    mockRetainBlob.mockResolvedValue({ deduplicated: true });
    poolQuery.mockRejectedValue(new Error('db exploded'));
    const req = makeUploadReq(
      buildMultipartBody('b6', { content: Buffer.from('x'), purpose: 'assistants' }), { boundary: 'b6' },
    );
    const res = makeRes();
    const next = jest.fn();
    await filesController.uploadFile(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(mockReleaseBlob).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('rejects a filename longer than 255 characters with 400, before touching storage', async () => {
    const longName = `${'a'.repeat(300)}.txt`;
    const req = makeUploadReq(
      buildMultipartBody('b9', { content: Buffer.from('x'), purpose: 'assistants', filename: longName }),
      { boundary: 'b9' },
    );
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_filename');
    expect(mockRetainBlob).not.toHaveBeenCalled();
  });

  it('rejects a filename containing a NUL byte with 400, never reaching the database (which would 500 on it)', async () => {
    const req = makeUploadReq(
      buildMultipartBody('b10', { content: Buffer.from('x'), purpose: 'assistants', filename: `evil${String.fromCharCode(0)}.txt` }),
      { boundary: 'b10' },
    );
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_filename');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('413s once TOTAL bytes across ALL parts exceed maxFileBytes, even for a part with an unrecognized name', async () => {
    // Regression: the size cap used to only accumulate bytes for the part
    // literally named "file" — any other field name fell through to a
    // discard branch with no accounting at all, so an authenticated caller
    // could stream unbounded data under a different field name.
    configState.maxFileBytes = 100;
    const junk = Buffer.alloc(20_000, 'j'); // far over the cap, under an unrecognized field name
    const req = makeUploadReq(
      buildMultipartBody('b11', {
        content: Buffer.from('tiny'), purpose: 'assistants', extraField: { name: 'junk', content: junk },
      }),
      { boundary: 'b11', chunkSize: 32 },
    );
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
    expect(mockRetainBlob).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects an unterminated multipart body (no closing boundary) with 400, not 500, and without error-level logging', async () => {
    const boundary = 'unterminated1';
    const malformed = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n` +
      'Content-Type: text/plain\r\n\r\nhello, this just stops', // no trailing CRLF, no closing --boundary--
      'latin1',
    );
    const req = makeUploadReq(malformed, { boundary });
    const res = makeRes();
    const next = jest.fn();
    await filesController.uploadFile(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_multipart_body');
    expect(next).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('rejects a completely empty multipart body with 400, not 500', async () => {
    const req = makeUploadReq(Buffer.alloc(0), { boundary: 'empty1' });
    const res = makeRes();
    const next = jest.fn();
    await filesController.uploadFile(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_multipart_body');
    expect(next).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('rejects a body with zero parts (immediate closing boundary, no headers at all) with 400, not 500', async () => {
    const boundary = 'zeroparts1';
    const req = makeUploadReq(Buffer.from(`--${boundary}--\r\n`, 'latin1'), { boundary });
    const res = makeRes();
    const next = jest.fn();
    await filesController.uploadFile(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_multipart_body');
    expect(next).not.toHaveBeenCalled();
  });

  it('does not echo raw parser internals into the 400 body for a malformed request', async () => {
    const req = makeUploadReq(Buffer.alloc(0), { boundary: 'empty2' });
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.body.error.message).not.toMatch(/Unexpected end|boundary|parser/i);
  });

  // The existence-oracle rule: two uploads of identical content must be
  // indistinguishable in body shape, status code, and (as far as this test
  // can observe) timing — regardless of what `retainBlob` reports internally.
  it('two uploads of identical content are indistinguishable in status and shape', async () => {
    mockRetainBlob
      .mockResolvedValueOnce({ deduplicated: false }) // first upload: genuinely new blob
      .mockResolvedValueOnce({ deduplicated: true });  // second upload: content-addressed dedup kicks in
    // The INSERT now RETURNS created_at (stamped by the database clock), so
    // this mock must yield a row. An empty result is not a shape that query
    // can produce — unlike the retrieve/delete mocks below, where empty rows
    // legitimately means 'no such file'.
    poolQuery.mockResolvedValue({ rows: [{ created_at: new Date() }] });

    const content = Buffer.from('identical payload');
    const makeReq = () => makeUploadReq(
      buildMultipartBody('b7', { content, purpose: 'assistants', filename: 'same.txt', contentType: 'text/plain' }),
      { boundary: 'b7' },
    );

    const res1 = makeRes();
    await filesController.uploadFile(makeReq(), res1, jest.fn());
    const res2 = makeRes();
    await filesController.uploadFile(makeReq(), res2, jest.fn());

    expect(res1.statusCode).toBe(res2.statusCode);
    expect(res1.statusCode).toBe(200);
    expect(Object.keys(res1.body).sort()).toEqual(Object.keys(res2.body).sort());
    expect(res1.body.bytes).toBe(res2.body.bytes);
    expect(res1.body.filename).toBe(res2.body.filename);
    expect(res1.body.purpose).toBe(res2.body.purpose);
    expect(res1.body.object).toBe(res2.body.object);
    // `deduplicated` must never leak into the response.
    expect(res1.body.deduplicated).toBeUndefined();
    expect(res2.body.deduplicated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multipart parser fuzz — the shipped suite otherwise has exactly one
// small-chunk case; this rounds-trips many random binary payloads across a
// range of chunk sizes (including ones smaller than the boundary marker) and
// asserts byte-for-byte exactness of what actually reaches storage, which is
// what keeps the hand-rolled streaming parser defensible going forward.
// ---------------------------------------------------------------------------
describe('multipart parser fuzz', () => {
  it('round-trips random binary payloads across a range of chunk sizes without corruption or truncation', async () => {
    for (let i = 0; i < 25; i++) {
      const size = 1 + Math.floor(Math.random() * 4000);
      const chunkSize = 1 + Math.floor(Math.random() * 40); // includes sizes smaller than the boundary marker
      const content = crypto.randomBytes(size);
      mockRetainBlob.mockReset();
      mockRetainBlob.mockResolvedValue({ deduplicated: false });
      poolQuery.mockReset();
      poolQuery.mockResolvedValue({ rows: [] });
      const boundary = `fuzz${i}`;
      const req = makeUploadReq(
        buildMultipartBody(boundary, {
          content, purpose: 'assistants', filename: `f${i}.bin`, contentType: 'application/octet-stream',
        }),
        { boundary, chunkSize },
      );
      const res = makeRes();
      await filesController.uploadFile(req, res, jest.fn());

      expect(res.statusCode).toBe(200);
      const [, storedBytes]: [string, Buffer] = mockRetainBlob.mock.calls[0];
      expect(Buffer.isBuffer(storedBytes)).toBe(true);
      expect(storedBytes.equals(content)).toBe(true);
      expect(storedBytes.length).toBe(content.length);
    }
  });
});

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------
describe('listFiles', () => {
  it('scopes the query by owner_email and over-fetches limit+1 rows', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const req = baseReq({ query: { limit: '5' } });
    const res = makeRes();
    await filesController.listFiles(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$1/);
    expect(params[0]).toBe('owner@example.com');
    expect(params[params.length - 1]).toBe(6); // limit(5) + 1
  });

  // OpenAI: "Limit can range between 1 and 10,000, and the default is 10,000"
  // (openai-python types/file_list_params.py). The vector-store lists keep 20/100 (pagination.test.ts).
  it.each([
    [undefined, 10001], ['500', 501], ['10000', 10001], ['20000', 10001], ['0', 2],
  ])('pages GET /files as OpenAI does: limit %s fetches %d rows', async (limit, fetched) => {
    poolQuery.mockResolvedValue({ rows: [] });
    const query = limit === undefined ? {} : { limit };
    await filesController.listFiles(baseReq({ query }), makeRes(), jest.fn());
    const [, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(params[params.length - 1]).toBe(fetched);
  });

  it('reports has_more/first_id/last_id from an over-fetched page', async () => {
    poolQuery.mockResolvedValue({
      rows: [
        { id: 'file-a', filename: 'a', purpose: 'assistants', size_bytes: '1', created_at: new Date() },
        { id: 'file-b', filename: 'b', purpose: 'assistants', size_bytes: '1', created_at: new Date() },
        { id: 'file-c', filename: 'c', purpose: 'assistants', size_bytes: '1', created_at: new Date() },
      ],
    });
    const req = baseReq({ query: { limit: '2' } });
    const res = makeRes();
    await filesController.listFiles(req, res, jest.fn());

    expect(res.body.data.map((f: any) => f.id)).toEqual(['file-a', 'file-b']);
    expect(res.body.data.every((f: any) => f.status === 'processed' && f.status_details === null)).toBe(true);
    expect(res.body.has_more).toBe(true);
    expect(res.body.first_id).toBe('file-a');
    expect(res.body.last_id).toBe('file-b');
  });

  it.each(['assistants', 'user_data'])('?purpose=%s narrows the query to files of that purpose', async (purpose) => {
    poolQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await filesController.listFiles(baseReq({ query: { purpose, limit: '5' } }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/purpose = \$2/);
    expect(params[1]).toBe(purpose);
    expect(params[params.length - 1]).toBe(6);
  });

  it('without ?purpose= the query lists every purpose', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await filesController.listFiles(baseReq({ query: { limit: '5' } }), makeRes(), jest.fn());
    const [sql]: [string] = poolQuery.mock.calls[0];
    expect(sql).not.toMatch(/purpose =/);
  });

  it('an empty ?purpose= is treated as absent', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await filesController.listFiles(baseReq({ query: { purpose: '' } }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(poolQuery).toHaveBeenCalled();
  });

  it.each(['batch', 'fine-tune', 'vision', 'ASSISTANTS'])(
    '?purpose=%s answers an empty list without querying (no other purpose is stored)',
    async (purpose) => {
      const res = makeRes();
      await filesController.listFiles(baseReq({ query: { purpose } }), res, jest.fn());
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
      expect(poolQuery).not.toHaveBeenCalled();
    },
  );

  it('a bracketed ?purpose[x]=1 (a null-prototype object) is ignored like an absent filter, never a throw', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const purpose = Object.assign(Object.create(null), { x: '1' });
    const res = makeRes();
    const next = jest.fn();
    await filesController.listFiles(baseReq({ query: { purpose } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(poolQuery).toHaveBeenCalled();
  });

  it('returns an empty page — not an error, and without querying fs_files again — when the after cursor does not resolve for this owner', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] }); // cursor lookup finds nothing
    const req = baseReq({ query: { after: 'file-not-mine-or-missing' } });
    const res = makeRes();
    await filesController.listFiles(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('scopes the cursor resolution query itself by owner_email (not just by what the mock happens to return)', async () => {
    // This is the same class of gap that "retrieveFile"/"downloadFileContent"
    // scoping tests guard against: without asserting on the SQL, mutating
    // owner_email out of this lookup would leave every other test passing
    // (the mock returns whatever it's told to regardless of the query), even
    // though unscoped it would let after=<another owner's file id> resolve
    // and return a normal page instead of an empty one — the existence
    // oracle the design forbids.
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({ query: { after: 'file-x' }, apiKeyInfo: { email: 'someone@example.com' } });
    const res = makeRes();
    await filesController.listFiles(req, res, jest.fn());
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$2/);
    expect(params).toEqual(['file-x', 'someone@example.com']);
  });

  it('before= fetches in the reverse of the display sort direction and flips the trimmed page back to display order', async () => {
    // Regression: before= used to reuse the display sort direction for the
    // fetch, which (a) selects the wrong window (the newest/oldest rows
    // overall rather than the ones adjacent to the cursor) and (b) can never
    // terminate a backward walk. The fix fetches in the OPPOSITE direction
    // (closest-to-cursor first, so LIMIT+1 correctly identifies the row to
    // trim) and then reverses the trimmed page back into display order.
    poolQuery.mockResolvedValueOnce({ rows: [{ created_at: new Date('2026-01-05T00:00:00Z'), id: 'file-cursor' }] });
    poolQuery.mockResolvedValueOnce({
      rows: [
        { id: 'file-close', filename: 'close', purpose: 'assistants', size_bytes: '1', created_at: new Date('2026-01-04T00:00:00Z') },
        { id: 'file-mid', filename: 'mid', purpose: 'assistants', size_bytes: '1', created_at: new Date('2026-01-03T00:00:00Z') },
        { id: 'file-far', filename: 'far', purpose: 'assistants', size_bytes: '1', created_at: new Date('2026-01-02T00:00:00Z') }, // the over-fetched extra row
      ],
    });
    const req = baseReq({ query: { before: 'file-cursor', limit: '2', order: 'desc' } });
    const res = makeRes();
    await filesController.listFiles(req, res, jest.fn());

    const [sql]: [string, any[]] = poolQuery.mock.calls[1];
    // Display order is DESC (the default); the fetch for `before` must run ASC.
    expect(sql).toMatch(/ORDER BY created_at ASC, id ASC/);
    // The ::timestamptz cast is load-bearing, not decoration: the cursor is
    // resolved as text to keep the microseconds a JS Date would truncate, so
    // it has to be cast back for the row-wise comparison.
    expect(sql).toMatch(/\(created_at, id\) > \(\$2::timestamptz, \$3\)/);

    expect(res.body.data.map((f: any) => f.id)).toEqual(['file-mid', 'file-close']);
    expect(res.body.has_more).toBe(true);
    expect(res.body.first_id).toBe('file-mid');
    expect(res.body.last_id).toBe('file-close');
  });
});

// ---------------------------------------------------------------------------
// retrieveFile — 404, never 403, and indistinguishable from "doesn't exist"
// ---------------------------------------------------------------------------
describe('retrieveFile', () => {
  it('404s for a file that does not exist', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await filesController.retrieveFile(baseReq({ params: { id: 'file-missing' } }), res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('file_not_found');
  });

  it("404s for another owner's file with a body identical to the nonexistent-file case", async () => {
    // The query itself is scoped by owner_email — from the controller's point
    // of view "exists but belongs to someone else" and "doesn't exist" are
    // the same empty-rows result, which is exactly what makes them indistinguishable.
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const resForeign = makeRes();
    await filesController.retrieveFile(baseReq({ params: { id: 'file-someone-elses' } }), resForeign, jest.fn());

    poolQuery.mockResolvedValueOnce({ rows: [] });
    const resMissing = makeRes();
    await filesController.retrieveFile(baseReq({ params: { id: 'file-does-not-exist' } }), resMissing, jest.fn());

    expect(resForeign.statusCode).toBe(404);
    expect(resForeign.statusCode).toBe(resMissing.statusCode);
    expect(resForeign.body.error.type).toBe(resMissing.body.error.type);
    expect(resForeign.body.error.code).toBe(resMissing.body.error.code);
  });

  it('scopes the lookup query itself by owner_email (not just by what the mock happens to return)', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await filesController.retrieveFile(baseReq({ params: { id: 'file-x' }, apiKeyInfo: { email: 'someone@example.com' } }), res, jest.fn());
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$2/);
    expect(params).toEqual(['file-x', 'someone@example.com']);
  });

  it("returns the caller's own file", async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    poolQuery.mockResolvedValue({ rows: [{ id: 'file-mine', filename: 'mine.txt', purpose: 'assistants', size_bytes: '42', created_at: createdAt }] });
    const res = makeRes();
    await filesController.retrieveFile(baseReq({ params: { id: 'file-mine' } }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      id: 'file-mine', object: 'file', bytes: 42, filename: 'mine.txt', purpose: 'assistants',
      created_at: Math.floor(createdAt.getTime() / 1000), status: 'processed', status_details: null,
    });
  });
});

// ---------------------------------------------------------------------------
// deleteFile — OpenAI's "delete a file and remove it from all vector stores"
// ---------------------------------------------------------------------------
describe('deleteFile', () => {
  it('detaches the file from every store of the caller and deletes it, in the repository\'s one transaction', async () => {
    detachingDelete.mockResolvedValue({ deleted: true, sha256: 'deadbeef'.repeat(8) });
    const res = makeRes();
    await filesController.deleteFile(baseReq({ params: { id: 'file-x' } }), res, jest.fn());

    expect(detachingDelete).toHaveBeenCalledWith('file-x', 'owner@example.com');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'file-x', object: 'file', deleted: true });
    // No statement of its own: the detach, the delete and the blob release are the repository's.
    expect(poolQuery).not.toHaveBeenCalled();
    expect(mockReleaseBlob).not.toHaveBeenCalled();
  });

  it('404s for a file that does not exist or belongs to someone else, scoped by the caller', async () => {
    detachingDelete.mockResolvedValue({ deleted: false });
    const res = makeRes();
    await filesController.deleteFile(
      baseReq({ params: { id: 'file-x' }, apiKeyInfo: { email: 'someone@example.com' } }), res, jest.fn(),
    );
    expect(detachingDelete).toHaveBeenCalledWith('file-x', 'someone@example.com');
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('file_not_found');
  });

  it('409 file_in_use only when a store of ANOTHER owner still references the file', async () => {
    detachingDelete.mockResolvedValue({ deleted: false, inUse: true });
    const res = makeRes();
    await filesController.deleteFile(baseReq({ params: { id: 'file-x' } }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('file_in_use');
  });

  it('a deadlock victim answers 409 concurrent_modification (retryable), not a 500', async () => {
    detachingDelete.mockRejectedValue(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    const res = makeRes();
    const next = jest.fn();
    await filesController.deleteFile(baseReq({ params: { id: 'file-x' } }), res, next);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('concurrent_modification');
    expect(next).not.toHaveBeenCalled();
  });

  it('any other failure reaches next()', async () => {
    detachingDelete.mockRejectedValue(new Error('connection lost'));
    const next = jest.fn();
    await filesController.deleteFile(baseReq({ params: { id: 'file-x' } }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// downloadFileContent
// ---------------------------------------------------------------------------
describe('downloadFileContent', () => {
  it('404s for a file that does not exist or belongs to someone else', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' } }), res, jest.fn());
    expect(res.statusCode).toBe(404);
  });

  it('scopes the lookup query itself by owner_email (not just by what the mock happens to return)', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' }, apiKeyInfo: { email: 'someone@example.com' } }), res, jest.fn());
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/f\.owner_email = \$2/);
    expect(params).toEqual(['file-x', 'someone@example.com']);
  });

  it('streams back the original bytes with the stored mime type and a sanitized filename header', async () => {
    poolQuery.mockResolvedValue({ rows: [{ filename: 'evil".txt\r\nX-Injected: yes', sha256: 'ab'.repeat(32), mime: 'text/plain' }] });
    const bytes = Buffer.from('the original bytes');
    mockOpenBlob.mockResolvedValue(bytes);

    const res = makeRes();
    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' } }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/plain');
    const dispositionCall = res.set.mock.calls.find((c: any[]) => c[0] === 'Content-Disposition');
    // No CR/LF survives — that's what would let a crafted filename inject a
    // second header line (e.g. its own Content-Disposition or a redirect).
    expect(dispositionCall[1]).not.toMatch(/[\r\n]/);
    // The ASCII fallback matches the old sanitizer's output (both replace
    // '"'/CR/LF with '_'); the RFC 5987 extended form is new — it carries the
    // filename losslessly, which the fallback alone cannot for a name like this.
    expect(dispositionCall[1]).toBe(
      'attachment; filename="evil_.txt__X-Injected: yes"; '
      + "filename*=UTF-8''evil%22.txt%0D%0AX-Injected%3A%20yes",
    );
    expect(res.send).toHaveBeenCalledWith(bytes);
    expect(mockOpenBlob).toHaveBeenCalledWith('ab'.repeat(32));
  });

  it.each([
    ['missing bytes', new BlobUnavailableError('db', 'missing')],
    ['missing S3 credentials', new BlobUnavailableError('s3', 'not_configured',
      'blob_storage.s3: FILE_SEARCH_S3_ACCESS_KEY_ID / FILE_SEARCH_S3_SECRET_ACCESS_KEY are not configured')],
    ['a location outside the configured prefix', new BlobUnavailableError('s3', 'location_unreachable')],
  ])('503s blob_storage_unavailable without storage internals for %s', async (_case, error) => {
    poolQuery.mockResolvedValue({ rows: [{ filename: 'x.txt', sha256: 'cd'.repeat(32), mime: null }] });
    mockOpenBlob.mockRejectedValue(error);
    const res = makeRes();
    const next = jest.fn();
    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' } }), res, next);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toEqual({
      message: 'The file content storage is unavailable.',
      type: 'server_error',
      param: null,
      code: 'blob_storage_unavailable',
    });
    expect(next).not.toHaveBeenCalled();
    // The detail reaches the operator's log, not the caller.
    expect(loggerError).toHaveBeenCalledWith('FilesController', 'Blob storage is unavailable', error);
  });

  it('uploadFile answers 503 blob_storage_unavailable when the blob cannot be stored', async () => {
    mockRetainBlob.mockRejectedValue(new BlobUnavailableError('s3', 'request_failed', 'S3 PutObject failed: HTTP 503 SlowDown'));
    const req = makeUploadReq(
      buildMultipartBody('bV', { content: Buffer.from('x'), purpose: 'assistants' }), { boundary: 'bV' },
    );
    const res = makeRes();
    await filesController.uploadFile(req, res, jest.fn());
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('blob_storage_unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/S3|PutObject|SlowDown/);
  });
});

// ---------------------------------------------------------------------------
// UnsupportedBlobBackendError -> 503 file_search_unavailable
//
// `getBackend()` refuses a `blob_storage.backend` of "local" (see
// blobStore.ts). That is a DEPLOYMENT MISCONFIGURATION — the same class of
// condition as "no vector database is configured", which this module already
// answers with 503 file_search_unavailable. It used to fall through to
// `next(error)` and surface as a generic 500, which tells an operator nothing
// and tells a client to retry a thing that will never work.
// ---------------------------------------------------------------------------
describe('an unsupported blob backend', () => {
  const backendError = (): Error => new UnsupportedBlobBackendError('local');

  /** The full envelope, asserted field by field rather than "not 500". */
  function expectUnavailableEnvelope(res: any): void {
    expect(res.statusCode).toBe(503);
    expect(res.body.error.type).toBe('file_search_unavailable');
    expect(res.body.error.code).toBe('file_search_unavailable');
    expect(res.body.error.param).toBeNull();
    // The message is the operator-facing one the error itself carries — it names
    // the offending backend and the fix.
    expect(res.body.error.message).toContain('local');
    expect(res.body.error.message).toContain('blob_storage.backend');
  }

  it('downloadFileContent answers 503 file_search_unavailable, not a generic 500', async () => {
    poolQuery.mockResolvedValue({ rows: [{ filename: 'x.txt', sha256: 'ef'.repeat(32), mime: null }] });
    mockOpenBlob.mockRejectedValue(backendError());
    const res = makeRes();
    const next = jest.fn();

    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' } }), res, next);

    expectUnavailableEnvelope(res);
    // Not ALSO forwarded — a double-answer here would be a second write on a
    // response that has already been sent.
    expect(next).not.toHaveBeenCalled();
  });

  it('uploadFile answers 503 too, so the mapping is not download-only', async () => {
    mockRetainBlob.mockRejectedValue(backendError());
    const req = makeUploadReq(
      buildMultipartBody('bU', { content: Buffer.from('x'), purpose: 'assistants' }), { boundary: 'bU' },
    );
    const res = makeRes();
    const next = jest.fn();

    await filesController.uploadFile(req, res, next);

    expectUnavailableEnvelope(res);
    expect(next).not.toHaveBeenCalled();
  });

  it('deleteFile answers 503 too', async () => {
    // The blob release inside the repository's transaction is where the backend is consulted.
    detachingDelete.mockRejectedValue(backendError());
    const res = makeRes();
    const next = jest.fn();

    await filesController.deleteFile(baseReq({ params: { id: 'file-x' } }), res, next);

    expectUnavailableEnvelope(res);
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves an ordinary error alone — it still reaches next() and is NOT dressed as 503', async () => {
    // The guard that keeps the mapping from swallowing real server faults: only
    // this one error class is a configuration problem.
    poolQuery.mockResolvedValue({ rows: [{ filename: 'x.txt', sha256: 'ef'.repeat(32), mime: null }] });
    mockOpenBlob.mockRejectedValue(new Error('disk on fire'));
    const res = makeRes();
    const next = jest.fn();

    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' } }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// expires_after (G11) — OpenAI's FileCreateParams.ExpiresAfter, sent by both SDKs as the
// multipart fields `expires_after[anchor]` and `expires_after[seconds]` (openai-node
// addFormValue `${key}[${name}]`; openai-python stringify_items, nested format "brackets").
// ---------------------------------------------------------------------------
describe('uploadFile expires_after', () => {
  function bodyWith(boundary: string, fields: Array<[string, string]>): Buffer {
    const parts: Buffer[] = [Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.txt"\r\n`
      + 'Content-Type: text/plain\r\n\r\nhello\r\n', 'latin1')];
    for (const [name, value] of [['purpose', 'assistants'] as [string, string], ...fields]) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'latin1'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
    return Buffer.concat(parts);
  }

  async function upload(fields: Array<[string, string]>): Promise<any> {
    const res = makeRes();
    await filesController.uploadFile(makeUploadReq(bodyWith('bx', fields), { boundary: 'bx' }), res, jest.fn());
    return res;
  }

  const invalid: Array<[string, Array<[string, string]>, string]> = [
    ['an anchor other than created_at', [['expires_after[anchor]', 'last_active_at'], ['expires_after[seconds]', '3600']], 'expires_after.anchor'],
    ['seconds below 3600', [['expires_after[anchor]', 'created_at'], ['expires_after[seconds]', '3599']], 'expires_after.seconds'],
    ['seconds above 2592000', [['expires_after[anchor]', 'created_at'], ['expires_after[seconds]', '2592001']], 'expires_after.seconds'],
    ['non-integer seconds', [['expires_after[anchor]', 'created_at'], ['expires_after[seconds]', '3600.5']], 'expires_after.seconds'],
    ['non-numeric seconds', [['expires_after[anchor]', 'created_at'], ['expires_after[seconds]', 'soon']], 'expires_after.seconds'],
    ['empty seconds', [['expires_after[anchor]', 'created_at'], ['expires_after[seconds]', '']], 'expires_after.seconds'],
    ['only the anchor', [['expires_after[anchor]', 'created_at']], 'expires_after.seconds'],
    ['only the seconds', [['expires_after[seconds]', '3600']], 'expires_after.anchor'],
  ];

  it.each(invalid)('400 invalid_request_error naming the param for %s, storing nothing', async (_label, fields, param) => {
    const res = await upload(fields);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({ type: 'invalid_request_error', param, code: 'invalid_expires_after' });
    expect(typeof res.body.error.message).toBe('string');
    expect(mockRetainBlob).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it.each([['3600'], ['2592000'], ['86400']])('accepts seconds=%s, stores it, and returns expires_at', async (seconds) => {
    mockRetainBlob.mockResolvedValue({ deduplicated: false });
    const createdAt = new Date('2026-10-13T10:00:00.000Z');
    const expiresAt = new Date(createdAt.getTime() + Number(seconds) * 1000);
    poolQuery.mockResolvedValue({ rows: [{ created_at: createdAt, expires_at: expiresAt }] });
    const res = await upload([['expires_after[anchor]', 'created_at'], ['expires_after[seconds]', seconds]]);
    expect(res.statusCode).toBe(200);
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/expires_at/);
    expect(params).toContain(Number(seconds));
    expect(res.body.expires_at).toBe(Math.floor(expiresAt.getTime() / 1000));
    // OpenAI's key order: expires_at right after created_at.
    expect(Object.keys(res.body)).toEqual(
      ['id', 'object', 'bytes', 'created_at', 'expires_at', 'filename', 'purpose', 'status', 'status_details']);
  });

  it('without expires_after the file object is unchanged: no expires_at key at all', async () => {
    mockRetainBlob.mockResolvedValue({ deduplicated: false });
    poolQuery.mockResolvedValue({ rows: [{ created_at: new Date(), expires_at: null }] });
    const res = await upload([]);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body)).toEqual(['id', 'object', 'bytes', 'created_at', 'filename', 'purpose', 'status', 'status_details']);
    expect(poolQuery.mock.calls[0][1]).toContain(null);
  });

  // Only the two bracket fields are read (all four OpenAI SDKs send exactly those; none sends a
  // JSON-encoded `expires_after`); any other part is ignored, as unknown parts always are.
  it.each([
    ['a bare expires_after field', [['expires_after', '{"anchor":"created_at","seconds":3600}']]],
    ['another expires_after key', [['expires_after[days]', '1']]],
  ] as Array<[string, Array<[string, string]>]>)('ignores %s: the file is stored without an expiry', async (_label, fields) => {
    mockRetainBlob.mockResolvedValue({ deduplicated: false });
    poolQuery.mockResolvedValue({ rows: [{ created_at: new Date(), expires_at: null }] });
    const res = await upload(fields);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('expires_at');
    expect(poolQuery.mock.calls[0][1][6]).toBeNull();
  });

  it('retrieve and list return expires_at for an expiring file, and hide expired files in the query itself', async () => {
    const createdAt = new Date('2026-10-13T10:00:00Z');
    const expiresAt = new Date('2026-10-13T11:00:00Z');
    poolQuery.mockResolvedValue({ rows: [{ id: 'file-e', filename: 'e.txt', purpose: 'assistants', size_bytes: '1', created_at: createdAt, expires_at: expiresAt }] });
    const getRes = makeRes();
    await filesController.retrieveFile(baseReq({ params: { id: 'file-e' } }), getRes, jest.fn());
    expect(getRes.body.expires_at).toBe(Math.floor(expiresAt.getTime() / 1000));
    expect(String(poolQuery.mock.calls[0][0])).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);

    poolQuery.mockClear();
    const listRes = makeRes();
    await filesController.listFiles(baseReq(), listRes, jest.fn());
    expect(listRes.body.data[0].expires_at).toBe(Math.floor(expiresAt.getTime() / 1000));
    expect(String(poolQuery.mock.calls[0][0])).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);

    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [] });
    const dlRes = makeRes();
    await filesController.downloadFileContent(baseReq({ params: { id: 'file-e' } }), dlRes, jest.fn());
    expect(dlRes.statusCode).toBe(404);
    expect(String(poolQuery.mock.calls[0][0])).toMatch(/f\.expires_at IS NULL OR f\.expires_at > now\(\)/);
  });
});
