/**
 * createHeadersPreview (libs/logger) must never leak credential material.
 * The previous implementation only sanitized Authorization, and even then
 * only by truncating to a 15-char prefix — which is itself key material
 * (e.g. "Bearer <scheme+real key chars>" still exposes the scheme plus real
 * secret characters).
 *
 * This suite lives in services/gateway/test/ rather than under libs/logger
 * because libs/ has no test runner of its own; the gateway's jest config
 * already maps `@libs/*` to the shared libs and is where this file gets
 * picked up and executed by CI.
 *
 * @see ../../../libs/logger/index.ts
 */
import { describe, it, expect } from '@jest/globals';
import { createHeadersPreview } from '@libs/logger';

const FAKE_BEARER_TOKEN = 'sk-test-FAKE-SECRET-VALUE-abcdefghijklmnopqrstuvwxyz0123456789';
const FAKE_API_KEY = 'sk-test-FAKE-API-KEY-9876543210zyxwvutsrqponmlkjihgfedcba';
const FAKE_AWS_TOKEN = 'FAKE.AWS.SECURITY.TOKEN.abcdefghijklmnopqrstuvwxyz0123456789';
const FAKE_COOKIE = 'session=FAKE-SESSION-abcdefghijklmnopqrstuvwxyz0123456789';

// Every substring of length >= 8 of `secret` must not appear anywhere in `output`.
function assertNoLeak(output: string, secret: string) {
  for (let start = 0; start + 8 <= secret.length; start++) {
    const chunk = secret.slice(start, start + 8);
    expect(output.includes(chunk)).toBe(false);
  }
}

describe('createHeadersPreview', () => {
  it('returns "[No headers]" for null/undefined', () => {
    expect(createHeadersPreview(null)).toBe('[No headers]');
    expect(createHeadersPreview(undefined)).toBe('[No headers]');
  });

  it('labels a Bearer Authorization header and never leaks the raw value', () => {
    const preview = createHeadersPreview({ Authorization: `Bearer ${FAKE_BEARER_TOKEN}` });
    assertNoLeak(preview, FAKE_BEARER_TOKEN);
    // The scheme is diagnostically useful and not secret, so it survives.
    expect(preview).toContain('Bearer');
    expect(preview).toMatch(/Bearer \[redacted:[0-9a-f]{8}\]/);
  });

  it('labels a lowercase authorization header the same way', () => {
    const preview = createHeadersPreview({ authorization: `Bearer ${FAKE_BEARER_TOKEN}` });
    assertNoLeak(preview, FAKE_BEARER_TOKEN);
    expect(preview).toMatch(/Bearer \[redacted:[0-9a-f]{8}\]/);
  });

  it.each([
    ['x-api-key', FAKE_API_KEY],
    ['api-key', FAKE_API_KEY],
    ['x-amz-security-token', FAKE_AWS_TOKEN],
    ['x-amz-credential', FAKE_AWS_TOKEN],
    ['cookie', FAKE_COOKIE],
    ['set-cookie', FAKE_COOKIE],
    ['proxy-authorization', `Basic ${FAKE_API_KEY}`],
    ['x-goog-api-key', FAKE_API_KEY],
    ['x-auth-token', FAKE_API_KEY],
  ])('redacts the %s header', (headerName, secretValue) => {
    const preview = createHeadersPreview({ [headerName]: secretValue });
    assertNoLeak(preview, secretValue);
    expect(preview).toContain('[redacted:');
  });

  it('redacts headers matched by name token even if not in the exact-match list', () => {
    const preview = createHeadersPreview({ 'x-custom-session-secret': FAKE_API_KEY });
    assertNoLeak(preview, FAKE_API_KEY);
    expect(preview).toContain('[redacted:');
  });

  it('leaves non-sensitive headers untouched', () => {
    const preview = createHeadersPreview({
      'content-type': 'application/json',
      'user-agent': 'test-agent/1.0',
    });
    expect(preview).toContain('application/json');
    expect(preview).toContain('test-agent/1.0');
  });

  it('does not throw on an array-valued header (repeated headers) and redacts every element', () => {
    const values = [`Bearer ${FAKE_BEARER_TOKEN}`, `Bearer ${FAKE_API_KEY}`];
    expect(() => createHeadersPreview({ authorization: values })).not.toThrow();
    const preview = createHeadersPreview({ authorization: values });
    assertNoLeak(preview, FAKE_BEARER_TOKEN);
    assertNoLeak(preview, FAKE_API_KEY);
  });

  it('does not throw on array-valued non-sensitive headers', () => {
    expect(() => createHeadersPreview({ 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'] })).not.toThrow();
    const preview = createHeadersPreview({ 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'] });
    expect(preview).toContain('1.2.3.4');
  });

  it('does not throw on non-string sensitive header values (number, null, nested object)', () => {
    expect(() =>
      createHeadersPreview({
        'x-api-key': 12345 as any,
        cookie: null as any,
        'x-auth-token': { nested: 'FAKE-VALUE' } as any,
      })
    ).not.toThrow();
  });

  it('does not throw when a sensitive header is present with an empty value', () => {
    expect(() => createHeadersPreview({ authorization: '' })).not.toThrow();
    const preview = createHeadersPreview({ authorization: '' });
    expect(preview).not.toContain('undefined');
  });

  it('caps the overall preview at 500 characters', () => {
    const preview = createHeadersPreview({ 'x-custom': 'a'.repeat(2000) });
    expect(preview.length).toBeLessThanOrEqual(520); // 500 + "... [truncated]" suffix
  });

  // Mutation check: if the redaction for a non-Authorization sensitive header
  // (here, cookie) were reverted to a no-op, this test fails because the raw
  // cookie value would appear verbatim in the preview.
  it('mutation check: cookie header must actually be redacted, not passed through', () => {
    const preview = createHeadersPreview({ cookie: FAKE_COOKIE });
    expect(preview).not.toContain(FAKE_COOKIE);
  });
});
