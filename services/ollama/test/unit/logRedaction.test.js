/**
 * The facade's logs carry neither the gateway key nor the conversation. An AxiosError holds the
 * request config — its headers carry x-api-key (MAIN_PROXY_API_KEY) and its data the prompt — so a
 * failed gateway call is logged by status, code and message only, and a request is logged by model
 * and size, never by its body. The thrown error carries no config either, so no later log site can
 * print it.
 *
 * axios is mocked: every gateway call fails the way a timeout or a reset does.
 */
const util = require('util');

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('axios', () => ({ create: jest.fn() }));

const axios = require('axios');

const KEY = 'example-gateway-key-0123456789';
const PROMPT = 'Write to jane.roe@example.org about the invoice';

function axiosFailure(code, message) {
  return Object.assign(new Error(message), {
    name: 'AxiosError',
    isAxiosError: true,
    code,
    config: { headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' }, data: JSON.stringify({ prompt: PROMPT }) },
    request: { _header: `POST /openai/v1/chat/completions HTTP/1.1\r\nx-api-key: ${KEY}\r\n` },
  });
}

let logged;
let controller;
let shared;

beforeAll(() => {
  process.env.MAIN_PROXY_API_KEY = KEY;
  process.env.MAIN_PROXY_URL = 'http://gateway.example.invalid';
  const failing = () => Promise.reject(axiosFailure('ECONNABORTED', 'timeout of 120000ms exceeded'));
  axios.create.mockImplementation(() => ({ post: failing, get: failing, put: failing, delete: failing }));
  shared = require('../../services/shared');
  controller = require('../../controllers/ollamaController');
});

afterAll(() => {
  delete process.env.MAIN_PROXY_API_KEY;
  delete process.env.MAIN_PROXY_URL;
});

beforeEach(() => {
  logged = [];
  const capture = (...args) => { logged.push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 10 }))).join(' ')); };
  jest.spyOn(console, 'log').mockImplementation(capture);
  jest.spyOn(console, 'error').mockImplementation(capture);
  jest.spyOn(console, 'warn').mockImplementation(capture);
});

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, writes: [] };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.write = (chunk) => { res.writes.push(String(chunk)); return true; };
  res.end = () => res;
  res.on = () => res;
  return res;
}

function expectNothingSensitiveLogged() {
  const all = logged.join('\n');
  expect(all).not.toContain(KEY);
  expect(all).not.toContain(PROMPT);
  expect(all).not.toContain('jane.roe@example.org');
}

describe('a gateway call that fails without an answer (timeout, reset)', () => {
  it.each([
    ['callMainProxy', () => shared.callMainProxy('/openai/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: PROMPT }] })],
    ['callMainProxyStreaming', () => shared.callMainProxyStreaming('/openai/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: PROMPT }] })],
  ])('%s: rethrows an error without the request config, logs neither key nor prompt', async (_n, call) => {
    const error = await call().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.upstream).toBe(true);
    expect(error.code).toBe('ECONNABORTED');
    expect(error.config).toBeUndefined();
    expect(error.request).toBeUndefined();
    expect(util.inspect(error, { depth: 10 })).not.toContain(KEY);
    expect(logged.join('\n')).toContain('ECONNABORTED');
    expectNothingSensitiveLogged();
  });
});

describe('the controllers', () => {
  it.each([
    ['/api/chat', 'handleChat', { model: 'gpt-4o', stream: false, messages: [{ role: 'user', content: PROMPT }] }],
    ['/api/chat streaming', 'handleChat', { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: PROMPT }] }],
    ['/api/generate', 'handleGenerate', { model: 'gpt-4o', stream: false, prompt: PROMPT }],
    ['/api/embed', 'handleEmbed', { model: 'text-embedding-3-small', input: PROMPT }],
    ['/v1/chat/completions', 'handleOpenAIChat', { model: 'gpt-4o', messages: [{ role: 'user', content: PROMPT }] }],
    ['/v1/embeddings', 'handleOpenAIEmbeddings', { model: 'text-embedding-3-small', input: PROMPT }],
  ])('%s: a failed gateway call answers 502 and logs neither key nor prompt', async (_n, handler, body) => {
    const res = mockRes();
    await controller[handler]({ body, headers: {}, query: {}, params: {}, on: () => {} }, res);
    expect(res.statusCode).toBe(502);
    expectNothingSensitiveLogged();
  });
});
