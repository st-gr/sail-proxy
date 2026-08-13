/**
 * The hosted-tool ENGINE, exercised with SYNTHETIC descriptors.
 *
 * `src/plugins/hostedTool/engine.ts` is descriptor-driven, but only ONE descriptor
 * (`web_search`, registered by `responsesWebSearchPlugin.ts`) exists in the product today.
 * Every other suite therefore drives the engine through that single tool — which leaves the
 * whole point of the extraction untested: per-descriptor cap accounting, per-group overflow,
 * and one tool blocking a round cannot be expressed with one descriptor registered.
 *
 * This suite registers two-to-three fake tools that do no I/O, touch no config and know
 * nothing about search, and pins the engine's *generalisation*:
 *
 *   1. a mixed turn resolves into ONE continuation POST carrying every function_call_output,
 *      in the order the model emitted the calls;
 *   2. one descriptor exhausting its cap does not stop another from spending its own;
 *   3. per-descriptor overflow blocks the continuation and splices the round in place;
 *   4. ONE tool overflowing blocks the WHOLE round, not just its own calls;
 *   5. calls that no cap can cover are DROPPED from `output`, not rendered as failed items
 *      (a different code path from overflow, and the one a prior draft conflated with it);
 *   6. a descriptor whose `renderResultMessage` returns null never puts a null into `output`;
 *   7. the before handler stashes each descriptor's `prepare()` result on the request, and
 *      `execute` receives its OWN tool's value back;
 *   8. `registerDescriptor` rejects a second descriptor claiming a key already held, and is
 *      a no-op for the same descriptor twice.
 *
 * BOTH TRANSPORTS. Items 1-8 above are the after (non-streaming) handler. The STREAMING
 * interceptor keeps its OWN cap accounting — a second `callsRunByType` Map, read and
 * incremented by its own `performCall` — structurally separate code from the after handler's
 * `takenByType` admission, and reachable by no test in this repo with more than one
 * descriptor registered. Codex CLI always streams, so that is the transport that matters
 * most. The final describe block is therefore the streaming twin of items 2-4: independent
 * per-descriptor budgets across continuation rounds, independent budgets within one round,
 * and one exhausted tool blocking the whole turn. There is deliberately no streaming twin of
 * item 5 — see the comment on that block for why the streaming path has no drop at all.
 *
 * FIXTURE HYGIENE. Where an ordering is asserted, the fixture's orderings deliberately
 * disagree (emission order is neither registration order nor grouped-by-tool order); where a
 * cap is asserted, the two caps are different numbers. A fixture that made those coincide
 * would pass whether or not the covered behaviour existed.
 *
 * MUTATION-TESTED. Every test here was verified to FAIL against a deliberately mutated
 * engine/registry; see the task report for the mutation list and output.
 *
 * @see src/plugins/hostedTool/descriptor.ts - the contract the fakes below implement
 * @see test/responses-websearch-characterization.test.ts - the same engine through the REAL
 *      web_search descriptor, byte for byte
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a) },
}));

import {
  HostedToolDescriptor, ParsedCall, ToolExecCtx, ToolExecResult,
} from '../src/plugins/hostedTool/descriptor';
import {
  registerDescriptor, descriptorForType, descriptorForFunctionName, __resetRegistry,
} from '../src/plugins/hostedTool/registry';
import {
  hostedToolBeforeHandler, hostedToolAfterHandler,
} from '../src/plugins/hostedTool/engine';
// The REAL orchestration translators, for the continuation-reply suite at the bottom of
// this file: the engine's response-side hooks are only worth pinning against what the
// controller actually stashes in them.
import { translateOrchestrationResponse } from '../src/responses/orchestrationBridge/responseTranslator';
import { createOrchestrationBlockTranslator } from '../src/responses/orchestrationBridge/streamTranslator';

const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };

/** Must match the engine's private REWROTE_FLAG — the after handler's entry condition. */
const REWROTE_FLAG = '__responsesWebSearchRewritten';
/** Must match the engine's private PREPARED_FLAG — item 7 is precisely that it is set. */
const PREPARED_FLAG = '__hostedToolPrepared';

// ------------------------------------------------------------------ synthetic descriptors

/** Every `execute` across every fake tool, in call order: `"<type>:<call_id>"`. */
let execLog: string[] = [];

interface FakeTool {
  descriptor: HostedToolDescriptor;
  /** The object `prepare()` returns — handed back to `execute` as `ctx.prepared`. */
  preparedValue: { tool: string };
  /** One entry per `execute`, recorded on ENTRY (before any await). */
  executed: Array<{ callId: string; q: any; prepared: unknown; isStreaming: boolean }>;
  prepareCalls: number;
  /** The highest number of this tool's `execute` bodies in flight at once. */
  maxInFlight: number;
}

/**
 * A descriptor that does nothing but record what the engine asked it to do.
 *
 * Ids are derived from the call_id rather than minted, so every expectation below can be a
 * literal — no synthetic-id normalisation, and a wrong item is a readable diff.
 */
function makeTool(opts: {
  type: string;
  cap: number;
  /** false ⇒ `renderResultMessage` returns null, i.e. a tool with nothing readable to show. */
  withMessage?: boolean;
  /** Makes `execute` span a real timer, so overlapping calls are observable. */
  delayMs?: number;
  /** What `prepare()` throws instead of resolving. The engine's reject-vs-degrade rule
   *  reads the ERROR, not the descriptor, so this is how both branches are driven. */
  prepareThrows?: any;
}): FakeTool {
  const withMessage = opts.withMessage !== false;
  const state: FakeTool = {
    descriptor: null as any,
    preparedValue: { tool: opts.type },
    executed: [],
    prepareCalls: 0,
    maxInFlight: 0,
  };
  let inFlight = 0;

  state.descriptor = {
    type: opts.type,
    functionName: `${opts.type}_fn`,

    rewriteTool: (hosted: any) => ({
      type: 'function',
      name: `${opts.type}_fn`,
      description: `synthetic ${opts.type}`,
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      __from: hosted?.type,
    }),

    prepare: async () => {
      state.prepareCalls += 1;
      if (opts.prepareThrows) throw opts.prepareThrows;
      return state.preparedValue;
    },

    parseCall: (callId: string, rawArguments: string): ParsedCall => {
      let args: any = {};
      try { args = JSON.parse(rawArguments); } catch { args = {}; }
      return { callId, rawArguments, args };
    },

    execute: async (call: ParsedCall, ctx: ToolExecCtx): Promise<ToolExecResult> => {
      inFlight += 1;
      if (inFlight > state.maxInFlight) state.maxInFlight = inFlight;
      execLog.push(`${opts.type}:${call.callId}`);
      state.executed.push({
        callId: call.callId, q: call.args?.q, prepared: ctx.prepared, isStreaming: ctx.isStreaming,
      });
      try {
        if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
        return { call, status: 'completed', payload: { echo: `${opts.type} ran ${call.args?.q}` } };
      } finally {
        inFlight -= 1;
      }
    },

    renderOutput: (r: ToolExecResult) => ({
      type: 'function_call_output',
      call_id: r.call.callId,
      output: JSON.stringify(r.status === 'completed' ? r.payload : { error: 'unavailable' }),
    }),

    renderCallItem: (r: ToolExecResult, o) => ({
      type: `${opts.type}_call`,
      id: `${opts.type}_item_${r.call.callId}`,
      status: r.status,
      query: r.call.args?.q ?? null,
      ...(o.includeResults ? { results: r.payload } : {}),
    }),

    renderResultMessage: (r: ToolExecResult) => (withMessage ? {
      type: 'message',
      id: `${opts.type}_msg_${r.call.callId}`,
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: `${opts.type}:${r.status}:${r.call.args?.q ?? 'none'}`,
        annotations: [],
      }],
    } : null),

    maxCallsPerRequest: () => opts.cap,
  };

  registerDescriptor(state.descriptor);
  return state;
}

// ------------------------------------------------------------------------------ fixtures

const REASONING = { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAAAopaque==', summary: [] };
const FINAL_MSG = {
  type: 'message', id: 'msg_final', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'the model answered', annotations: [] }],
};

/** A `function_call` the model emitted against `<type>`'s rewritten function tool. */
function fc(type: string, callId: string, q: string): any {
  return {
    type: 'function_call', id: `fc_${callId}`, call_id: callId,
    name: `${type}_fn`, arguments: JSON.stringify({ q }),
  };
}

/** The call item `<type>` renders for `callId`. */
function callItem(type: string, callId: string, q: string, status = 'completed'): any {
  return { type: `${type}_call`, id: `${type}_item_${callId}`, status, query: q };
}

