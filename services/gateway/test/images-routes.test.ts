import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

const CATALOGUE: Record<string, any> = {
  'gemini-3.1-flash-image': { id: 'gemini-3.1-flash-image', model: 'gemini-3.1-flash-image', owned_by: 'Google' },
  'gemini-3.1-flash-image--deployed': { id: 'gemini-3.1-flash-image--deployed', model: 'gemini-3.1-flash-image', provider: 'google', deploymentUrl: 'http://mock-sap/v2/inference/deployments/d-img' },
  'gemini-3-pro-image': { id: 'gemini-3-pro-image', model: 'gemini-3-pro-image', owned_by: 'Google' },
  'anthropic--claude-4.5-sonnet--deployed': { id: 'anthropic--claude-4.5-sonnet--deployed', model: 'anthropic--claude-4.5-sonnet', provider: 'Anthropic', deploymentUrl: 'http://mock-sap/v2/inference/deployments/d-son' },
};
// Overridable per test (reset in beforeEach) so a token or catalog failure can be simulated
// without a fresh jest.mock for every scenario.
let getAuthTokenImpl: () => Promise<string> = () => Promise.resolve('test-token');
let getModelDetailsImpl: (m: string) => Promise<any> = (m: string) => Promise.resolve(CATALOGUE[m] || null);
jest.mock('../src/services/modelService', () => ({ __esModule: true, default: { getModelDetails: (m: string) => getModelDetailsImpl(m), getAuthToken: () => getAuthTokenImpl() } }));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: { getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'rg-test' }), getTimeout: () => 1000, getTrustForwardedFor: () => false }, getTrustForwardedFor: () => false }));
const notEntitled: any[] = [];
jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: jest.fn(async (e: any) => { notEntitled.push(e); }) } }));
const emitted: any[] = [];
jest.mock('../src/utils/usageTracker', () => {
  const actual: any = jest.requireActual('../src/utils/usageTracker');
  return { ...actual, emitUsageEvent: jest.fn(async (req: any, metrics: any, model: string, status: number) => { emitted.push({ metrics: { ...metrics }, model, status, requestId: req.debugRequestId }); }) };
});
let auth: any = { valid: true, authType: 'api_key', data: { keyId: 'k1', email: 'u@test.com', rateLimits: {} } };
jest.mock('../src/middlewares/unifiedTokenAuth', () => ({ __esModule: true, default: (_r: any, _s: any, n: any) => n(), createUnifiedTokenAuth: () => (req: any, _res: any, next: any) => { req.unifiedAuth = auth; req.debugRequestId = 'gateway-test-1'; next(); } }));
jest.mock('../src/middlewares/quotaEnforcement', () => ({ __esModule: true, default: (_r: any, _s: any, n: any) => n() }));
jest.mock('../src/services/unifiedAuthProxyService', () => ({ __esModule: true, unifiedAuthProxyService: { createServiceAuthMiddleware: () => (_r: any, _s: any, n: any) => n() }, serviceConfigurations: { openai: { serviceName: 'openai' } } }));

const posted: Array<{ url: string; body: any; cfg: any }> = [];
let responses: Array<any> = [];
const geminiImage = (id: string, extraParts: any[] = []) => ({
  candidates: [{ content: { role: 'model', parts: [...extraParts, { inlineData: { mimeType: 'image/png', data: `IMG_${id}` } }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 1296, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 17 }], candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }, { modality: 'TEXT', tokenCount: 6 }] },
});
jest.mock('axios', () => ({ __esModule: true, default: { post: (url: string, body: any, cfg: any) => {
  posted.push({ url, body, cfg });
  const next = responses.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve({ status: 200, data: next ?? geminiImage(String(posted.length)) });
} } }));

import imagesRoutes from '../src/routes/imagesRoutes';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/openai/v1/images', imagesRoutes);

beforeEach(() => {
  posted.length = 0; responses = []; emitted.length = 0; notEntitled.length = 0;
  auth = { valid: true, authType: 'api_key', data: { keyId: 'k1', email: 'u@test.com', rateLimits: {} } };
  getAuthTokenImpl = () => Promise.resolve('test-token');
  getModelDetailsImpl = (m: string) => Promise.resolve(CATALOGUE[m] || null);
});

const upstreamError = (status: number, message: string) => { const e: any = new Error(message); e.response = { status, data: { error: { message } } }; return e; };

