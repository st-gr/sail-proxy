/**
 * responsesController: eligibility gate + outbound payload shape.
 * Upstream HTTP is mocked; this asserts what we WOULD send.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

const loggedErrors: Array<{ message: string; metadata: any }> = [];
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    // Faithful to libs/logger: every output format does JSON.stringify(entry.metadata)
    // and nothing catches it, so circular metadata (a live upstream stream) throws
    // out of logger.error exactly as it does in production.
    error: (_component: string, message: string, _error?: Error, metadata?: any) => {
      if (metadata) JSON.stringify(metadata);
      loggedErrors.push({ message, metadata });
    },
    warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const posted: any[] = [];
// The fake upstream SSE stream from the most recent streaming axios.post call, if any.
// A plain EventEmitter is enough: forwardStream only needs .on('data'|'end'|'error'|'close') and .destroy().
let streamHandle: (EventEmitter & { destroy: () => void }) | null = null;
// When set, the next axios.post rejects like a real upstream error status.
// `data()` builds the body fresh so a streaming case gets a live Readable —
// exactly the circular value that used to blow up JSON.stringify in the catch.
let nextPostRejection: { status: number; message: string; data: () => any } | null = null;
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (url: string, body: any, cfg: any) => {
      posted.push({ url, body, cfg });
      if (nextPostRejection) {
        const err: any = new Error(nextPostRejection.message);
        err.response = { status: nextPostRejection.status, data: nextPostRejection.data() };
        nextPostRejection = null;
        return Promise.reject(err);
      }
      if (cfg?.responseType === 'stream') {
        const stream: any = new EventEmitter();
        stream.destroy = () => { stream.emit('close'); };
        streamHandle = stream;
        return Promise.resolve({ status: 200, data: stream });
      }
      return Promise.resolve({
        status: 200,
        data: {
          id: 'resp_1', object: 'response', status: 'completed', output: [],
          usage: { input_tokens: 3, output_tokens: 4, input_tokens_details: { cached_tokens: 1 } },
        },
      });
    },
  },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(
      // Faithful to the real model list: every deployment appears TWICE — the bare
      // foundation entry `X`, which is orchestration-only and carries no
      // deploymentUrl, and `X--deployed`, which carries one. A mock that deployed
      // both could not tell the sibling fallback from a no-op.
      m.startsWith('gpt-5')
        ? {
            id: m, model: m.replace(/--deployed$/, ''), owned_by: 'OpenAI',
            ...(m.endsWith('--deployed') ? { deploymentUrl: 'http://mock-sap/deployments/abc' } : {}),
          }
        : m.startsWith('sonar')
          ? { id: m, model: m.replace(/--deployed$/, ''), owned_by: 'Perplexity', deploymentUrl: 'http://mock-sap/deployments/xyz' }
          // Known to the model list but never deployed — only reachable because
          // supports_responses_api is flagged on for it (see getSupportsResponsesApi).
          : m.startsWith('flagged-nodeploy')
            ? { id: m, model: m, owned_by: 'OpenAI' }
            : null
    ),
    getAuthToken: () => Promise.resolve('tok'),
  },
}));

// Per-test config knobs; reset in beforeEach.
const configState: any = { hookConfig: undefined, pseudonymizationForced: false };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportsResponsesApi: (_provider?: string, model?: string) =>
      (typeof model === 'string' && model.startsWith('flagged-') ? true : undefined),
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getTimeout: () => 1000,
    getHookConfig: () => configState.hookConfig,
    isPseudonymizationForced: () => configState.pseudonymizationForced,
    getConfig: () => ({}),
  },
}));

// Per-test before-plugin behavior; reset in beforeEach.
let beforePlugins: (req: any, res: any, hookConfig: any) => Promise<any> =
  () => Promise.resolve({ stop: false });
// Per-test after-plugin behavior; reset in beforeEach. Configurable the same way as
// beforePlugins so a test can simulate the web-search continuation plugin actually
// populating __responsesExtraUsage DURING the after-chain, which is the only way to
// prove the controller reads it after — not before — executeAfterPlugins runs.
let afterPlugins: (req: any, res: any, body: any) => Promise<any> =
  (_req: any, _res: any, body: any) => Promise.resolve(body);
jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: (req: any, res: any, hookConfig: any) => beforePlugins(req, res, hookConfig),
  executeAfterPlugins: (req: any, res: any, body: any) => afterPlugins(req, res, body),
}));

const usageEvents: any[] = [];
// Accumulates like the real updateTokenCounts so assertions can read the metrics
// object the usage event carries.
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  // The real emitUsageEvent (services/gateway/src/utils/usageTracker.ts) reads
  // metrics.inputTokens/outputTokens synchronously into a plain UsageEvent object
  // AT CALL TIME — it does not hold a live reference to `metrics`. Snapshot here
  // too (rather than pushing the live object), or a test can't tell whether a
  // mutation landed before or after emitUsageEvent ran: with a live reference,
  // any later mutation of the same metrics object would still show up when the
  // test reads usageEvents[...] afterward, masking ordering bugs.
  emitUsageEvent: (...args: any[]) => { usageEvents.push([args[0], { ...args[1] }, args[2], args[3]]); },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0;
    m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0;
    m.cacheReadInputTokens += cacheRead || 0;
  },
}));

import { handleResponses } from '../src/controllers/responsesController';

// An EventEmitter, because forwardStream registers a res 'close' listener — that, not the
// req listener, is what detects a client disconnect on this stack (req is destroyed within
// a few ms of route entry, on every request, so a req 'close' listener registered inside
// forwardStream never fires).
function mockRes() {
  const r: any = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined, headers: {}, writes: [] as string[], ended: false,
  });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  // A real finished response throws ERR_STREAM_WRITE_AFTER_END on write.
  r.write = (s: string) => {
    if (r.writableEnded) throw new Error('write after end');
    r.writes.push(s);
    return true;
  };
  r.end = () => { r.ended = true; }; r.writableEnded = false;
  return r;
}

// req must be an EventEmitter: forwardStream listens for the client-disconnect 'close' event.
function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = {};
  return r;
}

/**
 * A live upstream error body as axios delivers it under responseType:'stream'.
 * Circular exactly like a real IncomingMessage (message.socket.parser.incoming
 * === message) — that self-reference is what makes JSON.stringify throw.
 */
