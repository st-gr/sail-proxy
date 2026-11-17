/**
 * The raw capture tap: for a request of a credential in a running session it records the arrival,
 * keeps the bytes the client received and publishes the sealed stages once the response is over.
 * Everyone else passes through untouched. Real HTTP, so a client that hangs up is a real hang-up.
 *
 * @see ../src/middlewares/rawCaptureTap.ts
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockValidateApiKey = jest.fn<any>();
jest.mock('../src/services/unifiedApiKeyValidationService', () => ({
  unifiedApiKeyValidationService: { validateApiKey: (...args: any[]) => mockValidateApiKey(...args) },
}));
jest.mock('../src/config/unifiedAuthConfig', () => {
  const actual = jest.requireActual<any>('../src/config/unifiedAuthConfig');
  return { __esModule: true, ...actual, getCachedUnifiedAuthConfig: () => ({ enabled: true, fallbackToLocal: false }) };
});

import { openSealed } from '@libs/trace-seal';
import { rawCaptureTap, RAW_CAPTURE_CLOSE_GRACE_MS } from '../src/middlewares/rawCaptureTap';
import { createUnifiedTokenAuth } from '../src/middlewares/unifiedTokenAuth';
import { applySessions, clearRawCaptureState, openCollectorCount, recordStage, RawTraceMessage } from '../src/services/rawCapture';
import { savePayload } from '../src/utils/payloadLogger';
import { credentialIdOf, extractAuthInfo } from '../src/utils/usageTracker';
import securityEventEmitter from '../src/services/securityEventEmitter';

const ENV_KEY = randomBytes(32).toString('hex');
const CANARY = 'Jane Roe of 7 Example Lane';
const ROUTE = '/openai/v1/chat/completions';

let xadd: jest.Mock<(...args: string[]) => Promise<string>>;
let server: http.Server | undefined;
let base = '';
let seq = 0;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['METADATA_ENCRYPTION_KEY', 'PAYLOAD_LOGGING_ENABLED']) savedEnv[k] = process.env[k];
  process.env.METADATA_ENCRYPTION_KEY = ENV_KEY;
  process.env.PAYLOAD_LOGGING_ENABLED = 'false';
  xadd = jest.fn(async (..._args: string[]) => '1-0');
  securityEventEmitter.setValkeyClient({ status: 'ready', xadd });
  clearRawCaptureState();
  applySessions(JSON.stringify({ sessions: [{ id: 's-1', credentialIds: ['cred-jane'], endsAt: '2099-01-01T00:00:00.000Z' }] }), new Date());
});
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  securityEventEmitter.setValkeyClient(undefined);
  clearRawCaptureState();
  await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
  server = undefined;
});

type Handler = (req: any, res: express.Response) => void;

/** An app shaped like the gateway's: request id, JSON body, authentication, then the tap. */
async function start(handler: Handler, auth: express.RequestHandler = fakeAuth): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.debugRequestId = `gateway-test-${++seq}`; next(); });
  app.post(ROUTE, auth, handler);
  app.get('/v1/models', auth, handler);
  app.post(['/v1/models/cache/clear', '/openai/v1/models/cache/clear'], auth, handler);
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** Authentication that trusts the test header, then the tap, as createUnifiedTokenAuth chains them. */
const fakeAuth: express.RequestHandler = (req: any, res, next) => {
  req.unifiedAuth = { valid: true, authType: 'api_key', data: { id: req.get('x-test-credential') } };
  rawCaptureTap(req, res, next);
};

// The collector closes RAW_CAPTURE_CLOSE_GRACE_MS after the response, so a real-HTTP case waits past it.
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 800 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

function message(): RawTraceMessage {
  expect(xadd).toHaveBeenCalledTimes(1);
  return JSON.parse(xadd.mock.calls[0][6]);
}

function stages(m: RawTraceMessage): { name: string; content: string }[] {
  const opened = openSealed(m.sealedStages, process.env);
  if (!opened.ok) throw new Error(opened.reason);
  return JSON.parse(opened.text);
}