describe('POST /openai/v1/images/generations', () => {
  it('translates one request into one Gemini call on the deployment and answers the OpenAI shape', async () => {
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'a red circle', size: '1024x1024' });
    expect(r.status).toBe(200);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('http://mock-sap/v2/inference/deployments/d-img/models/gemini-3.1-flash-image:generateContent');
    expect(posted[0].body.generationConfig).toEqual({ responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: '1:1', imageSize: '1K' } });
    expect(posted[0].cfg.headers).toMatchObject({ Authorization: 'Bearer test-token', 'AI-Resource-Group': 'rg-test' });
    expect(r.body.data).toEqual([{ b64_json: 'IMG_1' }]);
    expect(r.body.output_format).toBe('png');
    expect(r.body.size).toBe('1024x1024');
    expect(r.body.usage).toEqual({ input_tokens: 17, output_tokens: 1296, total_tokens: 1313, input_tokens_details: { text_tokens: 17, image_tokens: 0 }, output_tokens_details: { text_tokens: 6, image_tokens: 1290 } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ model: 'gemini-3.1-flash-image--deployed', status: 200, metrics: { inputTokens: 17, outputTokens: 1296, imageOutputTokens: 1290 } });
  });
  it('accepts the --deployed twin id and drops a text part from the body while keeping its tokens', async () => {
    responses = [geminiImage('a', [{ text: 'Here you go' }])];
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image--deployed', prompt: 'p' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([{ b64_json: 'IMG_a' }]);
    expect(r.body.usage.output_tokens_details.text_tokens).toBe(6);
  });
  it('n=3 makes three sequential calls, three usage events, and bundles the images in order', async () => {
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'p', n: 3 });
    expect(r.status).toBe(200);
    expect(posted).toHaveLength(3);
    expect(r.body.data.map((d: any) => d.b64_json)).toEqual(['IMG_1', 'IMG_2', 'IMG_3']);
    expect(r.body.usage.output_tokens_details.image_tokens).toBe(3870);
    expect(emitted).toHaveLength(3);
    // Every call of the loop is its own billable request: distinct ids, suffixed per call.
    expect(emitted.map((e) => e.requestId)).toEqual(['gateway-test-1-1', 'gateway-test-1-2', 'gateway-test-1-3']);
  });
  it('a single-image request keeps the connection request id unsuffixed', async () => {
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'p' });
    expect(r.status).toBe(200);
    expect(emitted.map((e) => e.requestId)).toEqual(['gateway-test-1']);
  });
  it('a failure on the third call answers 502 after the two produced images were metered', async () => {
    responses = [undefined, undefined, upstreamError(500, 'boom')];
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'p', n: 3 });
    expect(r.status).toBe(502);
    expect(r.body.error.type).toBe('upstream_error');
    expect(r.body.error.upstream_status).toBe(500);
    expect(emitted.filter((e) => e.status === 200)).toHaveLength(2);
    expect(emitted.filter((e) => e.status === 502)).toHaveLength(1);
  });
  it('SAP 503 stays 503', async () => {
    responses = [upstreamError(503, 'busy')];
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'p' });
    expect(r.status).toBe(503);
  });
  it('a response without an image part is a 502 naming the finish reason', async () => {
    responses = [{ candidates: [{ content: { parts: [{ text: 'no' }] }, finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }];
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'p' });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toContain('SAFETY');
    expect(emitted).toHaveLength(1);
    // The tokens are recorded against the status the client actually receives (502), not the
    // upstream call's own 200 — the usage event and the response must agree.
    expect(emitted[0].status).toBe(502);
  });
  it('502s (never hangs) when the SAP AI Core token fetch fails, with no upstream call or usage event', async () => {
    getAuthTokenImpl = () => Promise.reject(new Error('Failed to authenticate with SAP AI Core'));
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'p' });
    expect(r.status).toBe(502);
    expect(r.body.error.type).toBe('upstream_error');
    expect(r.body.error.message).toContain('Failed to authenticate');
    expect(posted).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
  it('500s (never hangs) when the model catalog lookup throws', async () => {
    getModelDetailsImpl = () => Promise.reject(new Error('catalog lookup exploded'));
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'p' });
    expect(r.status).toBe(500);
    expect(r.body.error.type).toBe('server_error');
    expect(posted).toHaveLength(0);
  });
  it('404 model_not_found for a model without a Google deployment or for a non-Google deployment', async () => {
    for (const model of ['gemini-3-pro-image', 'anthropic--claude-4.5-sonnet--deployed', 'gpt-image-1']) {
      const r = await request(app).post('/openai/v1/images/generations').send({ model, prompt: 'p' });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('model_not_found');
      expect(r.body.error.message).toContain('gemini-3.1-flash-image');
    }
    expect(posted).toHaveLength(0);
  });
  it('403 model_not_entitled on the twin when the catalog lists only the bare id, with the security event', async () => {
    auth = { ...auth, data: { keyId: 'k1', entitlement: { mode: 'list', include: ['gemini-3.1-flash-image'], catalogId: 'c1', catalogName: 'Team' } } };
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'p' });
    expect(r.status).toBe(403);
    expect(r.body.error.type).toBe('model_not_entitled');
    expect(notEntitled).toHaveLength(1);
    expect(posted).toHaveLength(0);
  });
  it('400 invalid_request_error with param for a refused parameter, before any upstream call', async () => {
    const r = await request(app).post('/openai/v1/images/generations').send({ model: 'gemini-3.1-flash-image', prompt: 'p', response_format: 'url' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ type: 'invalid_request_error', param: 'response_format' });
    expect(posted).toHaveLength(0);
  });
});

