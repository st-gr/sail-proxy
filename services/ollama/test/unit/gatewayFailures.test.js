/**
 * The facade answers a gateway failure honestly: 502 when the gateway is unreachable or fails, the
 * gateway's own 4xx (401/403/429, and 400 for an over-long embeddings input) with its message, and
 * never an invented model. A local stand-in gateway listens on 127.0.0.1 with an ephemeral port;
 * nothing here dials the real gateway.
 */
const http = require('http');
const axios = require('axios');

let gatewayServer;
let gatewayPort;
let facadeServer;
let client;
let behaviour; // (req, res) => void for the next request
let seenKeys;

const listen = (server, port) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

const startGateway = () => {
  gatewayServer = http.createServer((req, res) => {
    seenKeys.push(req.headers['x-api-key']);
    req.resume();
    req.on('end', () => behaviour(req, res));
  });
  return listen(gatewayServer, gatewayPort || 0);
};

const refuse = (status, body) => (req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  // Defined but empty: dotenv does not override it from a .env file, and the lookup falls through to OPENAI_API_KEY.
  process.env.MAIN_PROXY_API_KEY = '';
  process.env.OPENAI_API_KEY = 'example-key-from-openai-env';
  seenKeys = [];
  gatewayPort = await startGateway();
  process.env.MAIN_PROXY_URL = `http://127.0.0.1:${gatewayPort}`;
  const app = require('../../index');
  const facadePort = await listen((facadeServer = http.createServer(app)), 0);
  client = axios.create({ baseURL: `http://127.0.0.1:${facadePort}`, validateStatus: () => true });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  await close(facadeServer);
  if (gatewayServer.listening) await close(gatewayServer);
});

beforeEach(() => {
  seenKeys.length = 0;
  behaviour = refuse(200, {});
});

describe('gateway unreachable', () => {
  beforeAll(async () => {
    await close(gatewayServer);
  });
  afterAll(async () => {
    await startGateway();
  });

  it('GET /api/tags answers 502 and invents no model', async () => {
    const response = await client.get('/api/tags');
    expect(response.status).toBe(502);
    expect(response.data.error.code).toBe('models_error');
    expect(JSON.stringify(response.data)).not.toContain('gpt-3.5-turbo');
  });

  it('GET /v1/models answers 502 in the OpenAI error shape', async () => {
    const response = await client.get('/v1/models');
    expect(response.status).toBe(502);
    expect(response.data.error).toEqual(expect.objectContaining({ type: 'api_error', code: 'models_error' }));
    expect(response.data.data).toBeUndefined();
  });

  it('chat, generate and embeddings answer 502', async () => {
    for (const [url, body] of [
      ['/api/chat', { model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] }],
      ['/api/chat', { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }],
      ['/api/generate', { model: 'm', stream: false, prompt: 'hi' }],
      ['/api/embed', { model: 'm', input: 'hi' }],
      ['/v1/embeddings', { model: 'm', input: 'hi' }]
    ]) {
      const response = await client.post(url, body);
      expect([url, response.status]).toEqual([url, 502]);
    }
  });
});

describe('gateway refusals', () => {
  const chat = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

  it.each([401, 403, 429])('passes %i through on chat, generate and embeddings with the gateway message', async (status) => {
    behaviour = refuse(status, { error: { message: `gateway says ${status}`, type: 'x', code: 'y' } });
    const calls = [
      ['/api/chat', { ...chat, stream: false }],
      ['/api/chat', { ...chat, stream: true }],
      ['/api/generate', { model: 'm', prompt: 'hi', stream: false }],
      ['/api/generate', { model: 'm', prompt: 'hi', stream: true }],
      ['/api/embed', { model: 'm', input: 'hi' }],
      ['/v1/chat/completions', { ...chat, stream: false }],
      ['/v1/chat/completions', { ...chat, stream: true }],
      ['/v1/embeddings', { model: 'm', input: 'hi' }]
    ];
    for (const [url, body] of calls) {
      const response = await client.post(url, body);
      expect([url, body.stream, response.status]).toEqual([url, body.stream, status]);
      expect(response.data.error.message).toBe(`gateway says ${status}`);
    }
  });

  it('passes the gateway 400 for an over-long embeddings input through as 400', async () => {
    behaviour = refuse(400, { error: { message: 'input is too long' } });
    const response = await client.post('/api/embed', { model: 'm', input: 'hi' });
    expect(response.status).toBe(400);
    expect(response.data.error.message).toBe('input is too long');
    expect(response.data.error.code).toBe('embeddings_error');
  });

  it('accepts a plain-string or message-only gateway error body', async () => {
    behaviour = refuse(429, { error: 'slow down' });
    expect((await client.post('/api/embed', { model: 'm', input: 'hi' })).data.error.message).toBe('slow down');
    behaviour = refuse(429, { message: 'quota used up' });
    expect((await client.post('/api/embed', { model: 'm', input: 'hi' })).data.error.message).toBe('quota used up');
  });

  it('answers 502 for a gateway 5xx', async () => {
    behaviour = refuse(500, { error: { message: 'upstream exploded' } });
    for (const [url, body] of [
      ['/api/chat', { ...chat, stream: false }],
      ['/api/chat', { ...chat, stream: true }],
      ['/api/embed', { model: 'm', input: 'hi' }]
    ]) {
      const response = await client.post(url, body);
      expect([url, response.status]).toEqual([url, 502]);
      expect(response.data.error.message).toBe('upstream exploded');
    }
    expect((await client.get('/api/tags')).status).toBe(502);
  });
});

describe('/api/show key lookup', () => {
  it('uses the shared key lookup: with only OPENAI_API_KEY set, capabilities come from the gateway', async () => {
    behaviour = refuse(200, {
      data: [
        {
          id: 'gpt-3-example',
          versions: [{ isLatest: true, capabilities: ['chat-completions'], inputTypes: ['text'], contextLength: 8192 }]
        }
      ]
    });
    const response = await client.post('/api/show', { model: 'gpt-3-example' });
    expect(response.status).toBe(200);
    expect(seenKeys).toEqual(['example-key-from-openai-env']);
    expect(response.data.parameters).toContain('num_ctx                        8192');
  });
});
