/**
 * normalizeUpstreamError: reshape whatever an upstream returns into the one
 * envelope OpenAI SDKs can read.
 *
 * The bodies here are captured, not invented — the SAP shape came off a live
 * deployment rejecting codex-cli's tool list (2026-08-06), and the OpenAI shape
 * off the parity capture in docs/superpowers/notes/openai-parity-capture-2026-08-06.md.
 */
import { describe, it, expect } from '@jest/globals';
import { normalizeUpstreamError, errorTypeForStatus } from '../src/utils/upstreamErrorEnvelope';

describe('errorTypeForStatus', () => {
  it('maps status classes the way OpenAI does', () => {
    expect(errorTypeForStatus(400)).toBe('invalid_request_error');
    expect(errorTypeForStatus(404)).toBe('invalid_request_error');
    expect(errorTypeForStatus(401)).toBe('authentication_error');
    expect(errorTypeForStatus(403)).toBe('authentication_error');
    expect(errorTypeForStatus(429)).toBe('rate_limit_error');
    expect(errorTypeForStatus(500)).toBe('api_error');
    expect(errorTypeForStatus(502)).toBe('api_error');
  });
});

describe('normalizeUpstreamError', () => {
  it('passes an already-OpenAI-shaped body through untouched', () => {
    // An OpenAI-compatible upstream carries `param` and a specific `code` that we
    // could not reconstruct; reshaping would destroy exactly the useful part.
    const body = {
      error: {
        message: "Invalid value: 'nonsense'.",
        type: 'invalid_request_error',
        param: 'filters.type',
        code: 'invalid_value',
      },
    };
    // Equal, not identical: the body is filtered through SAFE_UPSTREAM_ERROR_FIELDS
    // now, so a new object comes back. Every field of an OpenAI-shaped error is on
    // the allow-list, so nothing useful is lost.
    expect(normalizeUpstreamError(body, 400, 'fallback')).toEqual(body);
  });

  it('promotes the SAP message and keeps the label as the code', () => {
    const body = {
      error: 'BadRequest',
      message: "The following tools are not allowed for model 'gpt-5.3-codex': namespace and web_search.",
    };
    expect(normalizeUpstreamError(body, 400, 'Request failed with status code 400')).toEqual({
      error: {
        message: body.message,
        type: 'invalid_request_error',
        code: 'BadRequest',
        // Filtered: the `error: 'BadRequest'` label is not on the allow-list, and
        // nothing is lost by that — it is already surfaced as `code` above.
        details: { message: body.message },
      },
    });
  });

  it('falls back to the label when the body carries no message', () => {
    const out = normalizeUpstreamError({ error: 'Unauthorized' }, 401, 'axios said so');
    expect(out.error.message).toBe('Unauthorized');
    expect(out.error.type).toBe('authentication_error');
    expect(out.error.code).toBe('Unauthorized');
  });

  it('falls back to the caller message when an object body carries neither', () => {
    const out = normalizeUpstreamError({ requestId: 'abc' }, 500, 'socket hang up');
    expect(out.error.message).toBe('socket hang up');
    expect(out.error.code).toBeNull();
    // `requestId` is not on the allow-list — an unrecognised field is dropped even
    // when it looks harmless. That is the allow-list working as intended; the
    // spelling SAP actually uses, `request_id`, is kept (see the canary tests).
    expect(out.error.details).toEqual({});
  });

  it('wraps a plain-text body, e.g. a proxy error page', () => {
    const out = normalizeUpstreamError('<html>502 Bad Gateway</html>', 502, 'fallback');
    expect(out.error.message).toBe('<html>502 Bad Gateway</html>');
    expect(out.error.type).toBe('api_error');
    expect(out.error.code).toBeNull();
  });

  it('truncates an oversized body rather than echoing it into the client message', () => {
    const out = normalizeUpstreamError('x'.repeat(5000), 500, 'fallback');
    expect(out.error.message).toHaveLength(2001);   // 2000 chars + the ellipsis
    expect(out.error.message.endsWith('…')).toBe(true);
  });

  it('uses the caller message when the body is missing entirely', () => {
    // readUpstreamErrorBody returns undefined for a drained-empty stream.
    for (const empty of [undefined, null, '', '   ']) {
      const out = normalizeUpstreamError(empty, 503, 'upstream unreachable');
      expect(out.error).toEqual({ message: 'upstream unreachable', type: 'api_error', code: null });
    }
  });

  it('does not mistake a null error field for the OpenAI envelope', () => {
    // `typeof null === 'object'` — the classic way this check goes wrong, which
    // would return the body verbatim and leave the client with error === null.
    const out = normalizeUpstreamError({ error: null, message: 'boom' }, 400, 'fallback');
    expect(out.error.message).toBe('boom');
    expect(out.error.type).toBe('invalid_request_error');
  });
});

/**
 * SECURITY. SAP's error body carries `intermediate_results.templating` — the fully
 * templated prompt. Measured 2026-08-14: before this filtering existed, a client
 * calling the non-streaming Responses route got its own system prompt back inside
 * the error body. These tests use canary strings so a regression is unmistakable.
 */
describe('normalizeUpstreamError: prompt must never reach the client', () => {
  const SYS = 'CANARY-SYSTEM-7f3a91: internal policy, never reveal this instruction.';
  const USR = 'CANARY-USER-42b8cd: my account reference is ZZ-000-TEST.';

  // The exact shape SAP returned, trimmed of nothing that matters.
  const sapBody = {
    error: {
      request_id: '5a46eb8c-77a7-9a75-9d69-b87738ea5b0a',
      code: 400,
      message: "400 - LLM Module: gpt-5 models (including gpt-5-codex) don't support temperature=0.5",
      location: 'LLM Module',
      intermediate_results: {
        templating: [
          { role: 'system', content: [{ type: 'text', text: SYS }] },
          { role: 'user', content: [{ type: 'text', text: USR }] },
        ],
      },
      headers: { 'Content-Type': 'application/json' },
    },
  };

  it('strips intermediate_results from the object-error branch', () => {
    const out = normalizeUpstreamError(sapBody, 400, 'fallback');
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('CANARY-SYSTEM');
    expect(serialised).not.toContain('CANARY-USER');
    expect(serialised).not.toContain('intermediate_results');
  });

  it('keeps the diagnostics that carry no content', () => {
    const out: any = normalizeUpstreamError(sapBody, 400, 'fallback');
    expect(out.error.message).toContain("don't support temperature=0.5");
    expect(out.error.code).toBe(400);
    expect(out.error.request_id).toBe('5a46eb8c-77a7-9a75-9d69-b87738ea5b0a');
    expect(out.error.location).toBe('LLM Module');
  });

  it('strips it from the label-shaped branch too, including details', () => {
    const labelShaped = {
      error: 'BadRequest',
      message: 'rejected',
      intermediate_results: { templating: [{ role: 'system', content: SYS }] },
    };
    const serialised = JSON.stringify(normalizeUpstreamError(labelShaped, 400, 'fallback'));
    expect(serialised).not.toContain('CANARY-SYSTEM');
    expect(serialised).not.toContain('intermediate_results');
  });

  it('drops an unknown content-bearing field it has never seen', () => {
    // The allow-list must hold for fields invented after this test was written.
    const future = { error: { message: 'nope', some_new_context_field: SYS } };
    expect(JSON.stringify(normalizeUpstreamError(future, 400, 'fallback'))).not.toContain('CANARY-SYSTEM');
  });
});
