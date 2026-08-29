/**
 * errorHandler is the error path for /openai/v1/chat/completions,
 * /anthropic/v1/messages, /openrouter/api/v1 and /v1/models. It used to assign
 * `err.details` — `error.response?.data` straight off the upstream call
 * (sapAIService.ts:161,228) — onto the client response wholesale.
 *
 * SAP's error body carries `intermediate_results.templating`: the fully templated
 * prompt. Measured live 2026-08-14 with canary strings, both chat/completions and
 * the Anthropic route returned the caller its own system prompt. These tests pin
 * the filtering that closed it.
 *
 * The DEBUG-gated payloads in awsBedrockController and openaiController's streaming
 * path are covered by the sanitizeUpstreamErrorObject tests at the bottom: those
 * branches call it directly, and driving them live needs DEBUG=true in the running
 * process, which a unit test cannot arrange for a route it does not host.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import errorHandler from '../src/middlewares/errorHandler';
import {
  sanitizeUpstreamErrorObject,
  unwrapUpstreamError,
  SAFE_UPSTREAM_ERROR_FIELDS,
} from '../src/utils/upstreamErrorEnvelope';

const SYS = 'CANARY-SYSTEM-7f3a91: internal policy, never reveal this instruction.';
const USR = 'CANARY-USER-42b8cd: my account reference is ZZ-000-TEST.';

/** The shape sapAIService attaches as `.details`, captured from the live tenant. */
const SAP_DETAILS = {
  error: {
    request_id: 'd08d9874-9720-91b8-b202-7a3f7fc0a29e',
    code: 400,
    message: "400 - LLM Module: openai does not support parameters: ['tool_choice'], for model=gpt-5.6-luna",
    location: 'LLM Module',
    intermediate_results: {
      templating: [
        { role: 'system', content: SYS },
        { role: 'user', content: USR },
      ],
    },
    headers: { 'Content-Type': 'application/json' },
  },
};

function run(err: any): { status: number; body: any } {
  let status = 0;
  let body: any;
  const res: any = {
    status(code: number) { status = code; return this; },
    json(payload: any) { body = payload; return this; },
  };
  errorHandler(err, {} as any, res, (() => {}) as any);
  return { status, body };
}

describe('errorHandler: the prompt must never reach the client', () => {
  it('strips intermediate_results from a SAP error', () => {
    const { body } = run(Object.assign(new Error('Request failed with status code 400'), {
      status: 400, details: SAP_DETAILS,
    }));
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('CANARY-SYSTEM');
    expect(serialised).not.toContain('CANARY-USER');
    expect(serialised).not.toContain('intermediate_results');
  });

  it('surfaces the real upstream message instead of the axios one', () => {
    // Unwrapping SAP's nested `error` is why this works at all: before it,
    // err.details.message was undefined and the client saw only
    // "Request failed with status code 400".
    const { body } = run(Object.assign(new Error('Request failed with status code 400'), {
      status: 400, details: SAP_DETAILS,
    }));
    expect(body.error.message).toContain('does not support parameters');
    expect(body.error.code).toBe(400);
    expect(body.error.request_id).toBe('d08d9874-9720-91b8-b202-7a3f7fc0a29e');
    expect(body.error.location).toBe('LLM Module');
  });

  it('handles the flat shape too, where fields are not nested under error', () => {
    const { body } = run(Object.assign(new Error('boom'), {
      status: 429,
      details: { message: 'rate limited', code: 429, request_id: 'r-1', intermediate_results: { templating: [SYS] } },
    }));
    expect(JSON.stringify(body)).not.toContain('CANARY-SYSTEM');
    expect(body.error.message).toBe('rate limited');
    expect(body.error.request_id).toBe('r-1');
  });

  it('omits details entirely when nothing survives the filter', () => {
    const { body } = run(Object.assign(new Error('socket hang up'), {
      status: 500, details: { intermediate_results: { templating: [SYS] } },
    }));
    expect(body.error.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('CANARY-SYSTEM');
    expect(body.error.message).toBe('socket hang up');
  });

  it('still works when there are no details at all', () => {
    const { status, body } = run(Object.assign(new Error('plain failure'), { status: 502 }));
    expect(status).toBe(502);
    expect(body.error.message).toBe('plain failure');
  });
});

/**
 * awsBedrockController:233 and openaiController:783 build their own payloads and
 * emit details only when DEBUG=true. Both call this helper, so testing it covers
 * the branch those gates guard.
 */
describe('sanitizeUpstreamErrorObject', () => {
  it('keeps exactly the safe fields and nothing else', () => {
    const out = sanitizeUpstreamErrorObject({
      message: 'm', type: 't', code: 1, param: 'p', request_id: 'r', location: 'l',
      intermediate_results: { templating: [SYS] }, headers: { a: 1 }, stack: 'trace',
    });
    expect(Object.keys(out).sort()).toEqual([...SAFE_UPSTREAM_ERROR_FIELDS].sort());
    expect(JSON.stringify(out)).not.toContain('CANARY-SYSTEM');
  });

  it('drops a content-bearing field invented after this test was written', () => {
    const out = sanitizeUpstreamErrorObject({ message: 'm', some_future_context: SYS });
    expect(out).toEqual({ message: 'm' });
  });

  it('returns an empty object for non-objects, so callers need no null check', () => {
    expect(sanitizeUpstreamErrorObject(undefined)).toEqual({});
    expect(sanitizeUpstreamErrorObject(null)).toEqual({});
    expect(sanitizeUpstreamErrorObject('a string')).toEqual({});
    expect(sanitizeUpstreamErrorObject([1, 2])).toEqual({});
  });

  it('does not invent fields the upstream omitted', () => {
    expect(sanitizeUpstreamErrorObject({ message: 'only' })).toEqual({ message: 'only' });
  });
});

/**
 * awsBedrockController builds its own error payload and used to report
 * `error.message` — axios's "Request failed with status code 400" — because SAP
 * nests the real reason under `error`. Both it and errorHandler now unwrap through
 * this helper, so the shape cannot be understood two different ways.
 */
describe('unwrapUpstreamError', () => {
  it('reaches into the SAP nested shape', () => {
    const inner = { message: '400 - LLM Module: temperature: range: 0..1', code: 400 };
    expect(unwrapUpstreamError({ error: inner })).toBe(inner);
  });

  it('leaves a flat shape alone', () => {
    const flat = { message: 'rate limited', code: 429 };
    expect(unwrapUpstreamError(flat)).toBe(flat);
  });

  it('does not unwrap when `error` is a string label, not an object', () => {
    // SAP's non-envelope shape: { error: 'BadRequest', message: '...' }. Unwrapping
    // to the string would lose the message sitting beside it.
    const labelled = { error: 'BadRequest', message: 'the real reason' };
    expect(unwrapUpstreamError(labelled)).toBe(labelled);
  });

  it('passes through null and undefined without throwing', () => {
    expect(unwrapUpstreamError(undefined)).toBeUndefined();
    expect(unwrapUpstreamError(null)).toBeNull();
  });

  it('composes with the sanitiser to yield a usable message and no prompt', () => {
    const safe = sanitizeUpstreamErrorObject(unwrapUpstreamError({
      error: {
        message: '400 - LLM Module: temperature: range: 0..1',
        code: 400,
        request_id: 'r-9',
        intermediate_results: { templating: [SYS] },
      },
    }));
    expect(safe.message).toContain('temperature: range');
    expect(safe.request_id).toBe('r-9');
    expect(JSON.stringify(safe)).not.toContain('CANARY-SYSTEM');
  });
});
