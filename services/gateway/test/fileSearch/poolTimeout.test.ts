/**
 * A file_search request that cannot get a database connection in time fails fast with a clean 503:
 * the runtime pool turns pg's connect timeouts into FileSearchBusyError, which the files and vector
 * store routes answer as `503 file_search_busy` (type file_search_unavailable) without driver text.
 * No Postgres: a TCP server that accepts and never answers stands in for an unresponsive database.
 */
import * as net from 'net';
import express from 'express';
import request from 'supertest';

const loggerNoop = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => loggerNoop }));

// eslint-disable-next-line import/first
import { createFileSearchPool, FileSearchBusyError, POOL_CONNECTION_TIMEOUT_MS } from '../../src/fileSearch/db';
// eslint-disable-next-line import/first
import errorHandler from '../../src/middlewares/errorHandler';

describe('the file_search pool fails fast when no connection becomes available', () => {
  let server: net.Server;
  let port: number;
  const sockets: net.Socket[] = [];

  beforeAll(async () => {
    server = net.createServer((socket) => { sockets.push(socket); }); // accepts, never answers
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('has a connection timeout (15 s)', () => {
    expect(POOL_CONNECTION_TIMEOUT_MS).toBe(15_000);
  });

  it('a connect that times out, a wait for a full pool, and pool.query all reject with FileSearchBusyError', async () => {
    const pool = createFileSearchPool(`postgresql://u:p@127.0.0.1:${port}/db`, { max: 1, connectionTimeoutMillis: 150 });
    pool.on('error', () => {});
    try {
      const first = pool.connect();            // a new client that never connects
      const waiting = pool.connect();          // the pool is full: waits for a free client
      const viaQuery = pool.query('SELECT 1');  // connects through connect() as well
      const viaCallback = new Promise<unknown>((resolve) => {
        pool.connect((err) => resolve(err));
      });
      const errors = await Promise.all([first, waiting, viaQuery].map((p) => p.then(() => null, (e) => e)));
      errors.push(await viaCallback);
      for (const e of errors) {
        expect(e).toBeInstanceOf(FileSearchBusyError);
        expect((e as FileSearchBusyError).status).toBe(503);
        expect((e as Error).message).not.toMatch(/127\.0\.0\.1|timeout exceeded|terminated/);
      }
    } finally {
      await pool.end().catch(() => {});
    }
  });

  it('any other connect error is passed on unchanged', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()));
    const closedPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const pool = createFileSearchPool(`postgresql://u:p@127.0.0.1:${closedPort}/db`, { max: 1, connectionTimeoutMillis: 1000 });
    pool.on('error', () => {});
    try {
      const e = await pool.connect().then(() => null, (err) => err);
      expect(e).not.toBeInstanceOf(FileSearchBusyError);
      expect(e.code).toBe('ECONNREFUSED');
    } finally {
      await pool.end().catch(() => {});
    }
  });
});

describe('routes answer FileSearchBusyError as a 503 file_search_busy without internals', () => {
  // The files and vector store routes answer it in the file_search envelope; anything that still
  // reaches the global handler gets its `status` and fixed message.
  const handlers: Record<string, (req: any, res: any, next: any) => Promise<void>> = {};

  beforeAll(() => {
    jest.resetModules();
    const busy = () => Promise.reject(new (jest.requireActual('../../src/fileSearch/db') as any).FileSearchBusyError());
    jest.doMock('../../src/fileSearch/db', () => {
      const actual: any = jest.requireActual('../../src/fileSearch/db');
      return {
        ...actual,
        isFileSearchAvailable: () => true,
        getPool: () => ({ query: busy, connect: busy }),
      };
    });
    jest.doMock('../../src/fileSearch/blob/blobStore', () => {
      const actual: any = jest.requireActual('../../src/fileSearch/blob/blobStore');
      return { ...actual, retainBlob: busy, openBlob: busy };
    });
    jest.doMock('../../src/services/configService', () => {
      const actual: any = jest.requireActual('../../src/services/configService');
      return {
        ...actual,
        getFileSearchConfig: () => ({ ...actual.getFileSearchConfig(), enabled: true, limits: { maxFileBytes: 1024, maxTokensPerFile: 1, maxFilesPerStore: 1 } }),
      };
    });
    /* eslint-disable @typescript-eslint/no-var-requires */
    const files = require('../../src/controllers/filesController');
    const stores = require('../../src/controllers/vectorStoresController');
    /* eslint-enable @typescript-eslint/no-var-requires */
    Object.assign(handlers, {
      listFiles: files.listFiles,
      retrieveFile: files.retrieveFile,
      deleteFile: files.deleteFile,
      downloadFileContent: files.downloadFileContent,
      uploadFile: files.uploadFile,
      listVectorStores: stores.listVectorStores,
      retrieveVectorStore: stores.retrieveVectorStore,
    });
  });

  function app(): express.Express {
    const a = express();
    a.use((req: any, _res, next) => { req.apiKeyInfo = { email: 'owner@example.com' }; next(); });
    a.get('/files', handlers.listFiles);
    a.get('/files/:id', handlers.retrieveFile);
    a.delete('/files/:id', handlers.deleteFile);
    a.get('/files/:id/content', handlers.downloadFileContent);
    a.post('/files', handlers.uploadFile);
    a.get('/vector_stores', handlers.listVectorStores);
    a.get('/vector_stores/:id', handlers.retrieveVectorStore);
    a.use(errorHandler); // a route that missed the mapping would answer `code: 503` here and fail
    return a;
  }

  function expectBusy(res: request.Response): void {
    expect(res.status).toBe(503);
    // The envelope of the other file_search 503s, with its own string code.
    expect(res.body.error).toMatchObject({
      message: new FileSearchBusyError().message, type: 'file_search_unavailable', code: 'file_search_busy',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/timeout exceeded|terminated|stack|pg-pool/);
  }

  it.each([
    ['GET', '/files'], ['GET', '/files/file-abc'], ['DELETE', '/files/file-abc'], ['GET', '/files/file-abc/content'],
    ['GET', '/vector_stores'], ['GET', '/vector_stores/vs_abc'],
  ])('%s %s', async (method, path) => {
    const res = method === 'GET' ? await request(app()).get(path) : await request(app()).delete(path);
    expectBusy(res);
  });

  it('POST /files (the retain could not get a connection)', async () => {
    const res = await request(app()).post('/files')
      .field('purpose', 'assistants')
      .attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    expectBusy(res);
  });
});
