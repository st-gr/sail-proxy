/**
 * Task 6 (B11): `/openai/v1/images/edits` shares `parseMultipartFields`
 * (utils/multipart.ts) with the files upload endpoint, and had the same bug —
 * `req.destroy()` inside the parser's data callback ran before the "too
 * large" response was written on the same connection, so the client saw a
 * socket reset instead of the `file_too_large` JSON. See
 * filesController-http.test.ts for the equivalent case on `/files`, and why
 * this needs a REAL HTTP server + client rather than a mocked req/res.
 */
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

import request from 'supertest';
import express from 'express';
import * as http from 'http';

const loggerNoop = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => loggerNoop }));

// MAX_UPLOAD_BYTES (20 MiB) is a fixed constant, not a runtime config value —
// overriding just that export (keeping everything else, e.g. MAX_IMAGES,
// real) lets this test trip the per-file cap with a small, fast payload
// instead of actually sending 20+ MiB.
jest.mock('../src/controllers/imagesMapping', () => {
  const actual: any = jest.requireActual('../src/controllers/imagesMapping');
  return { ...actual, MAX_UPLOAD_BYTES: 1024 };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const imagesController = require('../src/controllers/imagesController');

describe('imagesController.editImage over a real HTTP server (B11)', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = express();
    app.post('/edits', imagesController.editImage);
    server = app.listen(0, () => done());
  });

  afterAll((done) => { server.close(() => done()); });

  it('responds with the file_too_large JSON instead of resetting the connection', async () => {
    const boundary = 'imagesHttpTestBoundary';
    const oversized = Buffer.alloc(64 * 1024, 'y'); // far over the (mocked) 1 KB per-file cap
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="big.png"\r\n`
        + 'Content-Type: image/png\r\n\r\n',
        'latin1',
      ),
      oversized,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
    ]);

    const res = await request(server)
      .post('/edits')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('file_too_large');
  });
});
