/**
 * The realtime upgrade handler against a local fake upstream `ws` server standing in for SAP AI
 * Core. Auth, service auth, quota and the catalogue are injected through RealtimeDeps overrides;
 * the gateway modules behind defaultDeps() are stubbed so importing the handler loads no config.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import http, { IncomingHttpHeaders } from 'http';
import { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/middlewares/unifiedTokenAuth', () => ({ __esModule: true, default: jest.fn(), createUnifiedTokenAuth: () => jest.fn() }));
jest.mock('../../src/middlewares/quotaEnforcement', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/services/unifiedAuthProxyService', () => ({
  __esModule: true,
  unifiedAuthProxyService: { createServiceAuthMiddleware: () => jest.fn() },
  serviceConfigurations: { openai: { serviceName: 'openai' } },
}));
jest.mock('../../src/services/modelService', () => ({ __esModule: true, default: { getModelDetails: jest.fn(), getAuthToken: jest.fn() } }));
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: { getSAPAICoreConfig: () => ({ resourceGroup: 'default' }) },
  getTrustForwardedFor: () => false,
}));
jest.mock('../../src/utils/usageTracker', () => ({ __esModule: true, emitUsageEvent: jest.fn(async () => {}) }));
const notEntitledEvents: any[] = [];
jest.mock('../../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitModelNotEntitled: jest.fn(async (e: any) => { notEntitledEvents.push(e); }) },
}));

import { attachRealtimeUpgrade, RealtimeDeps, RealtimeHandle } from '../../src/realtime/realtimeUpgrade';
import { toolsForEvent } from '../../src/toolGovernance/record';

// ---- fake SAP upstream -------------------------------------------------------------------------
type UpstreamConn = { headers: IncomingHttpHeaders; url: string; received: any[]; socket: WebSocket };
let upstream: WebSocketServer;
let upstreamUrl: string;
let upstreamConns: UpstreamConn[];
const UPSTREAM_ERROR = { type: 'invalid_request_error', message: 'Unknown parameter: session.foo', code: 'unknown_parameter', param: 'session.foo', event_id: 'ev_9' };
const USAGE = { total_tokens: 30, input_tokens: 20, output_tokens: 10, input_token_details: { text_tokens: 9, audio_tokens: 6, image_tokens: 0, cached_tokens: 5 }, output_token_details: { text_tokens: 4, audio_tokens: 6 } };

beforeAll(async () => {
  upstream = new WebSocketServer({ port: 0 });
  upstream.on('connection', (socket, req) => {
    const conn: UpstreamConn = { headers: req.headers, url: req.url || '', received: [], socket };
    upstreamConns.push(conn);
    socket.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_1', model: 'gpt-realtime' } }));
    let responseSeq = 0;
    socket.on('message', (data, isBinary) => {
      if (isBinary) { socket.send(data, { binary: true }); return; }
      const ev = JSON.parse(data.toString());
      conn.received.push(ev);
      if (ev.type === 'kill') { socket.terminate(); return; }
      if (ev.type === 'boom') { socket.send(JSON.stringify({ type: 'error', error: UPSTREAM_ERROR })); return; }
      if (ev.type === 'late') {
        // Stop reading, so the gateway's close frame never closes this socket, then answer once
        // the client has gone: the observer must still meter that response.
        socket.pause();
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_late', status: 'completed', usage: USAGE } }));
          }
        }, 100);
        return;
      }
      if (ev.type === 'response.create') {
        const id = `resp_${++responseSeq}`;
        socket.send(JSON.stringify({ type: 'response.created', response: { id } }));
        socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }));
        // ev.toolCall lets a test ask this fake upstream to report a function call in the
        // response.done output, the way SAP's realtime deployment would.
        const output = ev.toolCall ? [{ type: 'function_call', name: ev.toolCall }] : [];
        // ev.noUsage lets a test ask for a response.done WITHOUT usage figures: the gateway then
        // emits no usage event for it and keeps the invoked calls for the next one.
        const done: any = { id, status: 'completed', output };
        if (!ev.noUsage) done.usage = USAGE;
        socket.send(JSON.stringify({ type: 'response.done', response: done }));
      }
    });
  });
  await new Promise<void>((r) => upstream.once('listening', r));
  upstreamUrl = `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const socket of upstream.clients) socket.terminate();
  await new Promise<void>((r) => upstream.close(() => r()));
});

// ---- gateway under test ------------------------------------------------------------------------
type Gateway = { url: string; server: http.Server; deps: RealtimeDeps; realtime: RealtimeHandle; close(): Promise<void> };
const gateways: Gateway[] = [];
const entitled = { valid: true, authType: 'api_key', data: { keyId: 'k1', email: 'u@test.com', rateLimits: {} } };

async function startGateway(overrides: Partial<RealtimeDeps> = {}): Promise<Gateway> {
  const deps: RealtimeDeps = {
    auth: jest.fn((req: any, _res: any, next: any) => { req.unifiedAuth = JSON.parse(JSON.stringify(entitled)); next(); }) as any,
    serviceAuth: jest.fn((_req: any, _res: any, next: any) => next()) as any,
    quota: jest.fn((_req: any, _res: any, next: any) => next()) as any,
    getDetails: jest.fn(async (id: string) => {
      if (id === 'gpt-realtime--deployed') return { id, deploymentUrl: upstreamUrl };
      if (id === 'gpt-realtime') return { id, routable: false };
      return null;
    }) as any,
    getAuthToken: jest.fn(async () => 'test-token') as any,
    resourceGroup: () => 'rg-test',
    emitUsage: jest.fn(async () => {}) as any,
    connectTimeoutMs: 2000,
    allowInsecureUpstream: true,
    ...overrides,
  };
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const realtime = attachRealtimeUpgrade(server, deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const gw: Gateway = {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, server, deps, realtime,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
  gateways.push(gw);
  return gw;
}
afterAll(async () => { for (const g of gateways) await g.close(); });
beforeEach(() => { upstreamConns = []; notEntitledEvents.length = 0; });

// ---- client helpers ----------------------------------------------------------------------------
type Handshake = { ws: WebSocket; status: number; headers: IncomingHttpHeaders; body: any };
function connect(gw: Gateway, path = '/openai/v1/realtime?model=gpt-realtime', headers: Record<string, string> = { authorization: 'Bearer test-key' }): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gw.url + path, { headers });
    track(ws);
    ws.once('unexpected-response', (_req, res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ ws, status: res.statusCode || 0, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    ws.once('open', () => resolve({ ws, status: 101, headers: {}, body: null }));
    ws.once('error', (e) => reject(e));
  });
}
type Inbox = { queue: any[]; waiters: Array<(v: any) => void> };
const inboxes = new WeakMap<WebSocket, Inbox>();
function track(ws: WebSocket): void {
  const inbox: Inbox = { queue: [], waiters: [] };
  inboxes.set(ws, inbox);
  ws.on('message', (d, isBinary) => {
    const ev = isBinary ? { binary: d } : JSON.parse(d.toString());
    const waiter = inbox.waiters.shift();
    if (waiter) waiter(ev); else inbox.queue.push(ev);
  });
}
const nextEvent = (ws: WebSocket): Promise<any> => {
  const inbox = inboxes.get(ws)!;
  if (inbox.queue.length) return Promise.resolve(inbox.queue.shift());
  return new Promise<any>((r) => inbox.waiters.push(r));
};
const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));
const waitFor = async (pred: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

/** A raw HTTP request carrying Connection: Upgrade — Node emits 'upgrade' for any such request. */
function rawUpgrade(gw: Gateway, headers: Record<string, string>, method = 'GET', path = '/openai/v1/realtime?model=gpt-realtime'): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: (gw.server.address() as AddressInfo).port, path, method, headers });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : null }));
    });
    req.on('upgrade', (res) => resolve({ status: res.statusCode || 0, body: null }));
    req.on('error', reject);
    req.end();
  });
}