function upstreamStreamBody(payload: any): Readable {
  const s: any = Readable.from([JSON.stringify(payload)]);
  s.socket = { parser: { incoming: s } };
  return s;
}

/** Poll a few event-loop turns for async setup (model lookup, auth token, axios.post) to settle. */
async function flushUntil(cond: () => boolean, maxTries = 50): Promise<void> {
  for (let i = 0; i < maxTries && !cond(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('responsesController', () => {
  beforeEach(() => {
    posted.length = 0;
    usageEvents.length = 0;
    streamHandle = null;
    nextPostRejection = null;
    loggedErrors.length = 0;
    configState.hookConfig = undefined;
    configState.pseudonymizationForced = false;
    beforePlugins = () => Promise.resolve({ stop: false });
    afterPlugins = (_req: any, _res: any, body: any) => Promise.resolve(body);
  });

  describe('bare foundation-model names', () => {
    // codex-cli — and any client carrying its own table of published OpenAI model
    // names — sends `gpt-5.3-codex`, not our `--deployed` decoration, and warns
    // "Model metadata for `gpt-5.3-codex--deployed` not found" when made to use it.
    it('resolves a bare name to its --deployed sibling and forwards to that deployment', async () => {
      const req = mockReq({ model: 'gpt-5.3-codex', input: 'Say OK' });
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(res.statusCode).toBe(200);
      expect(posted).toHaveLength(1);
      expect(posted[0].url).toBe('http://mock-sap/deployments/abc/responses');
      // The deployment rejects our alias suffix, so the outbound name is the bare
      // SAP model either way — the fallback must not smuggle `--deployed` upstream.
      expect(posted[0].body.model).toBe('gpt-5.3-codex');
    });

    it('bills the usage event against the deployment actually called', async () => {
      const req = mockReq({ model: 'gpt-5.3-codex', input: 'Say OK' });
      await handleResponses(req, mockRes(), () => {});

      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0][2]).toBe('gpt-5.3-codex--deployed');
    });

    it('still rejects a bare name whose family cannot serve the Responses API', async () => {
      // `sonar` has no deployed sibling in the mock and is not a Responses family,
      // so the fallback must not turn an honest 400 into a 500.
      const req = mockReq({ model: 'sonar', input: 'Say OK' });
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(res.statusCode).toBe(400);
      expect(posted).toHaveLength(0);
      expect(res.body.error.message).toContain('does not support the Responses API');
    });
  });

  describe('upstream error envelopes', () => {
    // SAP AI Core returns `error` as a STRING; OpenAI SDKs read `error.message`
    // off an OBJECT and get undefined. Captured verbatim from a deployment
    // rejecting codex-cli's tool list on 2026-08-06.
    const SAP_ERROR = {
      error: 'BadRequest',
      message: "The following tools are not allowed for model 'gpt-5.3-codex': namespace and web_search.",
    };

    it('reshapes a SAP-style error into the OpenAI envelope', async () => {
      nextPostRejection = {
        status: 400,
        message: 'Request failed with status code 400',
        data: () => SAP_ERROR,
      };

      const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK' });
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(res.statusCode).toBe(400);
      expect(res.body.error.message).toBe(SAP_ERROR.message);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.code).toBe('BadRequest');
      // Nothing is discarded: the raw upstream body stays reachable for debugging.
      expect(res.body.error.details).toEqual(SAP_ERROR);
    });

    it('carries the upstream message into the mid-stream response.failed frame', async () => {
      nextPostRejection = {
        status: 400,
        message: 'Request failed with status code 400',
        data: () => upstreamStreamBody(SAP_ERROR),
      };

      const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
      const res = mockRes();
      res.headersSent = true;

      await handleResponses(req, res, () => {});

      const frame = res.writes.find((w: string) => w.includes('response.failed'));
      expect(frame).toBeDefined();
      const parsed = JSON.parse(frame!.replace(/^data: /, '').trim());
      // Not axios's "Request failed with status code 400", which names no cause.
      expect(parsed.response.error.message).toBe(SAP_ERROR.message);
    });

    it('wraps a non-JSON upstream body rather than passing raw text through', async () => {
      nextPostRejection = {
        status: 502,
        message: 'Request failed with status code 502',
        data: () => '<html><body>Bad Gateway</body></html>',
      };

      const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK' });
      const res = mockRes();
      await handleResponses(req, res, () => {});

      expect(res.statusCode).toBe(502);
      expect(res.body.error.message).toContain('Bad Gateway');
      expect(res.body.error.type).toBe('api_error');
    });
  });

  it('forwards to {deploymentUrl}/responses with the upstream model name', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'Say OK', max_output_tokens: 20 }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('http://mock-sap/deployments/abc/responses');
    expect(posted[0].body.model).toBe('gpt-5.3-codex');       // alias replaced
    expect(posted[0].body.input).toBe('Say OK');
    expect(res.statusCode).toBe(200);
    expect(res.body.object).toBe('response');
  });

  it('rejects an ineligible model with model_not_supported', async () => {
    const req: any = { body: { model: 'sonar--deployed', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(posted).toHaveLength(0);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('model_not_supported');
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('rejects an unknown model without calling upstream', async () => {
    const req: any = { body: { model: 'nope--deployed', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});
    expect(posted).toHaveLength(0);
    expect(res.statusCode).toBe(400);
  });

  it('settles the handler and still emits a usage event when the client disconnects mid-stream', async () => {
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    // Simulate the client hanging up: Express emits 'close' on the request,
    // which forwardStream turns into upstream.data.destroy() — a real
    // Readable.destroy() with no error argument emits 'close', not 'end'/'error'.
    req.emit('close');

    // The bug this guards against: without a 'close' listener on the upstream
    // stream, this await never resolves and the test times out.
    await handlerPromise;

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][2]).toBe('gpt-5.3-codex--deployed');
    // A cancelled stream is still accounted for, not silently dropped.
    expect(usageEvents[0][3]).toBe(499);
  });

  it('writes a response.failed frame and emits usage when the upstream stream errors mid-flight', async () => {
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    streamHandle!.emit('error', new Error('socket hang up'));

    await handlerPromise;

    const failedFrame = res.writes.find((w: string) => w.includes('response.failed'));
    expect(failedFrame).toBeDefined();
    expect(JSON.parse(failedFrame!.replace(/^data: /, '').trim())).toMatchObject({
      type: 'response.failed',
      response: { status: 'failed', error: { message: 'socket hang up' } },
    });

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(500);
  });

  it('rejects a config-flagged model that has no deployment with an actionable 400', async () => {
    const req: any = { body: { model: 'flagged-nodeploy-1', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    // Would otherwise POST to "undefined/responses" and surface as a 500.
    expect(posted).toHaveLength(0);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('model_not_supported');
    expect(res.body.error.message).toContain('no deployment');
  });

  it('runs before-plugins BEFORE building the outbound payload, so mutations reach upstream', async () => {
    configState.hookConfig = [{ request: { callback: { id: 'somePlugin' } } }];
    beforePlugins = (req: any) => {
      req.body.input = 'masked MASKED_EMAIL_1';
      return Promise.resolve({ stop: false });
    };

    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'raw john@test.com' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    // The whole reason this route has its own controller: openaiController builds
    // its payload first, so plugin edits there never reach the wire.
    expect(posted).toHaveLength(1);
    expect(posted[0].body.input).toBe('masked MASKED_EMAIL_1');
    expect(posted[0].body.input).not.toContain('john@test.com');
  });

  it('proceeds when pseudonymization is force-enabled and the hook config is present', async () => {
    configState.pseudonymizationForced = true;
    configState.hookConfig = [{ request: { callback: { id: 'pseudonymizationPlugin' } } }];

    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(posted).toHaveLength(1);
    expect(res.statusCode).toBe(200);
  });

  it('fails closed with 503 when pseudonymization is force-enabled but the hook config is missing', async () => {
    // A configuration activated before this route existed: the admin config
    // replaces the file config wholesale, so `responses` is absent from
    // defaultHooks.openai while the force flag is still on.
    configState.pseudonymizationForced = true;
    configState.hookConfig = undefined;

    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'my email is john@test.com' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(posted).toHaveLength(0);          // nothing goes upstream unmasked
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('pseudonymization_hook_missing');
    expect(res.body.error.message).toContain('responses-stream');
  });

  it('proceeds when the hook config is missing and the force flag is off (unchanged behavior)', async () => {
    configState.pseudonymizationForced = false;
    configState.hookConfig = undefined;

    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    expect(posted).toHaveLength(1);
    expect(res.statusCode).toBe(200);
  });

  it('reports the real token counts from the final response.completed frame', async () => {
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
    streamHandle!.emit('data', Buffer.from(frame({ type: 'response.created', sequence_number: 0, response: { status: 'in_progress' } })));
    streamHandle!.emit('data', Buffer.from(frame({ type: 'response.output_text.delta', sequence_number: 1, output_index: 0, delta: 'OK' })));
    streamHandle!.emit('data', Buffer.from(frame({ type: 'response.output_text.done', sequence_number: 2, output_index: 0 })));
    streamHandle!.emit('data', Buffer.from(frame({
      type: 'response.completed',
      sequence_number: 3,
      response: {
        id: 'resp_1', status: 'completed',
        usage: { input_tokens: 120, output_tokens: 7, total_tokens: 127, input_tokens_details: { cached_tokens: 100 } },
      },
    })));
    streamHandle!.emit('end');

    await handlerPromise;

    expect(usageEvents).toHaveLength(1);
    const metrics = usageEvents[0][1];
    // Cached input is reported separately (priced at the cache rate) and therefore
    // subtracted from the full-rate input, so the total stays 120.
    expect(metrics.inputTokens).toBe(20);
    expect(metrics.cacheReadInputTokens).toBe(100);
    expect(metrics.outputTokens).toBe(7);
    expect(usageEvents[0][3]).toBe(200);
  });

  it('bills a turn that ends on response.incomplete, not just response.completed', async () => {
    // `.incomplete` is what a deployment sends when max_output_tokens is hit mid-turn, and
    // Codex CLI sets max_output_tokens on EVERY request — so this is routine, not an edge
    // case. Matching response.completed alone reported {0, 0} for a turn that really spent
    // 120 in / 7 out, and nothing downstream gets a second chance at it.
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
    streamHandle!.emit('data', Buffer.from(frame({ type: 'response.output_text.delta', sequence_number: 1, output_index: 0, delta: 'OK' })));
    streamHandle!.emit('data', Buffer.from(frame({
      type: 'response.incomplete',
      sequence_number: 2,
      response: {
        id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 120, output_tokens: 7, total_tokens: 127, input_tokens_details: { cached_tokens: 100 } },
      },
    })));
    streamHandle!.emit('end');

    await handlerPromise;

    expect(usageEvents).toHaveLength(1);
    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(20);            // 120 - 100 cached, as above
    expect(metrics.cacheReadInputTokens).toBe(100);
    expect(metrics.outputTokens).toBe(7);
  });

  it('bills a turn that ends on response.failed', async () => {
    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    streamHandle!.emit('data', Buffer.from(`data: ${JSON.stringify({
      type: 'response.failed',
      response: { id: 'resp_1', status: 'failed', error: { message: 'boom' }, usage: { input_tokens: 11, output_tokens: 3 } },
    })}\n\n`));
    streamHandle!.emit('end');

    await handlerPromise;

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][1].inputTokens).toBe(11);
    expect(usageEvents[0][1].outputTokens).toBe(3);
  });

  it('waits for a streaming web-search continuation before folding usage and closing the stream', async () => {
    // The interceptor installed by responsesWebSearchPlugin publishes this hook. The
    // continuation call it opens starts only AFTER the first upstream stream ends, so
    // folding synchronously on 'end' billed zero continuation tokens and closed the
    // socket mid-splice. forwardStream never runs the after-plugin chain, so this hook is
    // the only channel the plugin has to report those tokens.
    let releaseContinuation: () => void = () => {};
    configState.hookConfig = [{}];
    beforePlugins = (_req: any, res: any) => {
      (res as any).__responsesWebSearchIdle = () => new Promise<void>((resolve) => { releaseContinuation = resolve; });
      return Promise.resolve({ stop: false });
    };

    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    streamHandle!.emit('data', Buffer.from(`data: ${JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 2 } },
    })}\n\n`));
    streamHandle!.emit('end');
    await flushUntil(() => false, 5);

    expect(usageEvents).toHaveLength(0);            // still splicing: nothing billed, nothing closed
    expect(res.ended).toBe(false);

    (req as any).__responsesExtraUsage = { input_tokens: 40, output_tokens: 7 };
    releaseContinuation();
    await handlerPromise;

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][1].inputTokens).toBe(50);       // 10 + the continuation's 40
    expect(usageEvents[0][1].outputTokens).toBe(9);       // 2 + the continuation's 7
    expect(res.ended).toBe(true);
  });

  it('aborts the web-search continuation when the RESPONSE closes before it ended', async () => {
    // Through the controller's real disconnect wiring, not the exported helper: the only
    // production caller used to be a req 'close' listener registered inside forwardStream,
    // which never fires — req is destroyed within ~5ms of route entry on every request, so
    // the abort was unreachable and a helper-level test could not see it. Removing the
    // `res.on('close', ...)` registration in forwardStream makes this test fail.
    let aborted = 0;
    configState.hookConfig = [{}];
    beforePlugins = (_req: any, res: any) => {
      (res as any).__responsesWebSearchAbort = () => { aborted += 1; };
      return Promise.resolve({ stop: false });
    };

    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    res.emit('close');                                  // client hung up mid-stream
    expect(aborted).toBe(1);

    streamHandle!.emit('close');                        // the destroyed upstream settles the handler
    await handlerPromise;
  });

  it('does not abort the continuation when the response closes after a normal end', async () => {
    // res 'close' fires on every completed response too; without the writableEnded guard
    // this would cancel the continuation of every ordinary turn.
    let aborted = 0;
    configState.hookConfig = [{}];
    beforePlugins = (_req: any, res: any) => {
      (res as any).__responsesWebSearchAbort = () => { aborted += 1; };
      return Promise.resolve({ stop: false });
    };

    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();

    const handlerPromise = handleResponses(req, res, () => {});
    await flushUntil(() => streamHandle !== null);

    streamHandle!.emit('end');
    await handlerPromise;

    res.writableEnded = true;                           // as Node marks it once the response is done
    res.emit('close');
    expect(aborted).toBe(0);
  });

  it('splits cached input tokens out of the non-streaming usage as well', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'hi' }, headers: {} };
    const res = mockRes();
    await handleResponses(req, res, () => {});

    // Mocked upstream usage: input_tokens 3 (of which 1 cached), output_tokens 4.
    const metrics = usageEvents[0][1];
    expect(metrics.inputTokens).toBe(2);
    expect(metrics.cacheReadInputTokens).toBe(1);
    expect(metrics.outputTokens).toBe(4);
  });

  it('returns the upstream status and parsed body when a STREAMING request fails upstream', async () => {
    // error.response.data is a live Readable here — logging it as metadata used to
    // throw "Converting circular structure to JSON" before the usage event and
    // res.json ran, so the handler rejected and the client hung.
    nextPostRejection = {
      status: 400,
      message: 'Request failed with status code 400',
      data: () => upstreamStreamBody({ error: { message: 'hosted tool not supported', type: 'invalid_request_error' } }),
    };

    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();

    await expect(handleResponses(req, res, () => {})).resolves.toBeUndefined();

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { message: 'hosted tool not supported', type: 'invalid_request_error' } });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(400);
    // The drained, parsed body reaches the log — not the raw stream.
    expect(loggedErrors[0].metadata).toEqual({
      status: 400,
      data: { error: { message: 'hosted tool not supported', type: 'invalid_request_error' } },
    });
  });

  it('writes a response.failed frame instead of a status when the headers were already sent', async () => {
    nextPostRejection = {
      status: 429,
      message: 'Request failed with status code 429',
      data: () => upstreamStreamBody({ error: { message: 'rate limited' } }),
    };

    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();
    res.headersSent = true;

    await expect(handleResponses(req, res, () => {})).resolves.toBeUndefined();

    const failedFrame = res.writes.find((w: string) => w.includes('response.failed'));
    expect(failedFrame).toBeDefined();
    expect(res.ended).toBe(true);
    expect(res.body).toBeUndefined();   // status was never touched
  });

  it('does not throw when the response is already ended', async () => {
    nextPostRejection = {
      status: 500,
      message: 'socket hang up',
      data: () => upstreamStreamBody({ error: { message: 'boom' } }),
    };

    const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
    const res = mockRes();
    res.writableEnded = true;

    // res.write throws on a finished response; the catch must swallow it rather
    // than reject out of the handler.
    await expect(handleResponses(req, res, () => {})).resolves.toBeUndefined();

    expect(res.writes).toHaveLength(0);  // nothing written to a finished response
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0][3]).toBe(500);
  });

  describe('continuation support', () => {
    it('stashes the upstream call context for the plugin, on the non-streaming path', async () => {
      const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'Say OK', max_output_tokens: 20 }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      const stash = (req as any).__responsesUpstream;
      expect(stash).toBeDefined();
      // Exact match, not .toContain: a weaker check would still pass for
      // 'undefined/responses', precisely what the no-deployment guard above
      // exists to prevent (see "rejects a config-flagged model that has no
      // deployment" above).
      expect(stash.url).toBe('http://mock-sap/deployments/abc/responses');
      expect(stash.headers.Authorization).toMatch(/^Bearer /);
      expect(typeof stash.timeoutMs).toBe('number');
      expect(stash.payload.model).toBe('gpt-5.3-codex');       // upstream name, not the --deployed alias
    });

    it('initializes __responsesExtraUsage to a zeroed accumulator up front, so a plugin can += onto it unconditionally', async () => {
      const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'hi' }, headers: {} };
      const res = mockRes();
      await handleResponses(req, res, () => {});

      // A plugin written as `req.__responsesExtraUsage.input_tokens += n` throws if
      // the property is missing; the throw is swallowed by pluginExecutor's
      // per-plugin catch, and the continuation's tokens vanish silently. This only
      // fails to throw if the controller pre-seeds the accumulator itself.
      expect((req as any).__responsesExtraUsage).toEqual({ input_tokens: 0, output_tokens: 0 });
    });

    it('adds continuation usage the plugin accumulates DURING the after-plugin chain to the usage event', async () => {
      // Exercises the real mechanism: the web-search continuation plugin runs its
      // second deployment call and accumulates usage inside executeAfterPlugins,
      // not before the controller calls it. A fixed passthrough mock (as this file
      // used before) can't tell the difference between the fold running before or
      // after executeAfterPlugins, because it never touches __responsesExtraUsage
      // itself — this configurable mock does.
      configState.hookConfig = [{ request: { callback: { id: 'webSearchContinuation' } } }];
      afterPlugins = (req: any, _res: any, body: any) => {
        const extra = (req as any).__responsesExtraUsage;
        extra.input_tokens += 40;
        extra.output_tokens += 7;
        return Promise.resolve(body);
      };

      const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'hi' }, headers: {} };
      const res = mockRes();

      await handleResponses(req, res, () => {});

      // Mocked non-streaming upstream usage in this file: input_tokens 3 (of which 1
      // cached, so 2 at full rate) + output_tokens 4 — see the "splits cached input
      // tokens" test above. Plus the plugin's 40 / 7 continuation usage, accumulated
      // during executeAfterPlugins. If emitUsageEvent ran before executeAfterPlugins
      // (the bug this task's reordering fixes), the plugin's mutation would land
      // too late and this would observe only the base 2 / 4.
      const metrics = usageEvents[0][1];
      expect(metrics.inputTokens).toBe(42);
      expect(metrics.outputTokens).toBe(11);
    });

    it('adds continuation usage reported by the plugin to the STREAMING usage event', async () => {
      const req = mockReq({ model: 'gpt-5.3-codex--deployed', input: 'Say OK', stream: true });
      const res = mockRes();

      const handlerPromise = handleResponses(req, res, () => {});
      await flushUntil(() => streamHandle !== null);

      // Simulates the web-search continuation plugin's second deployment call
      // completing and accumulating its own usage before the primary stream ends.
      // NOTE: that ordering does not occur in production — the continuation only STARTS
      // once the primary stream ends. This case pins the fold itself; the realistic
      // ordering (and the wait that makes it reachable) is covered by "waits for a
      // streaming web-search continuation before folding usage and closing the stream".
      (req as any).__responsesExtraUsage.input_tokens += 40;
      (req as any).__responsesExtraUsage.output_tokens += 7;

      const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
      streamHandle!.emit('data', Buffer.from(frame({
        type: 'response.completed',
        sequence_number: 3,
        response: {
          id: 'resp_1', status: 'completed',
          usage: { input_tokens: 120, output_tokens: 7, total_tokens: 127, input_tokens_details: { cached_tokens: 100 } },
        },
      })));
      streamHandle!.emit('end');

      await handlerPromise;

      expect(usageEvents).toHaveLength(1);
      const metrics = usageEvents[0][1];
      // Primary stream usage nets to 20 input (120 - 100 cached) / 7 output — see
      // the "reports the real token counts from the final response.completed
      // frame" test above — plus the plugin's 40 / 7 continuation usage folded in
      // after extraction.
      expect(metrics.inputTokens).toBe(60);
      expect(metrics.outputTokens).toBe(14);
    });
  });
});
