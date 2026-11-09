/**
 * Task 6 (B10, B11): filesController driven through a REAL Express app on a
 * REAL listening HTTP server, with a REAL http client (supertest) — not the
 * hand-built `res`/`req` mocks in filesController.test.ts.
 *
 * Both bugs this file pins are invisible to that mock:
 *
 *   B10 — download's `Content-Disposition` header is built by hand and
 *   echoes the filename with only `[\r\n"]` replaced. A filename containing
 *   a character above U+00FF, or a C0/DEL control character, survives that
 *   replacement and reaches `res.set(...)`. Node's real header-value
 *   validator (`validateHeaderValue`, `\t\x20-\x7e\x80-\xff` only) throws
 *   `ERR_INVALID_CHAR` on such a value — but the unit test's `res.set =
 *   jest.fn()` never runs that validator, so it can't see the throw. Only a
 *   real `http.ServerResponse.setHeader` (which is what Express's `res.set`
 *   calls) reproduces it.
 *
 *   B11 — the streamed-upload size cap used to call `req.destroy()` the
 *   moment it tripped, synchronously inside the multipart parser's data
 *   callback. The 413 JSON is written only later, when the awaited parse
 *   promise resolves — by which point the real socket is already gone. A
 *   mock `req` (a bare `Readable`, no socket) makes `destroy()` a no-op, so
 *   the unit test's 413 assertion passes despite the bug. Only a real
 *   socket reproduces the race.
 */
import request from 'supertest';
import express from 'express';
import * as http from 'http';

const loggerNoop = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => loggerNoop }));

const dbState: { available: boolean } = { available: true };
const poolQuery: any = jest.fn();
jest.mock('../../src/fileSearch/db', () => ({
  isFileSearchAvailable: () => dbState.available,
  getPool: () => ({ query: poolQuery }),
}));

const mockOpenBlob = jest.fn();
jest.mock('../../src/fileSearch/blob/blobStore', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/blob/blobStore');
  return {
    sha256Of: actual.sha256Of,
    UnsupportedBlobBackendError: actual.UnsupportedBlobBackendError,
    BlobUnavailableError: actual.BlobUnavailableError,
    retainBlob: jest.fn(),
    releaseBlob: jest.fn(),
    releaseBlobIn: jest.fn(),
    openBlob: mockOpenBlob,
  };
});

const configState: { maxFileBytes: number } = { maxFileBytes: 33554432 };
jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({ limits: { maxFileBytes: configState.maxFileBytes } }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const filesController = require('../../src/controllers/filesController');

function buildApp(): express.Express {
  const app = express();
  // Stands in for the real auth middleware: every handler below only needs
  // an owner email on the request, which is all this suite is testing around.
  app.use((req: any, _res, next) => { req.apiKeyInfo = { email: 'owner@example.com' }; next(); });
  app.get('/files/:id/content', filesController.downloadFileContent);
  app.post('/files', filesController.uploadFile);
  return app;
}

describe('filesController over a real HTTP server (B10, B11)', () => {
  let server: http.Server;

  beforeAll((done) => {
    server = buildApp().listen(0, () => done());
  });

  afterAll((done) => { server.close(() => done()); });

  beforeEach(() => {
    dbState.available = true;
    configState.maxFileBytes = 33554432;
    poolQuery.mockReset();
    mockOpenBlob.mockReset();
  });

  // ---------------------------------------------------------------------
  // B10 — Content-Disposition with a non-Latin-1 or control-character name
  // ---------------------------------------------------------------------
  describe('downloadFileContent: Content-Disposition for an exotic filename', () => {
    function mockStoredFile(filename: string, bytes: Buffer): void {
      poolQuery.mockResolvedValue({ rows: [{ filename, sha256: 'ab'.repeat(32), mime: 'application/octet-stream' }] });
      mockOpenBlob.mockResolvedValue(bytes as never);
    }

    it('downloads a file whose name has characters above U+00FF: 200, not 500', async () => {
      mockStoredFile('日本語.pdf', Buffer.from('the bytes'));

      const res = await request(server).get('/files/file-x/content');

      expect(res.status).toBe(200);
      // Real Node header parsing already proves the header is well-formed —
      // supertest would not have gotten a response at all if `res.set` had
      // thrown ERR_INVALID_CHAR (the socket would reset mid-response instead).
      const disposition = res.headers['content-disposition'];
      expect(disposition).toContain('attachment;');
      expect(disposition).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf");
      expect(res.body.toString()).toBe('the bytes');
    });

    it('downloads a file whose name has a C0 control character: 200, not 500', async () => {
      mockStoredFile('a\x01b.txt', Buffer.from('more bytes'));

      const res = await request(server).get('/files/file-x/content');

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBeDefined();
      expect(res.body.toString()).toBe('more bytes');
    });

    it('leaves a plain-ASCII filename byte-identical to the old header form', async () => {
      mockStoredFile('plain-report.pdf', Buffer.from('x'));

      const res = await request(server).get('/files/file-x/content');

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="plain-report.pdf"');
    });
  });

  // ---------------------------------------------------------------------
  // B11 — the 413 must reach the client, not a socket reset
  // ---------------------------------------------------------------------
  describe('uploadFile: the 413 for an oversized upload reaches the client', () => {
    it('responds 413 with file_too_large JSON instead of resetting the connection', async () => {
      configState.maxFileBytes = 1024;
      const boundary = 'httpTestBoundary';
      const oversized = Buffer.alloc(64 * 1024, 'x'); // far over the 1 KB cap
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n`
          + 'Content-Type: application/octet-stream\r\n\r\n',
          'latin1',
        ),
        oversized,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
      ]);

      const res = await request(server)
        .post('/files')
        .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
        .send(body);

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('file_too_large');
    });
  });
});
