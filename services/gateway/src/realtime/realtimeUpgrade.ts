/**
 * OpenAI Realtime API over WebSocket — spec docs/superpowers/specs/2026-09-11-realtime-websocket-route-design.md.
 *
 * A WebSocket upgrade never enters Express, so this handler sits on the HTTP server's `upgrade`
 * event and runs the same admission chain every LLM route has (unified auth → service auth →
 * entitlement → quotaEnforcement) through the recording shim in admission.ts. The upstream
 * socket to SAP AI Core's realtime deployment is opened first; only when it is open is the
 * client's handshake completed, so every refusal reaches the client as a plain HTTP response.
 */
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import { getDefaultLogger } from '@libs/logger';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import quotaEnforcement from '../middlewares/quotaEnforcement';
import { serviceConfigurations, unifiedAuthProxyService } from '../services/unifiedAuthProxyService';
import modelService from '../services/modelService';
import configService from '../services/configService';
import { emitUsageEvent } from '../utils/usageTracker';
import type { UsageMetrics } from '../types/usage';
import { emitNotEntitled, entitlementFromRequest, isModelEntitled, logEntitlementDecision, respondNotEntitled } from '../utils/modelEntitlement';
import { resolveDeployedTwin } from '../utils/deployedTwin';
import { queryString } from '../utils/queryParam';
import { Middleware, RecordedResponse, UpgradeRequest, createRecordingResponse, prepareUpgradeRequest, refusal, runMiddleware, writeRefusal } from './admission';
import { relay } from './relay';
import { classifyFrame, invokedToolsFromResponseDone, rawToString, usageMetricsFromResponseDone } from './realtimeObserver';
import { CLOSE_INTERNAL_ERROR, CLOSE_POLICY_VIOLATION, REASON_QUOTA_EXCEEDED, REASON_UNAUTHORIZED, REASON_UPSTREAM_ERROR } from './closeCodes';
import { createRealtimeToolGate } from './realtimeToolGate';
import { emitToolPolicyEvent, policyBlocksFromRequest } from '../toolGovernance/middleware';
import { recordInvokedTools, stateOf } from '../toolGovernance/record';
import type { ToolGovernanceState } from '../toolGovernance/record';
import type { ToolPolicyBlock } from '../toolGovernance/identity';

const logger = getDefaultLogger();

export const REALTIME_PATHS = ['/openai/v1/realtime', '/v1/realtime'];
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime';
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

export interface RealtimeDeps {
  auth: Middleware;
  serviceAuth: Middleware;
  quota: Middleware;
  getDetails: (id: string) => Promise<any>;
  getAuthToken: () => Promise<string>;
  resourceGroup: () => string;
  emitUsage: (req: any, metrics: UsageMetrics, model: string, statusCode: number) => Promise<void>;
  connectTimeoutMs: number;
  /** Tests only: lets a plain ws:// fake stand in for SAP's wss:// deployment URL. */
  allowInsecureUpstream: boolean;
}

export function defaultDeps(): RealtimeDeps {
  return {
    auth: createUnifiedTokenAuth(),
    serviceAuth: unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai),
    quota: quotaEnforcement,
    getDetails: (id) => modelService.getModelDetails(id),
    getAuthToken: () => modelService.getAuthToken(),
    resourceGroup: () => configService.getSAPAICoreConfig().resourceGroup,
    emitUsage: emitUsageEvent,
    connectTimeoutMs: UPSTREAM_CONNECT_TIMEOUT_MS,
    allowInsecureUpstream: false,
  };
}

/** What `attachRealtimeUpgrade` hands back so a graceful shutdown can end the live sessions. */
export interface RealtimeHandle {
  /** Closes every open session's client socket; the relay then closes each upstream. */
  closeAll(code: number, reason: string): void;
}