// ---- tests -------------------------------------------------------------------------------------
describe('realtime upgrade — sessions', () => {
  it('101, then a text turn relayed both ways; the upstream saw the AI Core headers and the /v1/realtime path', async () => {
    const gw = await startGateway();
    const { ws, status } = await connect(gw);
    expect(status).toBe(101);
    expect(await nextEvent(ws)).toMatchObject({ type: 'session.created', session: { id: 'sess_1' } });
    ws.send(JSON.stringify({ type: 'response.create' }));
    expect(await nextEvent(ws)).toMatchObject({ type: 'response.created' });
    expect(await nextEvent(ws)).toMatchObject({ type: 'response.output_text.delta', delta: 'hello' });
    expect(await nextEvent(ws)).toMatchObject({ type: 'response.done' });
    expect(upstreamConns).toHaveLength(1);
    expect(upstreamConns[0].url).toBe('/v1/realtime');
    expect(upstreamConns[0].headers.authorization).toBe('Bearer test-token');
    expect(upstreamConns[0].headers['ai-resource-group']).toBe('rg-test');
    expect(upstreamConns[0].received).toEqual([{ type: 'response.create' }]);
    ws.close(1000);
  });
  it('a binary frame passes through byte-identical', async () => {
    const gw = await startGateway();
    const { ws } = await connect(gw);
    await nextEvent(ws);
    const bytes = Buffer.from([1, 2, 3, 0, 255]);
    ws.send(bytes, { binary: true });
    expect((await nextEvent(ws)).binary).toEqual(bytes);
    ws.close(1000);
  });
  it('accepts /v1/realtime, defaults the model to gpt-realtime, and resolves the explicit twin id too', async () => {
    const gw = await startGateway();
    const a = await connect(gw, '/v1/realtime');
    expect(a.status).toBe(101); a.ws.close(1000);
    const b = await connect(gw, '/openai/v1/realtime?model=gpt-realtime--deployed');
    expect(b.status).toBe(101); b.ws.close(1000);
    expect((gw.deps.getDetails as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['gpt-realtime', 'gpt-realtime--deployed', 'gpt-realtime--deployed']);
  });
  it('emits exactly one usage event per response.done, against the deployed twin, with the mapped figures', async () => {
    const gw = await startGateway();
    const { ws } = await connect(gw);
    await nextEvent(ws);
    ws.send(JSON.stringify({ type: 'response.create' }));
    for (let i = 0; i < 3; i++) await nextEvent(ws);
    await waitFor(() => (gw.deps.emitUsage as jest.Mock).mock.calls.length === 1);
    const [req, metrics, model, statusCode] = (gw.deps.emitUsage as jest.Mock).mock.calls[0] as any[];
    expect(model).toBe('gpt-realtime--deployed');
    expect(statusCode).toBe(200);
    expect(metrics).toMatchObject({ inputTokens: 15, outputTokens: 10, cacheReadInputTokens: 5, audioInputTokens: 6, audioOutputTokens: 6 });
    expect(typeof metrics.startTime).toBe('number');
    expect(req.originalUrl).toBe('/openai/v1/realtime?model=gpt-realtime');
    expect(req.unifiedAuth.data.keyId).toBe('k1');
    expect(req.debugRequestId).toMatch(/^gateway-/);
    ws.close(1000);
  });
  it('folds declared session tools and invoked function calls into each response usage event, monitor-only', async () => {
    // toolsForEvent must be read off `req` the way emitUsageEvent itself does: synchronously,
    // inside the emitUsage call, before the handler resets the invoked map for the next response.
    const folds: (ReturnType<typeof toolsForEvent>)[] = [];
    const emitUsage = jest.fn((req: any) => { folds.push(toolsForEvent(req)); return Promise.resolve(); });
    const gw = await startGateway({ emitUsage: emitUsage as any });
    const { ws } = await connect(gw);
    await nextEvent(ws);
    ws.send(JSON.stringify({ type: 'session.update', session: { tools: [{ type: 'function', name: 'get_weather' }, { type: 'function', name: 'book' }] } }));
    ws.send(JSON.stringify({ type: 'response.create', toolCall: 'get_weather' }));
    for (let i = 0; i < 3; i++) await nextEvent(ws);
    await waitFor(() => folds.length === 1);
    expect(folds[0]).toEqual([
      { identity: 'function:get_weather', facet: 'declared', count: 1, decision: 'allowed' },
      { identity: 'function:book', facet: 'declared', count: 1, decision: 'allowed' },
      { identity: 'function:get_weather', facet: 'invoked', count: 1, decision: 'allowed' },
    ]);
    // Next response calls no tool: its own usage event carries only the (still-declared) session
    // tools — the previous response's invoked call does not leak into it.
    ws.send(JSON.stringify({ type: 'response.create' }));
    for (let i = 0; i < 3; i++) await nextEvent(ws);
    await waitFor(() => folds.length === 2);
    expect(folds[1]).toEqual([
      { identity: 'function:get_weather', facet: 'declared', count: 1, decision: 'allowed' },
      { identity: 'function:book', facet: 'declared', count: 1, decision: 'allowed' },
    ]);
    ws.close(1000);
  });
  it('keeps the invoked calls of a usage-less response across a session.update', async () => {
    // A session.update re-declares the tools; the calls recorded since the last emitted usage
    // event belong to the session, so re-declaring must not drop them.
    const folds: (ReturnType<typeof toolsForEvent>)[] = [];
    const emitUsage = jest.fn((req: any) => { folds.push(toolsForEvent(req)); return Promise.resolve(); });
    const gw = await startGateway({ emitUsage: emitUsage as any });
    const { ws } = await connect(gw);
    await nextEvent(ws);
    ws.send(JSON.stringify({ type: 'session.update', session: { tools: [{ type: 'function', name: 'get_weather' }] } }));
    ws.send(JSON.stringify({ type: 'response.create', toolCall: 'get_weather', noUsage: true }));
    for (let i = 0; i < 3; i++) await nextEvent(ws);
    expect(folds).toHaveLength(0);
    ws.send(JSON.stringify({ type: 'session.update', session: { tools: [{ type: 'function', name: 'get_weather' }, { type: 'function', name: 'book' }] } }));
    ws.send(JSON.stringify({ type: 'response.create' }));
    for (let i = 0; i < 3; i++) await nextEvent(ws);
    await waitFor(() => folds.length === 1);
    expect(folds[0]).toEqual([
      { identity: 'function:get_weather', facet: 'declared', count: 1, decision: 'allowed' },
      { identity: 'function:book', facet: 'declared', count: 1, decision: 'allowed' },
      { identity: 'function:get_weather', facet: 'invoked', count: 1, decision: 'allowed' },
    ]);
    ws.close(1000);
  });
  it('counts every upstream response.created as a request: auth and quota run again', async () => {
    const gw = await startGateway();
    const { ws } = await connect(gw);
    await nextEvent(ws);
    expect(gw.deps.quota).toHaveBeenCalledTimes(1);
    ws.send(JSON.stringify({ type: 'response.create' }));
    for (let i = 0; i < 3; i++) await nextEvent(ws);
    await waitFor(() => (gw.deps.quota as jest.Mock).mock.calls.length === 2);
    expect(gw.deps.auth).toHaveBeenCalledTimes(2);
    expect(gw.deps.serviceAuth).toHaveBeenCalledTimes(1);
    ws.close(1000);
  });
  it('an exceeded window on a counted response: error event, response.cancel upstream, both sides closed 1008 quota_exceeded', async () => {
    let calls = 0;
    const quota = jest.fn((_req: any, res: any, next: any) => {
      if (++calls === 1) return next();
      res.set({ 'X-RateLimit-Limit': '1', 'Retry-After': '30' });
      res.status(429).json({ error: { type: 'rate_limit_exceeded', scope: 'key', dimension: 'requests', window: 'minute', limit: 1, used: 2, resets_at: '2026-09-15T10:00:30.000Z' } });
    });
    const gw = await startGateway({ quota: quota as any });
    const { ws } = await connect(gw);
    await nextEvent(ws);
    const clientClosed = closed(ws);
    ws.send(JSON.stringify({ type: 'response.create' }));
    const events: any[] = [];
    while (true) { const ev = await nextEvent(ws); events.push(ev); if (ev.type === 'error') break; }
    expect(events[events.length - 1]).toEqual({ type: 'error', error: { type: 'quota_exceeded', scope: 'key', dimension: 'requests', window: 'minute', limit: 1, used: 2, resets_at: '2026-09-15T10:00:30.000Z' } });
    expect(await clientClosed).toEqual({ code: 1008, reason: 'quota_exceeded' });
    await waitFor(() => upstreamConns[0].received.some((e) => e.type === 'response.cancel'));
    await waitFor(() => upstreamConns[0].socket.readyState === WebSocket.CLOSED);
  });
  it('a key refused on the re-check closes the session 1008 unauthorized', async () => {
    let calls = 0;
    const auth = jest.fn((req: any, res: any, next: any) => {
      if (++calls === 1) { req.unifiedAuth = JSON.parse(JSON.stringify(entitled)); return next(); }
      res.status(401).json({ error: { type: 'authentication_error', message: 'revoked' } });
    });
    const gw = await startGateway({ auth: auth as any });
    const { ws } = await connect(gw);
    await nextEvent(ws);
    const clientClosed = closed(ws);
    ws.send(JSON.stringify({ type: 'response.create' }));
    expect(await clientClosed).toEqual({ code: 1008, reason: 'unauthorized' });
  });
  it('an abnormal upstream closure reaches the client as 1011 upstream_error', async () => {
    const gw = await startGateway();
    const { ws } = await connect(gw);
    await nextEvent(ws);
    const clientClosed = closed(ws);
    ws.send(JSON.stringify({ type: 'kill' }));
    expect(await clientClosed).toEqual({ code: 1011, reason: 'upstream_error' });
  });
  it('a client close propagates upstream with 1000', async () => {
    const gw = await startGateway();
    const { ws } = await connect(gw);
    await nextEvent(ws);
    const upstreamClosed = closed(upstreamConns[0].socket);
    ws.close(4000, 'done');
    expect(await upstreamClosed).toEqual({ code: 1000, reason: '' });
  });
  it('every response of a session carries its own requestId: the session id plus the upstream response id', async () => {
    const seen: string[] = [];
    const emitUsage = jest.fn(async (req: any) => { seen.push(req.debugRequestId); });
    const gw = await startGateway({ emitUsage: emitUsage as any });
    const { ws } = await connect(gw);
    await nextEvent(ws);
    for (let turn = 0; turn < 2; turn++) {
      ws.send(JSON.stringify({ type: 'response.create' }));
      for (let i = 0; i < 3; i++) await nextEvent(ws);
    }
    await waitFor(() => seen.length === 2);
    expect(emitUsage).toHaveBeenCalledTimes(2);
    expect(seen[0]).not.toBe(seen[1]);
    const base = seen[0].slice(0, -'-resp_1'.length);
    expect(base).toMatch(/^gateway-/);
    expect(seen).toEqual([`${base}-resp_1`, `${base}-resp_2`]);
    ws.close(1000);
  });
  it('relays an upstream error event unchanged and leaves the session open', async () => {
    const gw = await startGateway();
    const { ws } = await connect(gw);
    await nextEvent(ws);
    ws.send(JSON.stringify({ type: 'boom' }));
    expect(await nextEvent(ws)).toEqual({ type: 'error', error: UPSTREAM_ERROR });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.send(JSON.stringify({ type: 'response.create' })); // the session still works
    expect(await nextEvent(ws)).toMatchObject({ type: 'response.created' });
    expect(await nextEvent(ws)).toMatchObject({ type: 'response.output_text.delta' });
    expect(await nextEvent(ws)).toMatchObject({ type: 'response.done' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close(1000);
  });
  it('a response.done that arrives after the client closed still produces its one usage event', async () => {
    const gw = await startGateway();
    const { ws } = await connect(gw);
    await nextEvent(ws);
    ws.send(JSON.stringify({ type: 'late' }));
    await waitFor(() => upstreamConns[0].received.some((e) => e.type === 'late'));
    const clientClosed = closed(ws);
    ws.close(1000);
    await clientClosed;
    await waitFor(() => (gw.deps.emitUsage as jest.Mock).mock.calls.length === 1, 3000);
    expect(gw.deps.emitUsage).toHaveBeenCalledTimes(1);
    const [, metrics] = (gw.deps.emitUsage as jest.Mock).mock.calls[0] as any[];
    // No response.created preceded it, so the start time falls back to the session's.
    expect(metrics).toMatchObject({ inputTokens: 15, outputTokens: 10, cacheReadInputTokens: 5, audioInputTokens: 6, audioOutputTokens: 6 });
    expect(typeof metrics.startTime).toBe('number');
  });
  it('closeAll ends every open session with the given code and reason, and the upstream follows', async () => {
    const gw = await startGateway();
    const { ws } = await connect(gw);
    await nextEvent(ws);
    const clientClosed = closed(ws);
    const upstreamClosed = closed(upstreamConns[0].socket);
    gw.realtime.closeAll(1001, 'server_shutdown');
    expect(await clientClosed).toEqual({ code: 1001, reason: 'server_shutdown' });
    await upstreamClosed;
    expect(upstreamConns[0].socket.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('realtime upgrade — refusals before the handshake', () => {
  it('401 when authentication fails, with the middleware\'s JSON body and no upstream connection', async () => {
    const auth = jest.fn((_req: any, res: any) => res.status(401).json({ error: { type: 'authentication_error', message: 'Authentication failed' } }));
    const gw = await startGateway({ auth: auth as any });
    const r = await connect(gw, '/openai/v1/realtime', {});
    expect(r.status).toBe(401);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.body).toEqual({ error: { type: 'authentication_error', message: 'Authentication failed' } });
    expect(upstreamConns).toHaveLength(0);
    expect(gw.deps.quota).not.toHaveBeenCalled();
  });
  it('403 model_not_entitled when the catalog excludes the requested id or its twin, with the security event', async () => {
    const auth = jest.fn((req: any, _res: any, next: any) => {
      req.unifiedAuth = { ...JSON.parse(JSON.stringify(entitled)), data: { keyId: 'k1', entitlement: { mode: 'list', include: ['gpt-realtime'], catalogId: 'c1', catalogName: 'Team' } } };
      next();
    });
    const gw = await startGateway({ auth: auth as any });
    const r = await connect(gw);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: { type: 'model_not_entitled', message: 'Model gpt-realtime--deployed is not in your entitlement catalog "Team"', model: 'gpt-realtime--deployed', catalog: 'Team' } });
    expect(notEntitledEvents).toHaveLength(1);
    expect(notEntitledEvents[0]).toMatchObject({ model: 'gpt-realtime--deployed', catalog: 'Team', credentialId: 'k1' });
    expect(upstreamConns).toHaveLength(0);
    expect(gw.deps.quota).not.toHaveBeenCalled();
  });
  it('429 with Retry-After and X-RateLimit headers when admission is over quota', async () => {
    const quota = jest.fn((_req: any, res: any) => {
      res.set({ 'X-RateLimit-Limit': '5', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1789000000', 'Retry-After': '12' });
      res.status(429).json({ error: { type: 'rate_limit_exceeded', scope: 'key', dimension: 'requests', window: 'minute', limit: 5, used: 6, resets_at: '2026-09-15T10:00:12.000Z' } });
    });
    const gw = await startGateway({ quota: quota as any });
    const r = await connect(gw);
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('12');
    expect(r.headers['x-ratelimit-limit']).toBe('5');
    expect(r.body.error.type).toBe('rate_limit_exceeded');
    expect(upstreamConns).toHaveLength(0);
  });
  it('404 model_not_found for a model without a running realtime deployment', async () => {
    const gw = await startGateway();
    const r = await connect(gw, '/openai/v1/realtime?model=gpt-5.3');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { type: 'model_not_found', message: 'Model gpt-5.3 has no running realtime deployment', model: 'gpt-5.3' } });
  });
  it('404 not_found for any other upgrade path, before authentication', async () => {
    const gw = await startGateway();
    const r = await connect(gw, '/anthropic/v1/messages');
    expect(r.status).toBe(404);
    expect(r.body.error.type).toBe('not_found');
    expect(gw.deps.auth).not.toHaveBeenCalled();
  });
  it('502 when the resolved deployment URL is not wss://', async () => {
    const gw = await startGateway({ allowInsecureUpstream: false });
    const r = await connect(gw);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: { type: 'upstream_error', message: 'Deployment gpt-realtime--deployed is not a realtime deployment' } });
    expect(upstreamConns).toHaveLength(0);
  });
});

describe('realtime upgrade — upstream refusals', () => {
  let refusing: http.Server;
  let refusingUrl: string;
  let upstreamStatus = 503;
  beforeAll(async () => {
    refusing = http.createServer();
    refusing.on('upgrade', (_req, socket) => {
      socket.end(`HTTP/1.1 ${upstreamStatus} ${http.STATUS_CODES[upstreamStatus]}\r\ncontent-type: text/plain\r\ncontent-length: 8\r\nconnection: close\r\n\r\nno entry`);
    });
    await new Promise<void>((r) => refusing.listen(0, '127.0.0.1', r));
    refusingUrl = `ws://127.0.0.1:${(refusing.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => refusing.close(() => r())); });
  const catalogue = (url: string) => jest.fn(async (id: string) => (id === 'gpt-realtime--deployed' ? { id, deploymentUrl: url } : id === 'gpt-realtime' ? { id } : null));

  it('a SAP 503 on the handshake becomes 503 for the client', async () => {
    upstreamStatus = 503;
    const gw = await startGateway({ getDetails: catalogue(refusingUrl) as any });
    const r = await connect(gw);
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ type: 'upstream_error', upstream_status: 503, upstream_body: 'no entry' });
  });
  it('any other upstream refusal becomes 502 carrying the upstream status', async () => {
    upstreamStatus = 401;
    const gw = await startGateway({ getDetails: catalogue(refusingUrl) as any });
    const r = await connect(gw);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({ type: 'upstream_error', upstream_status: 401 });
  });
  it('an unreachable deployment host becomes 502', async () => {
    const gw = await startGateway({ getDetails: catalogue('ws://127.0.0.1:1') as any });
    const r = await connect(gw);
    expect(r.status).toBe(502);
    expect(r.body.error.type).toBe('upstream_error');
    expect(r.body.error.message).toMatch(/^Could not connect to the realtime deployment/);
  });
  it('a failing AI Core token request becomes 502', async () => {
    const gw = await startGateway({ getAuthToken: jest.fn(async () => { throw new Error('Failed to authenticate with SAP AI Core'); }) as any });
    const r = await connect(gw);
    expect(r.status).toBe(502);
    expect(r.body.error.message).toContain('Failed to authenticate with SAP AI Core');
    expect(upstreamConns).toHaveLength(0);
  });
});

describe('realtime upgrade — review fixes', () => {
  it('a malformed handshake (no Sec-WebSocket-Key) is refused 400 bad_request before auth, with no upstream session opened', async () => {
    const gw = await startGateway();
    const r = await rawUpgrade(gw, {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      authorization: 'Bearer test-key',
      // Sec-WebSocket-Key deliberately omitted.
    });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { type: 'bad_request', message: 'Expected a WebSocket upgrade (RFC 6455)' } });
    expect(gw.deps.auth).not.toHaveBeenCalled();
    expect(upstreamConns).toEqual([]);
  });

  it('a non-WebSocket upgrade (Upgrade: h2c) on a realtime path is refused 400 bad_request', async () => {
    const gw = await startGateway();
    const r = await rawUpgrade(gw, {
      Connection: 'Upgrade',
      Upgrade: 'h2c',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      authorization: 'Bearer test-key',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe('bad_request');
    expect(gw.deps.auth).not.toHaveBeenCalled();
    expect(upstreamConns).toEqual([]);
  });

  it('a POST carrying Connection: Upgrade on a realtime path is refused 400 bad_request', async () => {
    const gw = await startGateway();
    const r = await rawUpgrade(gw, {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      authorization: 'Bearer test-key',
      'content-length': '0',
    }, 'POST');
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe('bad_request');
    expect(gw.deps.auth).not.toHaveBeenCalled();
    expect(upstreamConns).toEqual([]);
  });

  it('the AI Core token fetch is bounded by connectTimeoutMs: 502 upstream_error within the connect budget, not the handshakeTimeout', async () => {
    const gw = await startGateway({ getAuthToken: (() => new Promise<string>(() => {})) as any, connectTimeoutMs: 300 });
    const start = Date.now();
    const r = await connect(gw);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.status).toBe(502);
    expect(r.body.error.type).toBe('upstream_error');
    expect(r.body.error.message).toContain('timed out');
  });

  describe('an upstream that dies in the window before relay() attaches its listeners', () => {
    let dying: WebSocketServer;
    let dyingUrl: string;
    beforeAll(async () => {
      dying = new WebSocketServer({ port: 0 });
      dying.on('connection', (socket) => socket.terminate()); // closes before sending anything
      await new Promise<void>((r) => dying.once('listening', r));
      dyingUrl = `ws://127.0.0.1:${(dying.address() as AddressInfo).port}`;
    });
    afterAll(async () => { await new Promise<void>((r) => dying.close(() => r())); });

    it('closes the client instead of leaving it open forever', async () => {
      const gw = await startGateway({
        getDetails: jest.fn(async (id: string) => (id === 'gpt-realtime--deployed' ? { id, deploymentUrl: dyingUrl } : id === 'gpt-realtime' ? { id } : null)) as any,
      });
      const { ws, status } = await connect(gw);
      expect(status).toBe(101);
      const result = await closed(ws);
      expect([1000, 1011]).toContain(result.code);
    });
  });

  describe('recheck() when a concurrent refusal already ended the session', () => {
    let dualCreated: WebSocketServer;
    let dualUrl: string;
    beforeAll(async () => {
      dualCreated = new WebSocketServer({ port: 0 });
      dualCreated.on('connection', (socket) => {
        // Two response.created frames sent back-to-back (buffered behind connectUpstream's
        // pause(), delivered together once resume() runs) drive two recheck() calls that race.
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_race' } }));
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }));
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'r2' } }));
      });
      await new Promise<void>((r) => dualCreated.once('listening', r));
      dualUrl = `ws://127.0.0.1:${(dualCreated.address() as AddressInfo).port}`;
    });
    afterAll(async () => { await new Promise<void>((r) => dualCreated.close(() => r())); });

    it('a refusal that arrives once ending is already true stops instead of running the next middleware', async () => {
      let authCalls = 0;
      const auth = jest.fn((req: any, res: any, next: any) => {
        authCalls += 1;
        if (authCalls === 1) { req.unifiedAuth = JSON.parse(JSON.stringify(entitled)); return next(); }
        res.status(401).json({ error: { type: 'authentication_error', message: 'revoked' } });
      });
      let quotaCalls = 0;
      const quota = jest.fn((_req: any, res: any, next: any) => {
        quotaCalls += 1;
        if (quotaCalls === 1) return next();
        res.set({ 'Retry-After': '30' });
        res.status(429).json({ error: { type: 'rate_limit_exceeded', scope: 'key', dimension: 'requests', window: 'minute', limit: 1, used: 2, resets_at: '2026-09-15T10:00:30.000Z' } });
      });
      const gw = await startGateway({
        auth: auth as any,
        quota: quota as any,
        getDetails: jest.fn(async (id: string) => (id === 'gpt-realtime--deployed' ? { id, deploymentUrl: dualUrl } : id === 'gpt-realtime' ? { id } : null)) as any,
      });
      const { ws } = await connect(gw);
      const result = await closed(ws);
      expect(result.code).toBe(1008);
      expect(quotaCalls).toBe(1); // the admission call only — never the re-check quota's 2nd call
    });
  });
});