/** The result-dump message `<type>` renders for `callId`. */
function msgItem(type: string, callId: string, q: string, status = 'completed'): any {
  return {
    type: 'message', id: `${type}_msg_${callId}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: `${type}:${status}:${q}`, annotations: [] }],
  };
}

const UPSTREAM = () => ({
  url: 'https://sap.example/d1/responses',
  headers: { Authorization: 'Bearer t' },
  timeoutMs: 5000,
  payload: { model: 'm', input: 'go', stream: false },
});

/** A request the after handler will act on: rewritten, non-streaming, continuable. */
function afterReq(overrides: any = {}): any {
  const req: any = {
    body: { stream: false, input: 'go', ...(overrides.body || {}) },
    __responsesUpstream: 'upstream' in overrides ? overrides.upstream : UPSTREAM(),
  };
  req[REWROTE_FLAG] = true;
  return req;
}

/** One deployment response, in the non-streaming (blocking) shape. */
function reply(id: string, output: any[], usage = { input_tokens: 5, output_tokens: 1 }): any {
  return { data: { id, status: 'completed', output, usage } };
}

function firstTurn(output: any[]): any {
  return { id: 'resp_1', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2 } };
}

/** The `input` array of the n-th continuation POST. */
function postedInput(n: number): any[] {
  return (mockPost.mock.calls[n] as any[])[1].input;
}

beforeEach(() => {
  __resetRegistry();
  execLog = [];
  mockPost.mockReset();
  utils.logger.error.mockClear();
  utils.logger.warn.mockClear();
});

// =============================================================================== the suite

describe('hostedTool engine — tool_choice on continuations', () => {
  /** The `tool_choice` of the n-th continuation POST. */
  function postedToolChoice(n: number): any {
    return (mockPost.mock.calls[n] as any[])[1].tool_choice;
  }

  function upstreamWith(toolChoice: any): any {
    return { ...UPSTREAM(), payload: { model: 'm', input: 'go', stream: false, tool_choice: toolChoice } };
  }

  it("relaxes tool_choice 'required' to 'auto', so the model can answer instead of calling again", async () => {
    // `required` means "call a tool this turn". The continuation IS a new turn, so
    // forwarding it verbatim forces another call, forever, until a cap stops it. Observed
    // live 2026-08-07: three file_search_call items and no message at all.
    const alpha = makeTool({ type: 'alpha', cap: 3 });
    const req = afterReq({ upstream: upstreamWith('required') });
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    await hostedToolAfterHandler({
      req, res: {} as any, utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(postedToolChoice(0)).toBe('auto');
    // The client's own request object is untouched — only the outbound copy is relaxed.
    expect(req.__responsesUpstream.payload.tool_choice).toBe('required');
    expect(alpha.executed).toHaveLength(1);
  });

  it('relaxes an object choice that names a hosted tool, which loops for the same reason', async () => {
    makeTool({ type: 'alpha', cap: 3 });
    const req = afterReq({ upstream: upstreamWith({ type: 'alpha' }) });
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    await hostedToolAfterHandler({
      req, res: {} as any, utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    expect(postedToolChoice(0)).toBe('auto');
  });

  it("leaves 'auto', 'none' and a CLIENT function choice exactly as the client sent them", async () => {
    // A forced client function cannot loop here: its call is not a hosted-tool call, so the
    // continuation loop ends on it. Rewriting it would override the client for no reason.
    for (const choice of ['auto', 'none', { type: 'function', name: 'client_fn' }]) {
      __resetRegistry();
      mockPost.mockReset();
      makeTool({ type: 'alpha', cap: 3 });
      const req = afterReq({ upstream: upstreamWith(choice) });
      mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

      // eslint-disable-next-line no-await-in-loop
      await hostedToolAfterHandler({
        req, res: {} as any, utils,
        upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
      });

      expect(postedToolChoice(0)).toEqual(choice);
    }
  });

  it('omits tool_choice entirely when the client sent none', async () => {
    makeTool({ type: 'alpha', cap: 3 });
    const req = afterReq();
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    await hostedToolAfterHandler({
      req, res: {} as any, utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    expect((mockPost.mock.calls[0] as any[])[1]).not.toHaveProperty('tool_choice');
  });
});

describe('hostedTool engine — a turn that calls two different tools', () => {
  it('resolves a mixed turn into ONE continuation POST carrying every function_call_output in emission order', async () => {
    // Caps are different numbers and neither binds here: this test is about grouping, not
    // budget. Registration order is alpha-then-beta; the model emits beta, alpha, beta —
    // so "grouped by tool" and "registration order" both differ from emission order, and an
    // engine that grouped per tool would POST twice (or once, ordered b1,b2,a1).
    const alpha = makeTool({ type: 'alpha', cap: 2 });
    const beta = makeTool({ type: 'beta', cap: 3 });

    const req = afterReq();
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    const result = await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: firstTurn([
        REASONING, fc('beta', 'c_b1', 'b1'), fc('alpha', 'c_a1', 'a1'), fc('beta', 'c_b2', 'b2'),
      ]),
    });

    // ONE continuation POST for the whole turn, not one per tool and not one per call.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(utils.logger.error).not.toHaveBeenCalled();

    // Every call ran, in the order the model emitted them.
    expect(execLog).toEqual(['beta:c_b1', 'alpha:c_a1', 'beta:c_b2']);
    expect(alpha.executed.map(e => e.callId)).toEqual(['c_a1']);
    expect(beta.executed.map(e => e.callId)).toEqual(['c_b1', 'c_b2']);

    // The POSTed turn is well-formed: every function_call carried forward, and one
    // function_call_output per call, in emission order — each rendered by its OWN descriptor.
    const input = postedInput(0);
    expect(input.filter((i: any) => i.type === 'function_call').map((i: any) => i.call_id))
      .toEqual(['c_b1', 'c_a1', 'c_b2']);
    expect(input.filter((i: any) => i.type === 'function_call_output')).toEqual([
      { type: 'function_call_output', call_id: 'c_b1', output: JSON.stringify({ echo: 'beta ran b1' }) },
      { type: 'function_call_output', call_id: 'c_a1', output: JSON.stringify({ echo: 'alpha ran a1' }) },
      { type: 'function_call_output', call_id: 'c_b2', output: JSON.stringify({ echo: 'beta ran b2' }) },
    ]);
    // The outputs are the LAST items: the round's own output precedes them.
    expect(input.slice(-3).map((i: any) => i.call_id)).toEqual(['c_b1', 'c_a1', 'c_b2']);
    // The conversation POSTed back opens with the original input, not just this round.
    expect(input[0]).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] });

    // What the client sees: each function_call swapped for ITS OWN tool's call item, in
    // place (the reasoning item that preceded them still does), then the model's answer.
    // A committed round contributes no result dumps — the continuation carries the answer.
    expect(result.output).toEqual([
      REASONING,
      callItem('beta', 'c_b1', 'b1'),
      callItem('alpha', 'c_a1', 'a1'),
      callItem('beta', 'c_b2', 'b2'),
      FINAL_MSG,
    ]);
    expect(result.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('runs a round\'s calls one at a time — no two executes overlap', async () => {
    // What this pins is exactly one thing: the resolution loop is SERIAL. It does not claim
    // the engine's OUTPUT would differ under `Promise.all` — the counts are incremented
    // before the first await and array order is preserved either way, so the observable
    // response would be identical. Serial execution is nonetheless the property the engine
    // documents and the one that bounds concurrent load on whatever a descriptor calls out
    // to, so it is pinned here by a descriptor that can see the difference.
    const slow = makeTool({ type: 'slow', cap: 3, delayMs: 15 });

    const req = afterReq();
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: firstTurn([fc('slow', 's1', 'q1'), fc('slow', 's2', 'q2'), fc('slow', 's3', 'q3')]),
    });

    expect(execLog).toEqual(['slow:s1', 'slow:s2', 'slow:s3']);
    expect(slow.maxInFlight).toBe(1);
  });
});

describe('hostedTool engine — per-descriptor caps', () => {
  it('lets one tool keep spending its budget across later rounds after another has exhausted its own', async () => {
    // Deliberately different numbers: a single shared counter, or a cap read from the wrong
    // descriptor, cannot satisfy both. alpha is exhausted by round 1; beta spends rounds 2-3.
    const alpha = makeTool({ type: 'alpha', cap: 1 });
    const beta = makeTool({ type: 'beta', cap: 3 });

    const req = afterReq();
    mockPost
      .mockResolvedValueOnce(reply('resp_2', [fc('beta', 'c_b2', 'b2')]))
      .mockResolvedValueOnce(reply('resp_3', [fc('beta', 'c_b3', 'b3')]))
      .mockResolvedValueOnce(reply('resp_4', [FINAL_MSG]));

    const result = await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1'), fc('beta', 'c_b1', 'b1')]),
    });

    // Three continuation POSTs: alpha running out in round 1 stopped nothing.
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(execLog).toEqual(['alpha:c_a1', 'beta:c_b1', 'beta:c_b2', 'beta:c_b3']);
    expect(alpha.executed).toHaveLength(1);           // its own cap of 1
    expect(beta.executed).toHaveLength(3);            // its own cap of 3, two of them AFTER
    expect(utils.logger.error).not.toHaveBeenCalled();

    // Every round's items reach the client, in round order, with the model's answer last.
    expect(result.output).toEqual([
      callItem('alpha', 'c_a1', 'a1'),
      callItem('beta', 'c_b1', 'b1'),
      callItem('beta', 'c_b2', 'b2'),
      callItem('beta', 'c_b3', 'b3'),
      FINAL_MSG,
    ]);
    // Usage is summed across every deployment call: 10 + 5 + 5 + 5, 2 + 1 + 1 + 1. None of
    // the four rounds' fixtures carry `input_tokens_details`, so the merged object's cache
    // breakdown sums to zero on both fields and `total_tokens` recomputes to 30 (T10 — see
    // the dedicated describe block below for the discriminating case where cache activity
    // differs per round).
    expect(result.usage).toEqual({
      input_tokens: 25,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      total_tokens: 30,
    });
  });

  it('blocks the continuation when one tool is asked for more calls than its own cap allows', async () => {
    // Two alpha calls against a cap of 1. The first is admitted and runs; the second cannot
    // be answered, so the turn cannot be POSTed at all — a function_call with no
    // function_call_output is the malformed shape the deployment rejects.
    const alpha = makeTool({ type: 'alpha', cap: 1 });

    const req = afterReq();

    const result = await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: firstTurn([REASONING, fc('alpha', 'c_a1', 'a1'), fc('alpha', 'c_a2', 'a2')]),
    });

    expect(mockPost).not.toHaveBeenCalled();
    expect(execLog).toEqual(['alpha:c_a1']);
    expect(alpha.executed).toHaveLength(1);

    // Spliced in place — the reasoning item that preceded the calls still precedes them —
    // as [completed, failed]: the admitted call's real result, then the one that never ran.
    expect(result.output).toEqual([
      REASONING,
      callItem('alpha', 'c_a1', 'a1'),
      msgItem('alpha', 'c_a1', 'a1'),
      callItem('alpha', 'c_a2', 'a2', 'failed'),
      msgItem('alpha', 'c_a2', 'a2', 'failed'),
    ]);
    expect(result.output.filter((i: any) => i.type === 'alpha_call').map((i: any) => i.status))
      .toEqual(['completed', 'failed']);
  });

  it('lets ONE overflowing tool block the whole round, including a tool that still had budget', async () => {
    // alpha overflows (cap 1, two calls); beta has 2 of its 3 left and its call DOES run.
    // The round is still not continued: the batch it would POST carries an unanswerable
    // alpha call. This is the difference from the previous test — budget elsewhere does not
    // rescue the round.
    const alpha = makeTool({ type: 'alpha', cap: 1 });
    const beta = makeTool({ type: 'beta', cap: 3 });

    const req = afterReq();

    const result = await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: firstTurn([
        fc('alpha', 'c_a1', 'a1'), fc('beta', 'c_b1', 'b1'), fc('alpha', 'c_a2', 'a2'),
      ]),
    });

    expect(mockPost).not.toHaveBeenCalled();
    // beta ran — it was admitted — so what is blocked is the CONTINUATION, not the call.
    expect(execLog).toEqual(['alpha:c_a1', 'beta:c_b1']);
    expect(beta.executed.map(e => e.callId)).toEqual(['c_b1']);
    expect(alpha.executed.map(e => e.callId)).toEqual(['c_a1']);

    expect(result.output).toEqual([
      callItem('alpha', 'c_a1', 'a1'),
      msgItem('alpha', 'c_a1', 'a1'),
      callItem('beta', 'c_b1', 'b1'),
      msgItem('beta', 'c_b1', 'b1'),
      callItem('alpha', 'c_a2', 'a2', 'failed'),
      msgItem('alpha', 'c_a2', 'a2', 'failed'),
    ]);
    // beta's own call is completed even though the round was blocked by alpha's overflow.
    expect(result.output.filter((i: any) => i.type === 'beta_call').map((i: any) => i.status))
      .toEqual(['completed']);
  });
});

/**
 * T10: the client-visible merged `usage` object across continuation rounds.
 *
 * Before this fix, `input_tokens`/`output_tokens` were summed across rounds but the object
 * was built by SPREADING the LAST round's usage and overriding only those two fields — so
 * `input_tokens_details` (`cached_tokens`, `cache_write_tokens`) and `total_tokens`
 * described the last round ALONE, next to a summed `input_tokens`/`output_tokens` that
 * described every round. The fix sums the cache breakdown the same way as input/output, and
 * recomputes `total_tokens` from the summed input/output — mirroring the identity the
 * bridge's own `translateUsage` establishes for a single round on this route: `input_tokens`
 * is already inclusive of cache, so `total_tokens = input_tokens + output_tokens`.
 *
 * Numbers are chosen so every asserted field is DISCRIMINATING — the sum differs from every
 * individual round's own value for that field, so a mutation back to last-round-spread (or
 * to last-round `total_tokens`) is caught, not accidentally matched:
 *   round 1 (first turn):        input 50,  output 5,  cached 10, LEGACY cache_creation_tokens 2
 *   round 2 (continuation 1):    input 80,  output 6,  NO input_tokens_details at all
 *   round 3 (continuation 2):    input 120, output 9,  cached 15, REAL cache_write_tokens 3, total 129
 *   sums:                        input 250, output 20, cached 25, write 5,  total 270
 *
 * Rounds 1 and 3 deliberately use the legacy and the real field name respectively — this is
 * also the regression coverage for the cache-write field-name fix: round 1's legacy
 * `cache_creation_tokens` proves the fallback still works, round 3's real `cache_write_tokens`
 * proves the field this bug used to silently read as 0 is now counted. Before the fix this
 * summed to 2 (legacy only); now it sums to 5.
 */
describe('hostedTool engine — merged usage across continuation rounds (T10)', () => {
  it('sums the cache breakdown across rounds and recomputes total_tokens, instead of spreading the last round\'s details', async () => {
    makeTool({ type: 'alpha', cap: 3 });
    const req = afterReq();
    mockPost
      .mockResolvedValueOnce({
        data: {
          id: 'resp_2', status: 'completed', output: [fc('alpha', 'c_a2', 'a2')],
          // Deliberately detail-less: a round with no `input_tokens_details` at all must
          // contribute 0 to both summed cache fields, not throw and not be skipped wholesale.
          usage: { input_tokens: 80, output_tokens: 6 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 'resp_3', status: 'completed', output: [FINAL_MSG],
          // REAL field name — this is what a real upstream (or our own deployed path) sends.
          usage: {
            input_tokens: 120, output_tokens: 9,
            input_tokens_details: { cached_tokens: 15, cache_write_tokens: 3 },
            total_tokens: 129,
          },
        },
      });

    const result = await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: {
        id: 'resp_1', status: 'completed', output: [fc('alpha', 'c_a1', 'a1')],
        // LEGACY field name — a replayed history or a lagging upstream. Backward-compat
        // fallback must still count it.
        usage: {
          input_tokens: 50, output_tokens: 5,
          input_tokens_details: { cached_tokens: 10, cache_creation_tokens: 2 },
        },
      },
    });

    expect(result.usage).toEqual({
      input_tokens: 250,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 25, cache_write_tokens: 5 },
      total_tokens: 270,
    });
  });
});

describe('hostedTool engine — calls no cap can cover are dropped, not failed', () => {
  it('drops every stranded call from output when nothing is within any cap', async () => {
    // A cap of 0 (the tool is configured off) means not one call can be admitted, so the
    // loop breaks BEFORE the in-place splice — a different code path from overflow above,
    // and the distinction is load-bearing: overflow renders failed items, this drops them.
    // Two call items in must therefore produce ZERO items out, not two and not three.
    const zeta = makeTool({ type: 'zeta', cap: 0 });

    const req = afterReq();

    const result = await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: firstTurn([fc('zeta', 'c_z1', 'z1'), fc('zeta', 'c_z2', 'z2')]),
    });

    expect(mockPost).not.toHaveBeenCalled();
    expect(zeta.executed).toHaveLength(0);
    expect(execLog).toEqual([]);
    expect(result.output).toEqual([]);
    // Not "no function_calls" — no ITEMS at all. A failed-placeholder render would leave two.
    expect(result.output).toHaveLength(0);
  });

  it('drops a stranded call from a LATER round while keeping everything the earlier rounds produced', async () => {
    // Round 1 spends alpha's only budget and is continued; the model then asks for alpha
    // again. That call can never be answered, so it is dropped outright — the client keeps
    // round 1's items and gains no failed call item and no result dump for the stranded one.
    const alpha = makeTool({ type: 'alpha', cap: 1 });

    const req = afterReq();
    mockPost.mockResolvedValueOnce(reply('resp_2', [REASONING, fc('alpha', 'c_a2', 'a2')]));

    const result = await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(alpha.executed.map(e => e.callId)).toEqual(['c_a1']);

    // The stranded call vanishes; the reasoning item it arrived with does not.
    expect(result.output).toEqual([callItem('alpha', 'c_a1', 'a1'), REASONING]);
    expect(result.output.some((i: any) => i.status === 'failed')).toBe(false);
    expect(result.output.some((i: any) => i.id === 'alpha_item_c_a2')).toBe(false);
    expect(result.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });
});

describe('hostedTool engine — a descriptor with no result message', () => {
  it('never puts a null into output for a descriptor whose renderResultMessage returns null', async () => {
    // `delta` has nothing readable to show; `alpha` does. Both resolve on a stopping path
    // (no upstream context ⇒ no continuation), which is the only path that emits result
    // dumps at all — so the two are distinguishable here and a blanket "no messages" bug
    // would fail on alpha's.
    const delta = makeTool({ type: 'delta', cap: 2, withMessage: false });
    makeTool({ type: 'alpha', cap: 3 });

    const req = afterReq({ upstream: undefined });

    const result = await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: firstTurn([fc('delta', 'c_d1', 'd1'), fc('alpha', 'c_a1', 'a1')]),
    });

    expect(mockPost).not.toHaveBeenCalled();
    expect(delta.descriptor.renderResultMessage({ call: { callId: 'x', rawArguments: '', args: {} }, status: 'completed', payload: null })).toBeNull();

    expect(result.output).toEqual([
      callItem('delta', 'c_d1', 'd1'),
      callItem('alpha', 'c_a1', 'a1'),
      msgItem('alpha', 'c_a1', 'a1'),
    ]);
    expect(result.output.every((i: any) => i !== null && i !== undefined)).toBe(true);
    expect(result.output.filter((i: any) => i === null)).toHaveLength(0);
  });
});

describe('hostedTool engine — the before handler stashes prepare() results', () => {
  it('stashes each descriptor\'s prepare() result on the request and hands each execute its OWN', async () => {
    // No-op for web_search (its executor ignores `prepared`), so nothing else in the suite
    // notices if the stash disappears — and the next tool to be registered needs it.
    const alpha = makeTool({ type: 'alpha', cap: 2 });
    const beta = makeTool({ type: 'beta', cap: 3 });

    const req: any = {
      body: { stream: false, input: 'go', tools: [{ type: 'alpha', extra: 1 }, { type: 'beta' }] },
    };

    await hostedToolBeforeHandler({ req, res: {} as any, utils });

    // The stash itself: keyed by tool type, one entry per hosted tool present.
    const prepared = req[PREPARED_FLAG] as Map<string, unknown>;
    expect(prepared).toBeInstanceOf(Map);
    expect([...prepared.keys()].sort()).toEqual(['alpha', 'beta']);
    expect(prepared.get('alpha')).toBe(alpha.preparedValue);
    expect(prepared.get('beta')).toBe(beta.preparedValue);
    // Distinct objects, so "handed the right one" cannot pass by coincidence.
    expect(prepared.get('alpha')).not.toBe(prepared.get('beta'));
    expect(alpha.prepareCalls).toBe(1);
    expect(beta.prepareCalls).toBe(1);

    // And what it is FOR: the value reaches each descriptor's own execute.
    req.__responsesUpstream = undefined;
    await hostedToolAfterHandler({
      req,
      res: {} as any,
      utils,
      upstreamResponse: firstTurn([fc('beta', 'c_b1', 'b1'), fc('alpha', 'c_a1', 'a1')]),
    });

    expect(alpha.executed.map(e => e.prepared)).toEqual([alpha.preparedValue]);
    expect(beta.executed.map(e => e.prepared)).toEqual([beta.preparedValue]);
    expect(alpha.executed[0].prepared).not.toBe(beta.preparedValue);
  });
});

/**
 * WHAT A prepare() THROW MEANS — the engine's one branch on an error it did not raise.
 *
 * The before handler used to catch every `prepare()` failure, log it, and carry on with
 * `prepared === undefined`. That contract was written when the only descriptor's prepare()
 * was `async () => undefined` and could not fail. It cannot survive a RETRIEVAL tool:
 * `prepare()` is the last moment a caller's mistake can be reported at all, because once
 * the SSE stream is open a typo'd store id and an empty corpus are the same observation
 * ("no passages found") forever.
 *
 * The rule is structural, and both halves are load-bearing:
 *
 *   has a numeric HTTP `status`  =>  REJECT the request with it   (the caller's mistake)
 *   no `status`                  =>  degrade, exactly as before   (infrastructure)
 *
 * Widening it to "any throw rejects" would take a whole request down because one tool's
 * database was briefly unreachable — for a tool the turn might never call.
 */
describe('hostedTool engine — a prepare() failure the CALLER can fix rejects the request', () => {
  /** A res that records the status/body a stopping plugin writes itself. Deliberately
   *  NOT a stub that swallows: a handler returning `{stop:true}` without writing produces
   *  a request that hangs with nothing sent, and that is what these assert against. */
  function recordingRes(): any {
    const sent: any = { status: undefined as number | undefined, body: undefined as any };
    return {
      sent,
      headersSent: false,
      status(code: number) { sent.status = code; return this; },
      json(body: any) { sent.body = body; this.headersSent = true; return this; },
      write() { return true; },
      end() { return this; },
      setHeader() { /* no-op */ },
    };
  }

  function reqWith(tools: any[], stream = false): any {
    return { body: { stream, input: 'go', tools } };
  }

  /** The 400 shape `fileSearchDescriptor.prepare` actually raises. */
  const toolRequestError = (): any =>
    Object.assign(new Error('Unknown vector store: vs_typo'), {
      name: 'ToolRequestError', status: 400, code: 'invalid_request_error',
    });

  it('answers 400 with the OpenAI error envelope and stops the request', async () => {
    makeTool({ type: 'alpha', cap: 2, prepareThrows: toolRequestError() });
    const req = reqWith([{ type: 'alpha', vector_store_ids: ['vs_typo'] }]);
    const res = recordingRes();

    const result: any = await hostedToolBeforeHandler({ req, res, utils });

    expect(result).toEqual({ stop: true });
    expect(res.sent.status).toBe(400);
    expect(res.sent.body).toEqual({
      error: {
        message: 'Unknown vector store: vs_typo',
        type: 'invalid_request_error',
        code: 'invalid_request_error',
      },
    });
  });

  it('WRITES the body before stopping — `{stop:true}` alone is a hung request', async () => {
    // `PluginResult.response` is declared but no controller reads it: every one of them
    // does `if (pluginResult?.stop) return;` with the comment "Response already sent by
    // plugin". A handler that returned `{stop:true, response}` and wrote nothing would
    // leave the client waiting on a socket nobody ever answers.
    makeTool({ type: 'alpha', cap: 2, prepareThrows: toolRequestError() });
    const res = recordingRes();

    const result: any = await hostedToolBeforeHandler({
      req: reqWith([{ type: 'alpha' }]), res, utils,
    });

    expect(res.sent.status).toBeDefined();
    expect(res.sent.body).toBeDefined();
    expect(result.response).toBeUndefined();
  });

  it('carries the error class\'s own wire code — a 409 stays a 409', async () => {
    // StoreExpiredError / StoreDimensionMismatchError declare `status` AND `code`, so the
    // tool's rejection reads identically to the REST surface's for the same condition.
    makeTool({
      type: 'alpha',
      cap: 2,
      prepareThrows: Object.assign(new Error('Vector store vs_1 has expired'), {
        name: 'StoreExpiredError', status: 409, code: 'vector_store_expired',
      }),
    });
    const res = recordingRes();

    await hostedToolBeforeHandler({ req: reqWith([{ type: 'alpha' }]), res, utils });

    expect(res.sent.status).toBe(409);
    expect(res.sent.body.error.code).toBe('vector_store_expired');
  });

  it('DEGRADES a bare Error with no status — infrastructure is not the caller\'s mistake', async () => {
    // `new Error('file_search database is not configured')`, raised when the pool is null.
    // The caller cannot act on it, and one tool's outage must not fail a request that may
    // never call that tool.
    const alpha = makeTool({
      type: 'alpha', cap: 2, prepareThrows: new Error('file_search database is not configured'),
    });
    const req = reqWith([{ type: 'alpha' }]);
    const res = recordingRes();

    const result: any = await hostedToolBeforeHandler({ req, res, utils });

    expect(result).toEqual({ stop: false });
    expect(res.sent.status).toBeUndefined();
    expect(res.sent.body).toBeUndefined();
    // The turn opens anyway, with no prepared value for this tool.
    expect(req[PREPARED_FLAG].get('alpha')).toBeUndefined();
    expect(alpha.prepareCalls).toBe(1);
    expect(utils.logger.error).toHaveBeenCalled();
  });

  it('degrades a non-HTTP `status` too, so an unrelated field can never masquerade as one', async () => {
    // A store row's `status: 'expired'`, a `status: 0` — neither is a response code.
    for (const status of ['expired', 0, 200, 700, 1.5]) {
      __resetRegistry();
      const res = recordingRes();
      const req = reqWith([{ type: 'alpha' }]);
      makeTool({ type: 'alpha', cap: 2, prepareThrows: Object.assign(new Error('nope'), { status }) });

      const result: any = await hostedToolBeforeHandler({ req, res, utils });

      expect(result).toEqual({ stop: false });
      expect(res.sent.status).toBeUndefined();
    }
  });

  it('DEGRADES a 5xx `status` — a remote service being down is not the caller\'s mistake', async () => {
    // `rejectionStatusOf` is bounded to 400..499, not 400..599, and this is the test that
    // says why. Nothing in the product throws a 5xx out of `prepare()` today, but AXIOS
    // sets a top-level numeric `status` on its errors and axios is used throughout this
    // stack: the first descriptor whose `prepare()` validates against a remote service
    // would, on that service's 503, hand this loop an error carrying `status: 503`.
    //
    // Under a 400..599 bound that request is REJECTED — the exact opposite of the rule
    // the block above documents ("infrastructure ... the caller cannot act on it") — and
    // the envelope stamps it `invalid_request_error`, telling the caller they got their
    // own request wrong. Widen the bound back to 599 and this test fails on the first
    // assertion.
    for (const status of [500, 502, 503, 504, 599]) {
      __resetRegistry();
      const res = recordingRes();
      const req = reqWith([{ type: 'alpha' }]);
      const alpha = makeTool({
        type: 'alpha',
        cap: 2,
        prepareThrows: Object.assign(new Error('upstream unavailable'), {
          name: 'AxiosError', status, code: 'ERR_BAD_RESPONSE',
        }),
      });

      const result: any = await hostedToolBeforeHandler({ req, res, utils });

      expect(result).toEqual({ stop: false });      // the turn opens
      expect(res.sent.status).toBeUndefined();      // nothing was written to the client
      expect(res.sent.body).toBeUndefined();
      expect(req[PREPARED_FLAG].get('alpha')).toBeUndefined();
      expect(alpha.prepareCalls).toBe(1);
    }
  });

  it('still REJECTS across the whole 4xx range, so the 5xx narrowing cost nothing', async () => {
    // The counterpart of the test above: narrowing the bound must not have taken any
    // client-error code with it. 499 is the top of the range and the one a `<= 499`
    // off-by-one would drop.
    for (const status of [400, 404, 409, 413, 422, 429, 499]) {
      __resetRegistry();
      const res = recordingRes();
      makeTool({
        type: 'alpha',
        cap: 2,
        prepareThrows: Object.assign(new Error('caller error'), { status, code: 'invalid_request_error' }),
      });

      const result: any = await hostedToolBeforeHandler({ req: reqWith([{ type: 'alpha' }]), res, utils });

      expect(result).toEqual({ stop: true });
      expect(res.sent.status).toBe(status);
    }
  });

  it('does not install the SSE interceptor before the rejection is written', async () => {
    // The interceptor replaces res.write/res.end with SSE-block-parsing versions. Installed
    // ahead of the prepare loop (where it used to be), the JSON error body below would be
    // pushed through a frame splitter. `stream: true` is the path that installs it.
    makeTool({ type: 'alpha', cap: 2, prepareThrows: toolRequestError() });
    const res = recordingRes();
    const pristineWrite = res.write;
    const pristineEnd = res.end;

    await hostedToolBeforeHandler({ req: reqWith([{ type: 'alpha' }], true), res, utils });

    expect(res.sent.status).toBe(400);
    expect(res.write).toBe(pristineWrite);
    expect(res.end).toBe(pristineEnd);
  });

  it('still installs the interceptor on a streaming turn that prepares cleanly', async () => {
    // The guard above must not have cost the streaming path its interceptor.
    makeTool({ type: 'alpha', cap: 2 });
    const res = recordingRes();
    const pristineWrite = res.write;

    const result: any = await hostedToolBeforeHandler({ req: reqWith([{ type: 'alpha' }], true), res, utils });

    expect(result).toEqual({ stop: false });
    expect(res.write).not.toBe(pristineWrite);
  });

  it('rejects on the FIRST caller error and never prepares the tools after it', async () => {
    makeTool({ type: 'alpha', cap: 2, prepareThrows: toolRequestError() });
    const beta = makeTool({ type: 'beta', cap: 3 });
    const res = recordingRes();

    await hostedToolBeforeHandler({
      req: reqWith([{ type: 'alpha' }, { type: 'beta' }]), res, utils,
    });

    expect(res.sent.status).toBe(400);
    expect(beta.prepareCalls).toBe(0);
  });

  it('degrades instead of rejecting when the response is already committed', async () => {
    // Nothing left to set a status on, and throwing would only be swallowed by
    // pluginExecutor's per-plugin catch. Carrying on is the only honest option.
    makeTool({ type: 'alpha', cap: 2, prepareThrows: toolRequestError() });
    const res = recordingRes();
    res.headersSent = true;

    const result: any = await hostedToolBeforeHandler({ req: reqWith([{ type: 'alpha' }]), res, utils });

    expect(result).toEqual({ stop: false });
    expect(res.sent.status).toBeUndefined();
  });
});

describe('hostedTool registry — duplicate registration', () => {
  it('is a no-op when the SAME descriptor is registered twice', async () => {
    const alpha = makeTool({ type: 'alpha', cap: 2 });     // registers it once

    expect(() => registerDescriptor(alpha.descriptor)).not.toThrow();
    expect(descriptorForType('alpha')).toBe(alpha.descriptor);
    expect(descriptorForFunctionName('alpha_fn')).toBe(alpha.descriptor);
  });

  it('throws when a DIFFERENT descriptor claims a tool type already held', () => {
    const alpha = makeTool({ type: 'alpha', cap: 2 });
    const impostor: HostedToolDescriptor = { ...alpha.descriptor, functionName: 'other_fn' };

    expect(() => registerDescriptor(impostor)).toThrow(/tool type "alpha" is already registered/);
    // The first descriptor keeps both of its keys.
    expect(descriptorForType('alpha')).toBe(alpha.descriptor);
    expect(descriptorForFunctionName('other_fn')).toBeUndefined();
  });

  it('throws when a DIFFERENT descriptor claims a function name already held', () => {
    const alpha = makeTool({ type: 'alpha', cap: 2 });
    const impostor: HostedToolDescriptor = { ...alpha.descriptor, type: 'omega' };

    expect(() => registerDescriptor(impostor)).toThrow(/function name "alpha_fn" is already registered/);
    expect(descriptorForFunctionName('alpha_fn')).toBe(alpha.descriptor);
    // Both checks run BEFORE either write: a clash on the function name alone must not
    // leave the impostor's `type` half-registered behind the throw.
    expect(descriptorForType('omega')).toBeUndefined();
  });
});

// ================================================================= the streaming transport

/**
 * Collects every `res.write` payload in order. Adapted from the identically-named helper in
 * `responses-websearch-characterization.test.ts` — deliberately the same shape, so the two
 * suites' streaming harnesses stay recognisably one approach rather than two.
 */
function captureWrites(): any {
  const written: string[] = [];
  let ended = false;
  return {
    written,
    get ended() { return ended; },
    write(chunk: any) { written.push(String(chunk)); return true; },
    end(chunk?: any) { if (chunk !== undefined) written.push(String(chunk)); ended = true; return this as any; },
    setHeader() { /* no-op */ },
    getHeader() { return undefined; },
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
  } as any;
}

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }

/** An axios streaming response whose body replays `frames` as SSE blocks. */
function upstreamStream(frames: any[]): any {
  return { data: Readable.from(frames.map(f => sse(f))) };
}

/** Every frame written to `res`, parsed. No id normalisation: the fakes mint no ids. */
function streamedFrames(res: any): any[] {
  return res.written.join('')
    .split('\n\n')
    .filter((b: string) => b.length > 0)
    .map((b: string) => b.split('\n').find((l: string) => l.startsWith('data: ')))
    .filter((l: any): l is string => typeof l === 'string')
    .map((l: string) => JSON.parse(l.slice(6)));
}

/** The client's single terminal frame — written last, exactly once. */
function terminalFrame(res: any): any {
  const all = streamedFrames(res);
  return all[all.length - 1];
}

/**
 * Wait until the turn has produced the client's terminal frame, then a beat longer for any
 * straggler. Polling rather than a fixed sleep: three continuation rounds is several timer
 * turns more than one, and a fixed budget that is generous enough for the slowest test is
 * dead time in every other.
 */
async function settleStream(res: any, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2));
    if (streamedFrames(res).some(f => f.type === 'response.completed')) break;
  }
  await new Promise(resolve => setTimeout(resolve, 10));
}

/** A streaming request the before handler will install the interceptor on. */
function streamingReq(tools: any[]): any {
  return {
    body: { stream: true, input: 'go', tools },
    __responsesUpstream: { ...UPSTREAM(), payload: { model: 'm', input: 'go', stream: true } },
    __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** The deployment's first call, as responsesController writes it: one item per call. */
function firstCallFrames(calls: any[]): any[] {
  const out: any[] = [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_1' } },
    { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1' } },
  ];
  let seq = 2;
  calls.forEach((call, index) => {
    out.push({ type: 'response.output_item.added', sequence_number: seq++, output_index: index, item: { ...call, arguments: '' } });
    out.push({ type: 'response.function_call_arguments.done', sequence_number: seq++, output_index: index, arguments: call.arguments });
    out.push({ type: 'response.output_item.done', sequence_number: seq++, output_index: index, item: call });
  });
  out.push({
    type: 'response.completed', sequence_number: seq,
    response: { id: 'resp_1', status: 'completed', output: calls, usage: { input_tokens: 10, output_tokens: 2 } },
  });
  return out;
}

/** A continuation round that asks for one more hosted-tool call. */
function continuationCallFrames(respId: string, call: any): any[] {
  return [
    { type: 'response.created', sequence_number: 0, response: { id: respId } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.done', sequence_number: 2, output_index: 0, arguments: call.arguments },
    { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: call },
    {
      type: 'response.completed', sequence_number: 4,
      response: { id: respId, status: 'completed', output: [call], usage: { input_tokens: 5, output_tokens: 1 } },
    },
  ];
}

/** The continuation round where the model finally answers. */
function continuationAnswerFrames(respId: string): any[] {
  return [
    { type: 'response.created', sequence_number: 0, response: { id: respId } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...FINAL_MSG, content: [] } },
    { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: FINAL_MSG },
    {
      type: 'response.completed', sequence_number: 3,
      response: { id: respId, status: 'completed', output: [FINAL_MSG], usage: { input_tokens: 5, output_tokens: 1 } },
    },
  ];
}

/**
 * The streaming twins of the per-descriptor cap tests above.
 *
 * The interceptor does NOT share the after handler's cap code. It keeps its own
 * `callsRunByType` (engine.ts, interceptor scope) and its own `performCall`, which reads
 * `descriptor.maxCallsPerRequest()` per call and sets the turn-wide `capReached` when a call
 * finds no budget. Mutating that Map to a single global key leaves all 129 tests in the nine
 * existing web_search streaming/characterization suites green, because one descriptor cannot
 * tell a per-type counter from a global one. These tests are what closes that.
 *
 * NO TWIN FOR "STRANDED CALLS ARE DROPPED". That behaviour has no streaming counterpart, by
 * design rather than by omission: the after handler can drop a call because its client-facing
 * items have not been emitted yet, whereas the interceptor has already suppressed the raw
 * function_call's frames by the time the cap is consulted, so a dropped call would leave Codex
 * with a hosted-tool call carrying no output_item events at all — the exact leak the
 * interceptor exists to prevent. `performCall` therefore answers an over-cap call with a
 * `failed` result and emits its items, and the test below asserts precisely that asymmetry.
 */
describe('hostedTool engine — per-descriptor caps on the STREAMING transport', () => {
  it('lets one tool keep spending its budget across later streaming rounds after another has exhausted its own', async () => {
    // Caps 1 and 3 — different numbers. alpha is exhausted by the first call; beta then
    // spends its remaining two in continuation rounds of its own. A global counter would
    // reach 3 partway through and strand beta's last call.
    const alpha = makeTool({ type: 'alpha', cap: 1 });
    const beta = makeTool({ type: 'beta', cap: 3 });

    const res = captureWrites();
    const req = streamingReq([{ type: 'alpha' }, { type: 'beta' }]);
    mockPost
      .mockResolvedValueOnce(upstreamStream(continuationCallFrames('resp_2', fc('beta', 'c_b2', 'b2'))))
      .mockResolvedValueOnce(upstreamStream(continuationCallFrames('resp_3', fc('beta', 'c_b3', 'b3'))))
      .mockResolvedValueOnce(upstreamStream(continuationAnswerFrames('resp_4')));

    await hostedToolBeforeHandler({ req, res, utils });
    for (const frame of firstCallFrames([fc('alpha', 'c_a1', 'a1'), fc('beta', 'c_b1', 'b1')])) {
      res.write(sse(frame));
    }
    await settleStream(res);

    // Three continuation calls: alpha running out on the first one stopped nothing.
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(execLog).toEqual(['alpha:c_a1', 'beta:c_b1', 'beta:c_b2', 'beta:c_b3']);
    expect(alpha.executed).toHaveLength(1);              // its own cap of 1
    expect(beta.executed).toHaveLength(3);               // its own cap of 3, two of them AFTER
    // Every call really did run on the streaming path, with its own prepare() result.
    expect(beta.executed.every(e => e.isStreaming)).toBe(true);
    expect(beta.executed.every(e => e.prepared === beta.preparedValue)).toBe(true);

    // ONE terminal frame for the whole turn, naming every round's items in order.
    const events = streamedFrames(res);
    expect(events.filter(e => e.type === 'response.completed')).toHaveLength(1);
    const terminal = terminalFrame(res);
    expect(terminal.response.output).toEqual([
      callItem('alpha', 'c_a1', 'a1'),
      callItem('beta', 'c_b1', 'b1'),
      callItem('beta', 'c_b2', 'b2'),
      callItem('beta', 'c_b3', 'b3'),
      FINAL_MSG,
    ]);
    // No raw function_call survives, in a frame or in the final output array.
    expect(events.map(e => e.item).filter(Boolean).some((i: any) => i.type === 'function_call')).toBe(false);
    expect(terminal.response.output.some((i: any) => i.type === 'function_call')).toBe(false);
    // Usage summed across all four deployment calls: 10 + 5 + 5 + 5, 2 + 1 + 1 + 1. None of
    // these frames carry `input_tokens_details` (T10 — see the dedicated describe block
    // below for the discriminating streaming case).
    expect(terminal.response.usage).toEqual({
      input_tokens: 25,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      total_tokens: 30,
    });
  });

  it('gives each tool its own budget within ONE streaming round', async () => {
    // Four calls in a single turn: one alpha (cap 1, exactly spent) and three beta (cap 3,
    // exactly spent). Every one is within its OWN budget, so nothing is capped and the round
    // is continued. Counted against a single shared budget the fourth call would be refused,
    // `capReached` would block the continuation, and no POST would happen at all.
    const alpha = makeTool({ type: 'alpha', cap: 1 });
    const beta = makeTool({ type: 'beta', cap: 3 });

    const res = captureWrites();
    const req = streamingReq([{ type: 'alpha' }, { type: 'beta' }]);
    mockPost.mockResolvedValue(upstreamStream(continuationAnswerFrames('resp_2')));

    await hostedToolBeforeHandler({ req, res, utils });
    for (const frame of firstCallFrames([
      fc('alpha', 'c_a1', 'a1'), fc('beta', 'c_b1', 'b1'), fc('beta', 'c_b2', 'b2'), fc('beta', 'c_b3', 'b3'),
    ])) {
      res.write(sse(frame));
    }
    await settleStream(res);

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(execLog).toEqual(['alpha:c_a1', 'beta:c_b1', 'beta:c_b2', 'beta:c_b3']);
    expect(alpha.executed).toHaveLength(1);
    expect(beta.executed).toHaveLength(3);

    const terminal = terminalFrame(res);
    // Every call completed — not one was refused for budget — and the model answered.
    expect(terminal.response.output).toEqual([
      callItem('alpha', 'c_a1', 'a1'),
      callItem('beta', 'c_b1', 'b1'),
      callItem('beta', 'c_b2', 'b2'),
      callItem('beta', 'c_b3', 'b3'),
      FINAL_MSG,
    ]);
    expect(terminal.response.output.every((i: any) => i.status !== 'failed')).toBe(true);
    // A continued round emits no result dumps: the model's own answer is coming.
    expect(streamedFrames(res).some(e => e.type === 'response.output_text.delta')).toBe(false);
  });

  it('lets ONE tool over its own cap block the whole streaming turn, including a tool that still had budget', async () => {
    // alpha is asked for two calls against a cap of 1; beta has 2 of its 3 left and its call
    // DOES run. `capReached` still ends the turn: no continuation is opened, and every call
    // falls back to its result dump — the client's only view of what the tools produced.
    const alpha = makeTool({ type: 'alpha', cap: 1 });
    const beta = makeTool({ type: 'beta', cap: 3 });

    const res = captureWrites();
    const req = streamingReq([{ type: 'alpha' }, { type: 'beta' }]);
    mockPost.mockResolvedValue(upstreamStream(continuationAnswerFrames('resp_2')));

    await hostedToolBeforeHandler({ req, res, utils });
    // Emission order puts beta between alpha's two calls, so "the overflowing tool" is not
    // simply "the last call".
    for (const frame of firstCallFrames([
      fc('alpha', 'c_a1', 'a1'), fc('beta', 'c_b1', 'b1'), fc('alpha', 'c_a2', 'a2'),
    ])) {
      res.write(sse(frame));
    }
    await settleStream(res);

    // An upstream context IS available — only the exhausted alpha budget stops the turn.
    expect(req.__responsesUpstream.url).toBeTruthy();
    expect(mockPost).not.toHaveBeenCalled();
    // beta ran — it was within budget — so what is blocked is the CONTINUATION, not the call.
    expect(execLog).toEqual(['alpha:c_a1', 'beta:c_b1']);
    expect(beta.executed.map(e => e.callId)).toEqual(['c_b1']);
    expect(alpha.executed.map(e => e.callId)).toEqual(['c_a1']);

    const terminal = terminalFrame(res);
    expect(terminal.type).toBe('response.completed');
    // THE ASYMMETRY WITH THE AFTER HANDLER: the over-cap call is rendered as a `failed` call
    // item, never dropped. Its raw frames were already suppressed, so dropping it here would
    // leave Codex with a call that has no output_item events at all.
    expect(terminal.response.output).toEqual([
      callItem('alpha', 'c_a1', 'a1'),
      msgItem('alpha', 'c_a1', 'a1'),
      callItem('beta', 'c_b1', 'b1'),
      msgItem('beta', 'c_b1', 'b1'),
      callItem('alpha', 'c_a2', 'a2', 'failed'),
      msgItem('alpha', 'c_a2', 'a2', 'failed'),
    ]);
    expect(terminal.response.output.filter((i: any) => i.type === 'alpha_call').map((i: any) => i.status))
      .toEqual(['completed', 'failed']);
    expect(terminal.response.output.filter((i: any) => i.type === 'beta_call').map((i: any) => i.status))
      .toEqual(['completed']);
    expect(terminal.response.output.some((i: any) => i.type === 'function_call')).toBe(false);

    // Every item named in the terminal frame really was announced by its own events — the
    // fallback dump is the client's only view of the results, so it must reach the wire.
    const events = streamedFrames(res);
    const announced = events.filter(e => e.type === 'response.output_item.done').map(e => e.item.id);
    expect(announced).toEqual(terminal.response.output.map((i: any) => i.id));
  });
});

/**
 * Task 2 fix round 1. `performCall`'s cap branch (engine.ts ~:1125) started passing
 * `'cap_reached'` through `failedResult`, but nothing in this suite could observe it: the
 * per-descriptor cap tests above drive `makeTool()`, whose `renderOutput` hardcodes
 * `{ error: 'unavailable' }` regardless of `r.error`.
 *
 * Worse than a blind assertion: `renderOutput` is never even CALLED for a call `performCall`
 * capped. `capReached` blocks the continuation for the rest of the turn, and `renderOutput`
 * is only ever invoked when POSTing one (engine.ts ~:1555, ~:2301) — so a capped call's
 * result reaches the client exclusively through `renderCallItem`/`renderResultMessage`, the
 * `msgItem` dump the test above already asserts on. Verified empirically: a spy dropped into
 * `makeTool()`'s `renderOutput` and left driving the "lets ONE tool over its own cap..." test
 * above logs zero calls for the failed item. So the fix this test needs is not "make
 * `renderOutput` echo `r.error`" (there is nothing here for it to echo TO) — it is
 * `renderResultMessage`, the hook this branch actually reaches.
 *
 * A DEDICATED descriptor, not a change to `makeTool()`'s shared `renderResultMessage`, on
 * purpose: that hook is reused by ~60 call sites in this file, including the two
 * non-streaming "overflowing tool" tests above, whose failed items go through a DIFFERENT,
 * still-uncoded `failedResult(call)` site (the after handler's own admission logic, not
 * `performCall`'s) and would need updating in lockstep with any shared-text-format change
 * for no reason connected to what this test is proving. A standalone descriptor sidesteps
 * that risk entirely rather than widening a helper several other assertions still depend on.
 */
describe('hostedTool engine — the streaming cap branch names WHY (Task 2 fix round 1)', () => {
  it("performCall's cap branch (engine.ts ~1125) passes 'cap_reached' through to what the client actually sees", async () => {
    registerDescriptor({
      type: 'gamma',
      functionName: 'gamma_fn',
      rewriteTool: () => ({
        type: 'function', name: 'gamma_fn', description: 'synthetic gamma',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      }),
      prepare: async () => ({}),
      parseCall: (callId: string, rawArguments: string): ParsedCall => {
        let args: any = {};
        try { args = JSON.parse(rawArguments); } catch { /* malformed args are not this test's concern */ }
        return { callId, rawArguments, args };
      },
      execute: async (call: ParsedCall): Promise<ToolExecResult> => {
        execLog.push(`gamma:${call.callId}`);
        return { call, status: 'completed', payload: { echo: call.args?.q } };
      },
      renderOutput: (r: ToolExecResult) => ({
        type: 'function_call_output',
        call_id: r.call.callId,
        output: JSON.stringify(r.status === 'completed' ? r.payload : { error: r.error }),
      }),
      renderCallItem: (r: ToolExecResult) => ({
        type: 'gamma_call', id: `gamma_item_${r.call.callId}`, status: r.status, query: r.call.args?.q ?? null,
      }),
      // The ONE render hook this branch actually reaches (see the block comment above) —
      // echoes r.error instead of hardcoding a message, which is the whole point.
      renderResultMessage: (r: ToolExecResult) => ({
        type: 'message', id: `gamma_msg_${r.call.callId}`, role: 'assistant', status: 'completed',
        content: [{
          type: 'output_text',
          text: r.status === 'failed' ? `gamma:failed:${r.error?.code ?? 'no_code'}` : `gamma:completed:${r.call.args?.q}`,
          annotations: [],
        }],
      }),
      maxCallsPerRequest: () => 1,
    });

    const res = captureWrites();
    const req = streamingReq([{ type: 'gamma' }]);

    await hostedToolBeforeHandler({ req, res, utils });
    // Two gamma calls against a cap of 1: the second finds no budget.
    for (const frame of firstCallFrames([fc('gamma', 'c_g1', 'g1'), fc('gamma', 'c_g2', 'g2')])) {
      res.write(sse(frame));
    }
    await settleStream(res);

    // capReached blocked the continuation entirely — this is the streaming asymmetry the
    // block comment above describes, confirmed again here rather than just asserted in prose.
    expect(mockPost).not.toHaveBeenCalled();
    expect(execLog).toEqual(['gamma:c_g1']);

    const terminal = terminalFrame(res);
    const cappedDump = terminal.response.output.find((i: any) => i.id === 'gamma_msg_c_g2');
    expect(cappedDump).toBeDefined();
    expect(cappedDump.content[0].text).toBe('gamma:failed:cap_reached');
    // The admitted call is unaffected — only the capped one carries the reason code.
    const admittedDump = terminal.response.output.find((i: any) => i.id === 'gamma_msg_c_g1');
    expect(admittedDump.content[0].text).toBe('gamma:completed:g1');
  });
});

/**
 * replay-miss-no-reexecution design, Task 2, fix round 1. Review found a FOURTH, distinct cap
 * implementation nothing in the suite drove: the BEFORE-handler's own pending-call drain
 * (engine.ts, the `callsRunByType` loop bounded by `MAX_PENDING_CALLS_PER_TURN`, immediately
 * after the replay rewrite). Before Task 2, a replayed cache miss was wire-indistinguishable
 * from a genuinely-pending `function_call` to `findPendingHostedToolCall`, so the replay-miss
 * tests that Task 2 removed exercised this cap incidentally, as a side effect of testing
 * something else. Task 2 made a miss pair with its output inside the rewrite itself, before
 * the drain ever runs, so those tests could no longer have exercised what their names claimed
 * — but deleting them also left this branch with no coverage at all, even though it is still
 * fully reachable: codex defaults `parallel_tool_calls` to true, so the model can itself emit
 * more calls of one tool in a single turn than that tool's `maxCallsPerRequest()` allows,
 * landing here as genuinely-pending `function_call` items with no `function_call_output` yet.
 *
 * Placed here, not in `hosted-tool-replay-wiring.test.ts`: that file is about the REPLAY
 * rewrite (cache hits/misses becoming pairs before the drain runs); this is the drain itself,
 * on calls that were never replayed at all, so it belongs with the engine's other
 * cap-implementation tests above.
 *
 * A DEDICATED descriptor, not `makeTool()`, for the same reason as the streaming cap-branch
 * block above: `makeTool()`'s shared `renderOutput` hardcodes `{ error: 'unavailable' }` and
 * would never show `cap_reached` even if this loop set it correctly — and this loop, unlike
 * `performCall`'s streaming branch, pushes `renderOutput`'s own return straight onto
 * `body.input` (engine.ts, `if (Array.isArray(body.input)) body.input.push(descriptor
 * .renderOutput(result))`), so `renderOutput` is the ONLY hook this test needs.
 */
describe('hostedTool engine — the before-handler drain enforces its OWN cap on genuinely-pending calls', () => {
  it('more pending calls of one tool than its cap allows: only the cap executes live, the rest come back cap_reached, every call still paired', async () => {
    registerDescriptor({
      type: 'epsilon',
      functionName: 'epsilon_fn',
      rewriteTool: () => ({
        type: 'function', name: 'epsilon_fn', description: 'synthetic epsilon',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      }),
      prepare: async () => ({}),
      parseCall: (callId: string, rawArguments: string): ParsedCall => {
        let args: any = {};
        try { args = JSON.parse(rawArguments); } catch { /* not this test's concern */ }
        return { callId, rawArguments, args };
      },
      execute: async (call: ParsedCall): Promise<ToolExecResult> => {
        execLog.push(`epsilon:${call.callId}`);
        return { call, status: 'completed', payload: { echo: call.args?.q } };
      },
      // Echoes r.error instead of a hardcoded string — the whole point, same as gamma above.
      renderOutput: (r: ToolExecResult) => ({
        type: 'function_call_output',
        call_id: r.call.callId,
        output: JSON.stringify(r.status === 'completed' ? { results: r.payload } : { error: r.error }),
      }),
      renderCallItem: (r: ToolExecResult) => ({
        type: 'epsilon_call', id: `epsilon_item_${r.call.callId}`, status: r.status, query: r.call.args?.q ?? null,
      }),
      renderResultMessage: () => null,
      maxCallsPerRequest: () => 3,
    });

    // 4 genuinely-pending function_call items — the model's own parallel tool calls this
    // turn, NOT replayed history — none paired with a function_call_output yet. Mirrors the
    // reviewer's own repro numbers: cap 3, 4 pending, 3 execute, 1 comes back cap_reached.
    const body: any = {
      tools: [{ type: 'epsilon' }],
      stream: false,
      input: ['a', 'b', 'c', 'd'].map(s => ({
        type: 'function_call', id: `fc_${s}`, call_id: `call_${s}`, name: 'epsilon_fn',
        arguments: JSON.stringify({ q: s }),
      })),
    };
    const req: any = { body };

    await hostedToolBeforeHandler({ req, res: {} as any, utils });

    // Only the cap's worth ran live.
    expect(execLog.filter(e => e.startsWith('epsilon:'))).toHaveLength(3);

    // Every call still ends up paired with an output — the invariant Task 2 strengthened
    // matters here as much as the count.
    const calls = body.input.filter((i: any) => i.type === 'function_call');
    const outputs = body.input.filter((i: any) => i.type === 'function_call_output');
    expect(calls).toHaveLength(4);
    expect(outputs).toHaveLength(4);
    const outputCallIds = new Set(outputs.map((o: any) => o.call_id));
    expect(calls.every((c: any) => outputCallIds.has(c.call_id))).toBe(true);

    // The split: 3 completed, 1 cap_reached — never a silent drop, never an empty result set
    // mistaken for a real answer.
    const parsed = outputs.map((o: any) => JSON.parse(o.output));
    expect(parsed.filter((p: any) => p.results)).toHaveLength(3);
    const capped = parsed.filter((p: any) => p.error?.code === 'cap_reached');
    expect(capped).toHaveLength(1);
  });
});

/**
 * The streaming twin of the T10 describe block above: `writeFinalTerminal`'s own
 * `accumulatedUsage`/`noteUsage` merge (engine.ts, the SSE terminal-frame path) had the exact
 * same last-round-spread defect as the non-streaming after handler's merge, just reached
 * through `noteUsage` instead of the continuation loop. Same numbers, same discriminating
 * property: every asserted field's sum differs from every individual round's own value.
 */
describe('hostedTool engine — merged usage across continuation rounds, STREAMING transport (T10)', () => {
  it('sums the cache breakdown across rounds and recomputes total_tokens on the terminal frame', async () => {
    makeTool({ type: 'alpha', cap: 3 });
    const res = captureWrites();
    const req = streamingReq([{ type: 'alpha' }]);
    const callA2 = fc('alpha', 'c_a2', 'a2');

    mockPost
      .mockResolvedValueOnce(upstreamStream([
        { type: 'response.created', sequence_number: 0, response: { id: 'resp_2' } },
        { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...callA2, arguments: '' } },
        { type: 'response.function_call_arguments.done', sequence_number: 2, output_index: 0, arguments: callA2.arguments },
        { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: callA2 },
        {
          type: 'response.completed', sequence_number: 4,
          response: {
            id: 'resp_2', status: 'completed', output: [callA2],
            // Deliberately detail-less: contributes 0 to both summed cache fields.
            usage: { input_tokens: 80, output_tokens: 6 },
          },
        },
      ]))
      .mockResolvedValueOnce(upstreamStream([
        { type: 'response.created', sequence_number: 0, response: { id: 'resp_3' } },
        { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...FINAL_MSG, content: [] } },
        { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: FINAL_MSG },
        {
          type: 'response.completed', sequence_number: 3,
          response: {
            id: 'resp_3', status: 'completed', output: [FINAL_MSG],
            // REAL field name — proves the fix reads it, not just the legacy fallback below.
            usage: {
              input_tokens: 120, output_tokens: 9,
              input_tokens_details: { cached_tokens: 15, cache_write_tokens: 3 },
              total_tokens: 129,
            },
          },
        },
      ]));

    await hostedToolBeforeHandler({ req, res, utils });
    const callA1 = fc('alpha', 'c_a1', 'a1');
    const firstRoundFrames = [
      { type: 'response.created', sequence_number: 0, response: { id: 'resp_1' } },
      { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1' } },
      { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { ...callA1, arguments: '' } },
      { type: 'response.function_call_arguments.done', sequence_number: 3, output_index: 0, arguments: callA1.arguments },
      { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: callA1 },
      {
        type: 'response.completed', sequence_number: 5,
        response: {
          id: 'resp_1', status: 'completed', output: [callA1],
          // LEGACY field name — a replayed history or a lagging upstream. Backward-compat
          // fallback must still count it (paired with resp_3's real name above: before the
          // fix this sum was 2, legacy-only; now it is 5).
          usage: {
            input_tokens: 50, output_tokens: 5,
            input_tokens_details: { cached_tokens: 10, cache_creation_tokens: 2 },
          },
        },
      },
    ];
    for (const frame of firstRoundFrames) res.write(sse(frame));
    await settleStream(res);

    const terminal = terminalFrame(res);
    expect(terminal.response.usage).toEqual({
      input_tokens: 250,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 25, cache_write_tokens: 5 },
      total_tokens: 270,
    });
  });
});

describe('hostedTool engine — continuation payload builder', () => {
  it('uses buildContinuationPayload when the upstream supplies one', async () => {
    makeTool({ type: 'alpha', cap: 3 });
    const req = afterReq({
      upstream: {
        ...UPSTREAM(),
        payload: { config: { modules: {} }, messages_history: [] },
        buildContinuationPayload: (history: any[]) => ({
          config: { modules: {} }, messages_history: history, __marker: 'orchestration',
        }),
      },
    });
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    await hostedToolAfterHandler({
      req, res: {} as any, utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    const body: any = (mockPost.mock.calls[0] as any[])[1];
    expect(body.__marker).toBe('orchestration');
    expect(Array.isArray(body.messages_history)).toBe(true);
    expect(body).not.toHaveProperty('input');   // the Responses shape must not leak
  });

  it('falls back to the Responses shape when no builder is supplied', async () => {
    makeTool({ type: 'alpha', cap: 3 });
    const req = afterReq();
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    await hostedToolAfterHandler({
      req, res: {} as any, utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    const body: any = (mockPost.mock.calls[0] as any[])[1];
    expect(Array.isArray(body.input)).toBe(true);
  });
});

// ============================================== the continuation REPLY, over orchestration

/**
 * The response side of an orchestration continuation, on both transports.
 *
 * The request side (`buildContinuationPayload`, above) was wired first and alone: the reply
 * was still handled as if it were Responses-shaped. Streaming, that meant every
 * `data: {"final_result":{"choices":[{"delta":…}]}}` block — no `type`, no `output_index` —
 * fell through the engine's frame pipeline to `emitRaw`, writing raw chat deltas into the
 * client's Responses stream. Non-streaming, the raw orchestration envelope REPLACED the
 * translated response object, so the client's body became `{choices:[…]}` and the round
 * billed zero because `usage.input_tokens` is not a field orchestration has.
 *
 * These fixtures use the REAL translators the controller stashes — importing them rather
 * than faking the hook — so a change to either translator's output shape is caught here and
 * not only in its own unit suite.
 */
const ORCH_MODEL = 'anthropic--claude-4.8-opus';

const ORCH_UPSTREAM = () => ({
  url: 'https://sap.example/v2/completion',
  headers: { Authorization: 'Bearer t' },
  timeoutMs: 5000,
  payload: { config: { modules: {} }, messages_history: [] },
  buildContinuationPayload: (history: any[]) => ({
    config: { modules: {} }, messages_history: history,
  }),
  translateContinuationResponse: (envelope: any) => translateOrchestrationResponse(envelope, {
    model: ORCH_MODEL, responseId: 'resp_orch',
  }),
  createContinuationStreamTranslator: () => createOrchestrationBlockTranslator({
    model: ORCH_MODEL, responseId: 'resp_orch',
  }),
});

/** An axios streaming response carrying orchestration's own wire format, `[DONE]` included. */
function orchestrationStream(chunks: any[]): any {
  return {
    data: Readable.from([
      ...chunks.map(c => `data: ${JSON.stringify(c)}\n\n`),
      'data: [DONE]\n\n',
    ]),
  };
}

describe('hostedTool engine — continuation replies from orchestration', () => {
  it('translates a blocking orchestration reply back into a Responses object, and bills it', async () => {
    makeTool({ type: 'alpha', cap: 3 });
    const req = afterReq({ upstream: ORCH_UPSTREAM() });
    mockPost.mockResolvedValue({
      data: {
        final_result: {
          choices: [{ message: { role: 'assistant', content: 'the model answered' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        },
      },
    });

    const out: any = await hostedToolAfterHandler({
      req, res: {} as any, utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    // A Responses object, not the orchestration envelope the POST actually returned.
    expect(out).not.toHaveProperty('choices');
    expect(out.object).toBe('response');
    expect(out.output.map((i: any) => i.type)).toEqual(['alpha_call', 'message']);
    expect(out.output[1].content[0].text).toBe('the model answered');

    // Billed, not zeroed: `usage.input_tokens` does not exist on an orchestration
    // envelope, so before the hook every continuation round added exactly nothing.
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 7, output_tokens: 3, cache_creation_tokens: 0, cache_read_tokens: 0,
    });
    // Summed across both calls: 10+7, 2+3. Cache breakdown sums to zero on both fields (T10)
    // — the orchestration round has no cache activity — and `total_tokens` recomputes to 22
    // rather than carrying the translated round's own 10.
    expect(out.usage).toEqual({
      input_tokens: 17,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      total_tokens: 22,
    });
  });

  it('bills a continuation round over a cached prefix at the full-rate remainder, not the whole translated total (T4b)', async () => {
    // SAP's raw envelope is EXCLUSIVE: prompt_tokens 14 flat, cached_tokens 21292 separate —
    // the live-measured shape `recordOrchestrationUsage`'s own doc comment cites. Once
    // `translateContinuationResponse` normalizes it to OpenAI-INCLUSIVE for the engine,
    // input_tokens becomes 14 + 21292 = 21306. Before this fix, `noteUsage`'s hand-rolled
    // `acc.input_tokens += usage.input_tokens` billed that whole 21306 at full rate; the
    // fix (`noteExtraUsage`) subtracts the round's own cache-read count back out.
    makeTool({ type: 'alpha', cap: 3 });
    const req = afterReq({ upstream: ORCH_UPSTREAM() });
    mockPost.mockResolvedValue({
      data: {
        final_result: {
          choices: [{ message: { role: 'assistant', content: 'answered from cache' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 14, completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: 21292, cache_creation_tokens: 0 },
          },
        },
      },
    });

    await hostedToolAfterHandler({
      req, res: {} as any, utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 14, output_tokens: 8, cache_creation_tokens: 0, cache_read_tokens: 21292,
    });
  });

  it('translates a streaming orchestration reply into Responses frames the client can read', async () => {
    makeTool({ type: 'alpha', cap: 3 });
    const res = captureWrites();
    const req = streamingReq([{ type: 'alpha' }]);
    req.__responsesUpstream = ORCH_UPSTREAM();
    mockPost.mockResolvedValue(orchestrationStream([
      { final_result: { choices: [{ delta: { content: 'the model ' } }] } },
      { final_result: { choices: [{ delta: { content: 'answered' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } } },
    ]));

    await hostedToolBeforeHandler({ req, res, utils });
    for (const frame of firstCallFrames([fc('alpha', 'c_a1', 'a1')])) res.write(sse(frame));
    await settleStream(res);

    // Not one orchestration chunk reached the wire verbatim.
    expect(res.written.join('')).not.toContain('final_result');
    const frames = streamedFrames(res);
    expect(frames.every(f => typeof f.type === 'string' && f.type.startsWith('response.'))).toBe(true);

    // The answer arrived as Responses text deltas, in order and complete.
    expect(frames.filter(f => f.type === 'response.output_text.delta').map(f => f.delta).join(''))
      .toBe('the model answered');

    // The round is closed by the translator, not by a terminal orchestration never sends.
    const terminal = terminalFrame(res);
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.output.map((i: any) => i.type)).toEqual(['alpha_call', 'message']);
    expect(terminal.response.output[1].content[0].text).toBe('the model answered');
    expect(terminal.response.usage).toMatchObject({ input_tokens: 15, output_tokens: 3 });   // 10+5, 2+1
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 5, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0,
    });
  });

  it("hands the builder a RELAXED tool_choice, so 'required' does not re-force every round", async () => {
    // relaxForcedToolChoice was reached only by the fallback branch, so an orchestration
    // turn re-forced `required` on every continuation and burnt to the cap — the exact
    // live failure that function was introduced to fix, reintroduced by the bridge.
    // The decision is the engine's (it needs descriptorForType); the builder owns shape.
    makeTool({ type: 'alpha', cap: 3 });
    const seen: any[] = [];
    const upstream = {
      ...ORCH_UPSTREAM(),
      toolChoice: 'required',
      buildContinuationPayload: (history: any[], opts?: any) => {
        seen.push(opts);
        return { config: { modules: {} }, messages_history: history };
      },
    };
    const req = afterReq({ upstream });
    mockPost.mockResolvedValue({
      data: { final_result: { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] } },
    });

    await hostedToolAfterHandler({
      req, res: {} as any, utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    expect(seen).toEqual([{ toolChoice: 'auto' }]);
    // The client's own stash is untouched — only the outbound decision is relaxed.
    expect(upstream.toolChoice).toBe('required');
  });

  it("leaves a tool_choice that cannot loop exactly as the client sent it", async () => {
    makeTool({ type: 'alpha', cap: 3 });
    const seen: any[] = [];
    const req = afterReq({
      upstream: {
        ...ORCH_UPSTREAM(),
        toolChoice: { type: 'function', name: 'client_fn' },
        buildContinuationPayload: (history: any[], opts?: any) => {
          seen.push(opts);
          return { config: { modules: {} }, messages_history: history };
        },
      },
    });
    mockPost.mockResolvedValue({
      data: { final_result: { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] } },
    });

    await hostedToolAfterHandler({
      req, res: {} as any, utils,
      upstreamResponse: firstTurn([fc('alpha', 'c_a1', 'a1')]),
    });

    expect(seen).toEqual([{ toolChoice: { type: 'function', name: 'client_fn' } }]);
  });

  it('leaves a Responses-shaped upstream untouched — the native path keeps its old behaviour', async () => {
    // The same streaming turn with no response-side hooks: the engine's own pipeline
    // reads the frames directly, exactly as it did before the hooks existed.
    makeTool({ type: 'alpha', cap: 3 });
    const res = captureWrites();
    const req = streamingReq([{ type: 'alpha' }]);
    mockPost.mockResolvedValue(upstreamStream(continuationAnswerFrames('resp_2')));

    await hostedToolBeforeHandler({ req, res, utils });
    for (const frame of firstCallFrames([fc('alpha', 'c_a1', 'a1')])) res.write(sse(frame));
    await settleStream(res);

    const terminal = terminalFrame(res);
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.output).toEqual([callItem('alpha', 'c_a1', 'a1'), FINAL_MSG]);
  });
});
