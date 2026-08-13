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
  getPool: () => ({ query: poolQuery }),
}));

jest.mock('../../src/fileSearch/blob/blobStore', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/blob/blobStore');
  return {
    sha256Of: actual.sha256Of,
    // The REAL class, not a stand-in: filesController narrows on it with
    // `instanceof`, so a mocked-away constructor would make that check
    // vacuously false (or throw) and the 503 mapping untestable.
    UnsupportedBlobBackendError: actual.UnsupportedBlobBackendError,
    retainBlob: jest.fn(),
    releaseBlob: jest.fn(),
    getBackend: jest.fn(),
  };
});

const configState: { maxFileBytes: number } = { maxFileBytes: 33554432 };
jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({ limits: { maxFileBytes: configState.maxFileBytes } }),
}));

import * as filesController from '../../src/controllers/filesController';
import { retainBlob, releaseBlob, getBackend, UnsupportedBlobBackendError } from '../../src/fileSearch/blob/blobStore';

const mockRetainBlob = retainBlob as any;
const mockReleaseBlob = releaseBlob as any;
const mockGetBackend = getBackend as any;

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  res.set = jest.fn((..._args: any[]) => res);
  res.send = jest.fn((body: any) => { res.body = body; return res; });
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
  mockRetainBlob.mockReset();
  mockReleaseBlob.mockReset();
  mockGetBackend.mockReset();
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
    // RETURNING merely echoed the application's own guess.
    expect(params).toEqual([res.body.id, 'owner@example.com', 'doc.txt', 'assistants', expectedSha, content.length]);
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
    expect(res.body.has_more).toBe(true);
    expect(res.body.first_id).toBe('file-a');
    expect(res.body.last_id).toBe('file-b');
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
      created_at: Math.floor(createdAt.getTime() / 1000),
    });
  });
});

// ---------------------------------------------------------------------------
// deleteFile — decrements, does not destroy
// ---------------------------------------------------------------------------
describe('deleteFile', () => {
  it('404s for a file that does not exist or belongs to someone else', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await filesController.deleteFile(baseReq({ params: { id: 'file-x' } }), res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(mockReleaseBlob).not.toHaveBeenCalled();
  });

  it('releases the blob (refcount decrement) rather than deleting bytes directly', async () => {
    poolQuery.mockResolvedValue({ rows: [{ sha256: 'deadbeef'.repeat(8) }] });
    mockReleaseBlob.mockResolvedValue({ removed: false }); // another owner still references it
    const res = makeRes();
    await filesController.deleteFile(baseReq({ params: { id: 'file-x' } }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'file-x', object: 'file', deleted: true });
    expect(mockReleaseBlob).toHaveBeenCalledWith('deadbeef'.repeat(8));
    // The controller must never reach into the blob backend directly — only
    // releaseBlob (which owns the refcount bookkeeping) may decide to delete bytes.
    expect(mockGetBackend).not.toHaveBeenCalled();
  });

  it('scopes the delete to the caller by owner_email', async () => {
    poolQuery.mockResolvedValue({ rows: [{ sha256: 'aa'.repeat(32) }] });
    mockReleaseBlob.mockResolvedValue({ removed: true });
    const res = makeRes();
    await filesController.deleteFile(baseReq({ params: { id: 'file-x' }, apiKeyInfo: { email: 'someone@example.com' } }), res, jest.fn());
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM fs_files/);
    expect(sql).toMatch(/owner_email = \$2/);
    expect(params).toEqual(['file-x', 'someone@example.com']);
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
    const getFn: any = (jest.fn() as any).mockResolvedValue(bytes);
    mockGetBackend.mockReturnValue({ get: getFn });

    const res = makeRes();
    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' } }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/plain');
    const dispositionCall = res.set.mock.calls.find((c: any[]) => c[0] === 'Content-Disposition');
    // No CR/LF survives — that's what would let a crafted filename inject a
    // second header line (e.g. its own Content-Disposition or a redirect).
    expect(dispositionCall[1]).not.toMatch(/[\r\n]/);
    expect(dispositionCall[1]).toBe('attachment; filename="evil_.txt__X-Injected: yes"');
    expect(res.send).toHaveBeenCalledWith(bytes);
  });

  it('500s (not a crash) when the row exists but the backing blob is missing', async () => {
    poolQuery.mockResolvedValue({ rows: [{ filename: 'x.txt', sha256: 'cd'.repeat(32), mime: null }] });
    const missingGetFn: any = (jest.fn() as any).mockResolvedValue(null);
    mockGetBackend.mockReturnValue({ get: missingGetFn });
    const res = makeRes();
    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' } }), res, jest.fn());
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('blob_missing');
  });
});

// ---------------------------------------------------------------------------
// UnsupportedBlobBackendError -> 503 file_search_unavailable
//
// `getBackend()` refuses a `blob_storage.backend` of "local" or "s3" (see
// blobStore.ts). That is a DEPLOYMENT MISCONFIGURATION — the same class of
// condition as "no vector database is configured", which this module already
// answers with 503 file_search_unavailable. It used to fall through to
// `next(error)` and surface as a generic 500, which tells an operator nothing
// and tells a client to retry a thing that will never work.
// ---------------------------------------------------------------------------
describe('an unsupported blob backend', () => {
  const backendError = (): Error => new UnsupportedBlobBackendError('s3');

  /** The full envelope, asserted field by field rather than "not 500". */
  function expectUnavailableEnvelope(res: any): void {
    expect(res.statusCode).toBe(503);
    expect(res.body.error.type).toBe('file_search_unavailable');
    expect(res.body.error.code).toBe('file_search_unavailable');
    expect(res.body.error.param).toBeNull();
    // The message is the operator-facing one the error itself carries — it names
    // the offending backend and the fix.
    expect(res.body.error.message).toContain('s3');
    expect(res.body.error.message).toContain('blob_storage.backend');
  }

  it('downloadFileContent answers 503 file_search_unavailable, not a generic 500', async () => {
    poolQuery.mockResolvedValue({ rows: [{ filename: 'x.txt', sha256: 'ef'.repeat(32), mime: null }] });
    mockGetBackend.mockImplementation(() => { throw backendError(); });
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
    poolQuery.mockResolvedValue({ rows: [{ sha256: 'ab'.repeat(32) }] });
    mockReleaseBlob.mockRejectedValue(backendError());
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
    mockGetBackend.mockImplementation(() => { throw new Error('disk on fire'); });
    const res = makeRes();
    const next = jest.fn();

    await filesController.downloadFileContent(baseReq({ params: { id: 'file-x' } }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.json).not.toHaveBeenCalled();
  });
});