export function attachRealtimeUpgrade(server: Server, overrides: Partial<RealtimeDeps> = {}): RealtimeHandle {
  const deps: RealtimeDeps = { ...defaultDeps(), ...overrides };
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const session = { started: false };
    handleUpgrade(req, socket, head, deps, wss, session).catch((err) => {
      logger.error('Realtime', 'Upgrade handling failed', err instanceof Error ? err : new Error(String(err)));
      // Past the 101 the socket carries WebSocket frames: raw HTTP bytes would corrupt the stream,
      // so the session is dropped instead.
      if (session.started) { socket.destroy(); return; }
      writeRefusal(socket as any, refusal(500, { error: { type: 'server_error', message: 'Internal error' } }));
    });
  });
  return {
    closeAll(code: number, reason: string): void {
      // `clientTracking` is on by default, so wss.clients holds exactly the live sessions.
      if (wss.clients.size > 0) logger.info('Realtime', `Closing ${wss.clients.size} open session(s) with ${code} ${reason}`);
      for (const client of wss.clients) {
        try { client.close(code, reason); } catch { client.terminate(); }
      }
    },
  };
}

class UpstreamRefused extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`upstream refused the handshake with HTTP ${status}`);
  }
}

/**
 * Node emits `upgrade` for any request carrying `Connection: Upgrade` — a POST, an `h2c` upgrade, a
 * handshake without a key. `ws` refuses those itself with a 400, but only after this handler has run
 * the whole admission chain and opened a billable upstream session, so they are refused up front.
 */
function isWebSocketHandshake(req: IncomingMessage): boolean {
  return req.method === 'GET'
    && String(req.headers.upgrade || '').toLowerCase() === 'websocket'
    && !!req.headers['sec-websocket-key']
    && req.headers['sec-websocket-version'] === '13';
}

async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deps: RealtimeDeps, wss: WebSocketServer, session: { started: boolean }): Promise<void> {
  const ureq = prepareUpgradeRequest(req);
  const refuse = (recorded: RecordedResponse) => writeRefusal(socket as any, recorded);

  if (!REALTIME_PATHS.includes(ureq.path)) {
    refuse(refusal(404, { error: { type: 'not_found', message: `No WebSocket endpoint at ${ureq.path}` } }));
    return;
  }
  if (!isWebSocketHandshake(req)) {
    refuse(refusal(400, { error: { type: 'bad_request', message: 'Expected a WebSocket upgrade (RFC 6455)' } }));
    return;
  }
  const requestedModel = queryString(ureq.query.model) || DEFAULT_REALTIME_MODEL;

  for (const mw of [deps.auth, deps.serviceAuth]) {
    const { outcome, recorded } = await runMiddleware(mw, ureq);
    if (outcome === 'refused') { refuse(recorded); return; }
  }

  const twin = await resolveDeployedTwin(requestedModel, deps.getDetails);
  if (!twin) {
    refuse(refusal(404, { error: { type: 'model_not_found', message: `Model ${requestedModel} has no running realtime deployment`, model: requestedModel } }));
    return;
  }
  if (!twin.deploymentUrl.startsWith('wss://') && !deps.allowInsecureUpstream) {
    refuse(refusal(502, { error: { type: 'upstream_error', message: `Deployment ${twin.id} is not a realtime deployment` } }));
    return;
  }

  // Both the requested id and the resolved twin must be entitled — the rule /google applies.
  const block = entitlementFromRequest(ureq);
  const refusedId = [requestedModel, twin.id].find((id) => !isModelEntitled(block, id));
  if (refusedId !== undefined) {
    logEntitlementDecision(ureq as any, refusedId, false);
    const res = createRecordingResponse();
    respondNotEntitled(res, refusedId, block!);
    emitNotEntitled(ureq as any, refusedId, block!);
    refuse(res.recorded);
    return;
  }

  const admission = await runMiddleware(deps.quota, ureq);
  if (admission.outcome === 'refused') { refuse(admission.recorded); return; }

  let upstream: WebSocket;
  try {
    upstream = await connectUpstream(twin.deploymentUrl, deps);
  } catch (err) {
    refuse(upstreamRefusal(err));
    return;
  }
  if (socket.destroyed) { upstream.terminate(); return; } // the client went away while we connected

  // wss.handleUpgrade's completion callback does not always run — ws aborts the handshake itself
  // (400 on a malformed Sec-WebSocket-Key/version/method, 503 while closing) without calling back.
  // If that happens the already-open upstream would otherwise be leaked: open, paused, unlistened,
  // a live billable AI Core session with no close path. socket's 'close' always fires either way
  // (ws ends the socket itself on an aborted handshake), so it is the one place to catch it.
  socket.once('close', () => { if (!session.started) upstream.terminate(); });
  wss.handleUpgrade(req, socket, head, (client) => {
    session.started = true;
    startSession(client, upstream, ureq, twin.id, deps);
  });
}

