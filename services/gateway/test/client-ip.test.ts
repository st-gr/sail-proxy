import { describe, it, expect } from '@jest/globals';
import { getClientIp } from '../src/utils/clientIp';

/** Minimal Express-request stand-in carrying only what getClientIp reads. */
function req(headers: Record<string, string>, socketPeer = '203.0.113.9'): any {
  return {
    headers,
    ip: socketPeer,
    connection: { remoteAddress: socketPeer },
    socket: { remoteAddress: socketPeer },
  };
}

describe('getClientIp with forwarded headers NOT trusted', () => {
  it('returns the socket peer and ignores a forged header', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '198.51.100.9' }), false)).toBe('203.0.113.9');
  });

  it('ignores a forged x-real-ip too', () => {
    expect(getClientIp(req({ 'x-real-ip': '198.51.100.9' }), false)).toBe('203.0.113.9');
  });

  // Regression test: Express derives req.ip from X-Forwarded-For whenever `trust proxy` is
  // enabled (see TRUST_PROXY_HOPS in src/index.ts), so req.ip can carry a forged value even
  // when the caller asked NOT to trust forwarded headers. getClientIp must never read req.ip
  // on this branch — only the socket peer is trustworthy here.
  it('ignores req.ip when it was forged via trust proxy, even though the socket peer differs', () => {
    const forged = {
      headers: { 'x-forwarded-for': '198.51.100.9' },
      ip: '198.51.100.9', // what Express's req.ip becomes with trust proxy on and a forged XFF
      connection: { remoteAddress: '203.0.113.9' },
      socket: { remoteAddress: '203.0.113.9' },
    };
    expect(getClientIp(forged as any, false)).toBe('203.0.113.9');
  });
});

describe('getClientIp with forwarded headers trusted', () => {
  // nginx sets X-Real-IP with proxy_set_header, which OVERWRITES rather than
  // appends, so it cannot carry a client-supplied value through the proxy.
  it('prefers x-real-ip', () => {
    expect(getClientIp(req({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' }), true))
      .toBe('203.0.113.7');
  });

  // The spoofing fix. nginx uses $proxy_add_x_forwarded_for, which APPENDS the
  // real peer to whatever the client sent, so the LAST element is the trusted
  // one and element [0] is attacker-controlled.
  it('takes the LAST x-forwarded-for element, never the first', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '198.51.100.9, 203.0.113.7' }), true))
      .toBe('203.0.113.7');
  });

  it('handles a single-element x-forwarded-for', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7' }), true)).toBe('203.0.113.7');
  });

  it('tolerates whitespace and falls back to the peer when the header is empty', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '  ' }), true)).toBe('203.0.113.9');
  });
});

describe('getClientIp always returns something usable', () => {
  it('returns unknown when nothing is available', () => {
    expect(getClientIp({ headers: {} } as any, true)).toBe('unknown');
  });
});

describe('IPv4-mapped IPv6 peers', () => {
  it('are stored as IPv4, real IPv6 stays', () => {
    expect(getClientIp(req({}, '::ffff:203.0.113.7'), false)).toBe('203.0.113.7');
    expect(getClientIp(req({}, '::1'), false)).toBe('::1');
    expect(getClientIp(req({ 'x-real-ip': '::ffff:198.51.100.9' }), true)).toBe('198.51.100.9');
  });
});