const body = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: `Write to ${CANARY}` }] });

describe('a request of a selected credential', () => {
  it('publishes the arrival, its stages (with and without req) and what the client received, in order', async () => {
    let sessionSeen: unknown;
    await start((req, res) => {
      sessionSeen = req.__rawCaptureSessionId;
      savePayload(req.debugRequestId, '02_sap_request_payload', { prompt: CANARY });
      savePayload(req.debugRequestId, '03_sap_response_raw', { answer: 'Hello Jane' }, req, res);
      res.status(200).json({ choices: [{ message: { content: 'Hello Jane' } }] });
    });
    const r = await fetch(`${base}${ROUTE}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-credential': 'cred-jane' }, body });
    expect(r.status).toBe(200);
    await r.text();
    await waitFor(() => xadd.mock.calls.length > 0);

    const m = message();
    expect(sessionSeen).toBe('s-1');
    expect(m.stageIndex.map((s) => s.name)).toEqual(['00_arrival', '02_sap_request_payload', '03_sap_response_raw', 'zz_client_response']);
    const opened = stages(m);
    expect(JSON.parse(opened[0].content)).toMatchObject({ httpMethod: 'POST', payload: { model: 'gpt-4o' } });
    const client = JSON.parse(opened[3].content);
    expect(client).toMatchObject({ statusCode: 200, complete: true });
    expect(JSON.parse(client.payload)).toEqual({ choices: [{ message: { content: 'Hello Jane' } }] });
    expect(xadd.mock.calls[0][6]).not.toContain('Jane Roe');
    expect(openCollectorCount()).toBe(0);
  });

  it('redacts the Authorization header and an api_key in the URL in the arrival', async () => {
    const bearer = randomBytes(16).toString('hex');
    const queryKey = randomBytes(16).toString('hex');
    await start((_req, res) => { res.json({ ok: true }); });
    const r = await fetch(`${base}${ROUTE}?api_key=${queryKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-credential': 'cred-jane', Authorization: `Bearer ${bearer}` }, body,
    });
    await r.text();
    await waitFor(() => xadd.mock.calls.length > 0);
    const arrival = stages(message())[0];
    expect(arrival.name).toBe('00_arrival');
    expect(arrival.content).not.toContain(bearer);
    expect(arrival.content).not.toContain(queryKey);
    const parsed = JSON.parse(arrival.content);
    expect(parsed.requestHeaders.authorization).toBe('[REDACTED]');
    expect(parsed.url).toContain('api_key=***');
  });

  it('publishes what was collected when the client hangs up mid-stream, marked incomplete, and forgets the request', async () => {
    let closed!: () => void;
    const serverSawClose = new Promise<void>((r) => { closed = r; });
    await start((req, res) => {
      res.status(200).setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"delta":"Hel"}\n\n');
      savePayload(req.debugRequestId, '02_streaming_request_payload', { stream: true });
      res.on('close', () => closed());
    });
    await new Promise<void>((resolve, reject) => {
      const client = http.request(`${base}${ROUTE}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-credential': 'cred-jane' } }, (res) => {
        res.once('data', () => { client.destroy(); resolve(); });
      });
      client.on('error', () => { /* the hang-up itself */ });
      client.on('timeout', () => reject(new Error('no data')));
      client.end(body);
    });
    await serverSawClose;
    await waitFor(() => xadd.mock.calls.length > 0);
    const m = message();
    expect(m.stageIndex.map((s) => s.name)).toEqual(['00_arrival', '02_streaming_request_payload', 'zz_client_response']);
    const client = JSON.parse(stages(m)[2].content);
    expect(client.complete).toBe(false);
    expect(client.payload).toContain('data: {"delta":"Hel"}');
    expect(openCollectorCount()).toBe(0);
  });
});

describe('everyone else', () => {
  it('passes a request of an unselected credential with res.write untouched', async () => {
    let writeSeen: unknown;
    await start((req: any, res) => { writeSeen = res.write; res.json({ ok: req.__rawCaptureSessionId === undefined }); });
    const r = await fetch(`${base}${ROUTE}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-credential': 'cred-other' }, body });
    expect(await r.json()).toEqual({ ok: true });
    expect(writeSeen).toBe(http.ServerResponse.prototype.write);
    await new Promise((r2) => setTimeout(r2, 20));
    expect(xadd).not.toHaveBeenCalled();
  });

  it('does not capture a request that is not an inference call', async () => {
    await start((_req, res) => { res.json({ data: [] }); });
    const r = await fetch(`${base}/v1/models`, { headers: { 'x-test-credential': 'cred-jane' } });
    await r.text();
    await new Promise((r2) => setTimeout(r2, 20));
    expect(xadd).not.toHaveBeenCalled();
  });

  it('does not capture the model cache clear, a POST with a JSON body that is no inference call', async () => {
    let sessionSeen: unknown = 'not called';
    let writeSeen: unknown;
    await start((req: any, res) => { sessionSeen = req.__rawCaptureSessionId; writeSeen = res.write; res.json({ cleared: true }); });
    for (const path of ['/v1/models/cache/clear', '/openai/v1/models/cache/clear', '/v1/models/cache/clear?x=1', '/V1/Models/Cache/Clear', '/OpenAI/V1/models/cache/CLEAR/']) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-credential': 'cred-jane' }, body: '{}' });
      expect(await r.json()).toEqual({ cleared: true });
      expect(sessionSeen).toBeUndefined();
      expect(writeSeen).toBe(http.ServerResponse.prototype.write);
    }
    await new Promise((r2) => setTimeout(r2, 20));
    expect(xadd).not.toHaveBeenCalled();
    expect(openCollectorCount()).toBe(0);
  });
});

describe('behind the real authentication', () => {
  const realAuth = createUnifiedTokenAuth() as unknown as express.RequestHandler;
  const apiKey = () => randomBytes(16).toString('hex');
  const valid = (id: string) => ({ valid: true, authType: 'api_key', data: { id }, token: 't', auditInfo: { requestId: 'v', validationTime: 1, cacheHit: true, source: 'test', responseTime: 1 } });

  beforeEach(() => { jest.spyOn(securityEventEmitter, 'emitFailedAuth').mockResolvedValue(undefined as any); });

  it('never captures a request refused by authentication', async () => {
    mockValidateApiKey.mockResolvedValue({ valid: false, authType: 'api_key', error: { message: 'refused', code: 'invalid' } });
    await start((_req, res) => { res.json({ ok: true }); }, realAuth);
    const r = await fetch(`${base}${ROUTE}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey() }, body });
    expect(r.status).toBe(401);
    await r.text();
    await new Promise((r2) => setTimeout(r2, 20));
    expect(xadd).not.toHaveBeenCalled();
  });

  it('captures a request of a selected credential refused after authentication', async () => {
    mockValidateApiKey.mockResolvedValue(valid('cred-jane'));
    await start((_req, res) => { res.status(429).json({ error: { message: 'quota exceeded' } }); }, realAuth);
    const r = await fetch(`${base}${ROUTE}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey() }, body });
    expect(r.status).toBe(429);
    await r.text();
    await waitFor(() => xadd.mock.calls.length > 0);
    const m = message();
    expect(m.credentialId).toBe('cred-jane');
    expect(JSON.parse(stages(m).at(-1)!.content)).toMatchObject({ statusCode: 429, complete: true });
  });
});

