/**
 * normalizeUpstreamError: reshape whatever an upstream returns into the one
 * envelope OpenAI SDKs can read.
 *
 * The bodies here are captured, not invented — the SAP shape came off a live
 * deployment rejecting codex-cli's tool list (2026-08-06), and the OpenAI shape
 * off the parity capture in docs/notes/openai-parity-capture-2026-08-06.md.
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
    expect(normalizeUpstreamError(body, 400, 'fallback')).toBe(body);
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
        details: body,
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
    expect(out.error.details).toEqual({ requestId: 'abc' });
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