describe('POST /openai/v1/images/edits', () => {
  it('sends the uploaded images as inlineData parts before the prompt', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const r = await request(app).post('/openai/v1/images/edits')
      .field('model', 'gemini-3.1-flash-image').field('prompt', 'make it blue').field('n', '1')
      .attach('image[]', png, { filename: 'a.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    expect(posted[0].body.contents[0].parts).toEqual([{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }, { text: 'make it blue' }]);
    expect(r.body.data).toEqual([{ b64_json: 'IMG_1' }]);
  });
  it('carries a long prompt through intact instead of truncating it at the multipart field cap', async () => {
    // The shared parser's default per-field budget is 1 KB; /edits raises it to 32 KB because
    // the prompt IS the instruction. A 3000-character prompt must reach the deployment whole.
    // No leading/trailing whitespace: the shared parser trims every text field (pre-existing).
    const prompt = `${'make the sky bluer. '.repeat(149)}make the sky bluer.`;
    expect(prompt).toHaveLength(2999);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const r = await request(app).post('/openai/v1/images/edits')
      .field('model', 'gemini-3.1-flash-image').field('prompt', prompt)
      .attach('image[]', png, { filename: 'a.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    expect(posted[0].body.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }, { text: prompt },
    ]);
  });
  it('400s a prompt over the 32 KB text-field limit on param prompt, before any upstream call', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const r = await request(app).post('/openai/v1/images/edits')
      .field('model', 'gemini-3.1-flash-image').field('prompt', 'z'.repeat(32 * 1024 + 1))
      .attach('image[]', png, { filename: 'a.png', contentType: 'image/png' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ type: 'invalid_request_error', param: 'prompt' });
    expect(r.body.error.message).toContain('32 KB');
    expect(posted).toHaveLength(0);
  });
  it('400s style and moderation, which used to slip through the multipart field list', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    for (const [field, value] of [['style', 'vivid'], ['moderation', 'low']]) {
      posted.length = 0;
      const r = await request(app).post('/openai/v1/images/edits')
        .field('model', 'gemini-3.1-flash-image').field('prompt', 'p').field(field, value)
        .attach('image[]', png, { filename: 'a.png', contentType: 'image/png' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ type: 'invalid_request_error', param: field });
      expect(posted).toHaveLength(0);
    }
  });
  it('400s more than four image parts on param image', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    let req5 = request(app).post('/openai/v1/images/edits')
      .field('model', 'gemini-3.1-flash-image').field('prompt', 'p');
    for (let i = 0; i < 5; i++) req5 = req5.attach('image[]', png, { filename: `a${i}.png`, contentType: 'image/png' });
    const r = await req5;
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ type: 'invalid_request_error', param: 'image' });
    expect(posted).toHaveLength(0);
  });
  it('treats an empty text field as absent and refuses a stream value that is neither true nor false', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const send = (extra: (r: any) => any) => extra(request(app).post('/openai/v1/images/edits')
      .field('model', 'gemini-3.1-flash-image').field('prompt', 'p'))
      .attach('image[]', png, { filename: 'a.png', contentType: 'image/png' });

    // Empty fields are what an SDK sends for options the caller never set.
    let r = await send((q: any) => q.field('size', '').field('quality', '').field('n', '').field('stream', ''));
    expect(r.status).toBe(200);
    expect(posted[0].body.generationConfig).toEqual({ responseModalities: ['IMAGE', 'TEXT'] });

    posted.length = 0;
    r = await send((q: any) => q.field('stream', 'false'));
    expect(r.status).toBe(200);
    expect(posted).toHaveLength(1);

    posted.length = 0;
    r = await send((q: any) => q.field('stream', 'true'));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ type: 'invalid_request_error', param: 'stream' });

    posted.length = 0;
    r = await send((q: any) => q.field('stream', '1'));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ type: 'invalid_request_error', param: 'stream' });
    expect(posted).toHaveLength(0);
  });
  it('400s a mask, a non-image upload and a JSON body', async () => {
    const png = Buffer.from([1, 2, 3]);
    let r = await request(app).post('/openai/v1/images/edits').field('model', 'gemini-3.1-flash-image').field('prompt', 'p')
      .attach('image', png, { filename: 'a.png', contentType: 'image/png' }).attach('mask', png, { filename: 'm.png', contentType: 'image/png' });
    expect(r.status).toBe(400); expect(r.body.error.param).toBe('mask');
    r = await request(app).post('/openai/v1/images/edits').field('model', 'gemini-3.1-flash-image').field('prompt', 'p')
      .attach('image', Buffer.from('%PDF'), { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(400); expect(r.body.error.param).toBe('image');
    r = await request(app).post('/openai/v1/images/edits').send({ model: 'gemini-3.1-flash-image', prompt: 'p' });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('invalid_content_type');
    expect(posted).toHaveLength(0);
  });
});