/** A response stand-in for the tap alone: events, write/end, headers. */
function fakeRes(extra: Record<string, unknown> = {}): any {
  const res: any = new EventEmitter();
  Object.assign(res, { statusCode: 200, writableFinished: false, getHeaders: () => ({ 'content-type': 'text/event-stream' }) });
  res.write = () => true;
  res.end = () => { res.writableFinished = true; return res; };
  return Object.assign(res, extra);
}

function tappedRequest(id: string): any {
  return {
    method: 'POST', originalUrl: ROUTE, url: ROUTE, headers: {}, query: {}, body: { messages: [{ role: 'user', content: 'hi' }] },
    debugRequestId: id, unifiedAuth: { valid: true, authType: 'api_key', data: { id: 'cred-jane' } },
  };
}

describe('the grace period after the response', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('keeps a stage recorded after res.end() within the grace period, with the client stage last; not one after it', () => {
    jest.useFakeTimers();
    const req = tappedRequest('gateway-late-1');
    const res = fakeRes();
    rawCaptureTap(req, res, () => {});
    res.end('data: [DONE]\n\n');
    res.emit('finish');
    recordStage('gateway-late-1', '03_sap_response_streaming', { fullText: 'Hello' });
    jest.advanceTimersByTime(RAW_CAPTURE_CLOSE_GRACE_MS - 1);
    expect(xadd).not.toHaveBeenCalled();
    expect(openCollectorCount()).toBe(1);
    jest.advanceTimersByTime(1);
    recordStage('gateway-late-1', '99_too_late', { late: true });
    expect(message().stageIndex.map((s) => s.name)).toEqual(['00_arrival', '03_sap_response_streaming', 'zz_client_response']);
    expect(openCollectorCount()).toBe(0);
  });

  it('publishes a hang-up as incomplete and forgets the request after the grace period', () => {
    jest.useFakeTimers();
    const res = fakeRes();
    rawCaptureTap(tappedRequest('gateway-late-2'), res, () => {});
    res.write('data: {"delta":"Hel"}\n\n');
    res.emit('close');
    expect(openCollectorCount()).toBe(1);
    jest.advanceTimersByTime(RAW_CAPTURE_CLOSE_GRACE_MS);
    expect(JSON.parse(stages(message()).at(-1)!.content).complete).toBe(false);
    expect(openCollectorCount()).toBe(0);
  });

  it('a grace timer still pending is cancelled by clearRawCaptureState and never closes a later collector of that id', () => {
    jest.useFakeTimers();
    const first = fakeRes();
    rawCaptureTap(tappedRequest('gateway-late-4'), first, () => {});
    first.emit('finish');
    clearRawCaptureState();
    expect(jest.getTimerCount()).toBe(0);

    applySessions(JSON.stringify({ sessions: [{ id: 's-1', credentialIds: ['cred-jane'], endsAt: '2099-01-01T00:00:00.000Z' }] }), new Date());
    rawCaptureTap(tappedRequest('gateway-late-4'), fakeRes(), () => {});
    jest.advanceTimersByTime(RAW_CAPTURE_CLOSE_GRACE_MS);
    expect(xadd).not.toHaveBeenCalled();
    expect(openCollectorCount()).toBe(1);
  });

  it('never throws out of the finish listener when the client stage cannot be built; the trace is still published', () => {
    jest.useFakeTimers();
    const res = fakeRes({ getHeaders: () => { throw new Error('headers gone'); } });
    rawCaptureTap(tappedRequest('gateway-late-3'), res, () => {});
    expect(() => res.emit('finish')).not.toThrow();
    expect(() => jest.advanceTimersByTime(RAW_CAPTURE_CLOSE_GRACE_MS)).not.toThrow();
    expect(message().stageIndex.map((s) => s.name)).toEqual(['00_arrival']);
    expect(openCollectorCount()).toBe(0);
  });
});

describe('credentialIdOf', () => {
  it('gives the id extractAuthInfo gives, without building an object', () => {
    const cases: any[] = [
      { unifiedAuth: { valid: true, authType: 'api_key', data: { id: 'a', keyId: 'b' } } },
      { unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'b', credentialId: 'c' } } },
      { unifiedAuth: { valid: true, authType: 'aws_credential', data: {} } },
      { apiKey: { id: 'legacy' } },
      { awsCredential: { accessKeyId: 'aws-id' } },
      {},
    ];
    for (const req of cases) expect(credentialIdOf(req)).toBe(extractAuthInfo(req)?.credentialId);
  });
});