async function fetchAuthToken(deps: RealtimeDeps): Promise<string> {
  // deps.getAuthToken() (axios under the hood, no per-call timeout) is otherwise unbounded and
  // would let one hung token request blow through the whole connect budget.
  let timer: NodeJS.Timeout;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('AI Core token request timed out')), deps.connectTimeoutMs);
  });
  try {
    return await Promise.race([deps.getAuthToken(), timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}

async function connectUpstream(deploymentUrl: string, deps: RealtimeDeps): Promise<WebSocket> {
  const token = await fetchAuthToken(deps);
  return new Promise<WebSocket>((resolve, reject) => {
    const upstream = new WebSocket(`${deploymentUrl}/v1/realtime`, {
      headers: { Authorization: `Bearer ${token}`, 'AI-Resource-Group': deps.resourceGroup() },
      handshakeTimeout: deps.connectTimeoutMs,
    });
    upstream.once('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => reject(new UpstreamRefused(response.statusCode || 502, body.slice(0, 500))));
      response.on('error', () => reject(new UpstreamRefused(response.statusCode || 502, body.slice(0, 500))));
    });
    upstream.once('error', (err) => reject(err));
    // Paused before anything else runs: SAP can send `session.created` as soon as the socket is
    // open, before startSession() below attaches relay()'s message listener, and an unlistened
    // 'message' is lost, not buffered — resume() happens once that listener exists.
    upstream.once('open', () => { upstream.pause(); resolve(upstream); });
  });
}

function upstreamRefusal(err: unknown): RecordedResponse {
  if (err instanceof UpstreamRefused) {
    const status = err.status === 503 ? 503 : 502;
    return refusal(status, { error: { type: 'upstream_error', message: `SAP AI Core refused the realtime connection (HTTP ${err.status})`, upstream_status: err.status, upstream_body: err.body } });
  }
  const message = err instanceof Error ? err.message : String(err);
  return refusal(502, { error: { type: 'upstream_error', message: `Could not connect to the realtime deployment: ${message}` } });
}

function sendIfOpen(ws: WebSocket, text: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(text);
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

function startSession(client: WebSocket, upstream: WebSocket, ureq: UpgradeRequest, accountedId: string, deps: RealtimeDeps): void {
  // The connection's id identifies the session; every response gets its own derived id, because the
  // admin's usage idempotency signature starts with requestId and would drop a second response
  // that coincided with the first in every other field.
  const baseRequestId = ureq.debugRequestId;
  const meta = { requestId: baseRequestId, model: accountedId };
  let sessionId: string | null = null;
  const sessionStartedAt = Date.now();
  const responseStartedAt = new Map<string, number>();
  let responseCounter = 0;
  let ending = false;

  // Tool governance (spec 2026-09-22 §5): the session's real policy modes apply. Declarations on
  // session.update / response.create are stripped or refused; function results accumulate as the
  // trust chain's sources. Invoked calls are still read off each response.done and folded into that
  // response's usage event.
  const blocks = policyBlocksFromRequest(ureq);
  const gate = createRealtimeToolGate(blocks.user, blocks.key);
  const publish = (): void => {
    const s = gate.state();
    (ureq as any).toolGovernance = {
      result: s.result, declared: s.declared, sources: s.sources,
      invoked: stateOf(ureq)?.invoked ?? new Map<string, number>(),   // calls recorded since the last usage event stay
      family: 'openaiChat', blocks: [blocks.user, blocks.key].filter((b): b is ToolPolicyBlock => !!b)
    } satisfies ToolGovernanceState;
  };
  publish();

  const handle = relay(client, upstream, {
    onClientFrame(data, isBinary) {
      if (isBinary) return;
      const outcome = gate.onClientFrame(rawToString(data));
      if (!outcome) return;
      publish();
      if (outcome.refused) emitToolPolicyEvent(ureq, outcome.refused.result, outcome.refused.identities, outcome.refused.mode);
      if (outcome.drop) return { drop: true, reply: outcome.reply };
      return { forward: outcome.forward ?? data, thenUpstream: outcome.thenUpstream };
    },
    onUpstreamFrame(data, isBinary) {
      const frame = classifyFrame(data, isBinary);
      switch (frame.kind) {
        case 'session.created':
          sessionId = frame.sessionId;
          logger.info('Realtime', `Session ${sessionId} opened`, meta);
          break;
        case 'response.created': {
          const responseKey = frame.responseId ?? String(++responseCounter);
          responseStartedAt.set(responseKey, Date.now());
          ureq.debugRequestId = `${baseRequestId}-${responseKey}`;
          void recheck();
          break;
        }
        case 'response.done': {
          const startedAt = frame.responseId !== null ? responseStartedAt.get(frame.responseId) : undefined;
          if (frame.responseId !== null) responseStartedAt.delete(frame.responseId);
          // The whole tool-governance addition is fail-open: an observer error must never throw
          // into the relay's message handler (nothing upstream of this catches it).
          try {
            gate.onResponseDone(rawToString(data));
            publish();
            recordInvokedTools(ureq, invokedToolsFromResponseDone(data));
            if (frame.usage) {
              void deps.emitUsage(ureq, usageMetricsFromResponseDone(frame.usage, startedAt ?? sessionStartedAt), accountedId, 200);
              // Reset only after an emit actually happened: a usage-less response's invoked calls
              // stay recorded and ride the next emitted event instead of being silently dropped.
              const state = stateOf(ureq);
              if (state) state.invoked = new Map();
            }
          } catch (e) {
            logger.warn('Realtime', `tool governance observation failed in session ${sessionId}`, { ...meta, error: e instanceof Error ? e.message : String(e) });
          }
          break;
        }
        case 'error':
          logger.warn('Realtime', `Upstream error in session ${sessionId}`, { ...meta, error: frame.error });
          break;
        default:
          break;
      }
    },
    onClosed(side, code, reason) {
      logger.info('Realtime', `Session ${sessionId} closed by ${side} (${code} ${reason})`, meta);
    },
    onBackpressure(side, paused) {
      logger.info('Realtime', `Backpressure on ${side}: ${paused ? 'paused' : 'resumed'}`, meta);
    },
  });
  upstream.resume();
  // Between resolve(upstream) in connectUpstream and relay() attaching its listeners just above,
  // a 'close'/'error' on the upstream had no listener — it is a past event by the time relay's
  // upstream.on('close') attaches, and resume() on an already-CLOSED socket is a no-op. Without
  // this the client would be left open forever with a dead upstream underneath it.
  if (upstream.readyState !== WebSocket.OPEN) handle.close(CLOSE_INTERNAL_ERROR, REASON_UPSTREAM_ERROR);

  /**
   * Every upstream response counts as one request (spec decision 2 and 4): the auth middleware
   * (cached validation) and quotaEnforcement run again. Runs after the frame was forwarded and
   * never blocks the relay; a refusal ends the session.
   */
  async function recheck(): Promise<void> {
    if (ending) return;
    for (const mw of [deps.auth, deps.quota]) {
      const { outcome, recorded } = await runMiddleware(mw, ureq);
      if (ending) return; // a concurrent recheck already ended the session — don't run the next middleware
      if (outcome !== 'refused') continue;
      ending = true;
      if (recorded.statusCode === 429) {
        const body = parseJson(recorded.body);
        const detail = body && typeof body.error === 'object' && body.error ? body.error : {};
        sendIfOpen(client, JSON.stringify({ type: 'error', error: { ...detail, type: 'quota_exceeded' } }));
        sendIfOpen(upstream, JSON.stringify({ type: 'response.cancel' }));
        handle.close(CLOSE_POLICY_VIOLATION, REASON_QUOTA_EXCEEDED);
      } else {
        handle.close(CLOSE_POLICY_VIOLATION, REASON_UNAUTHORIZED);
      }
      return;
    }
  }
}
