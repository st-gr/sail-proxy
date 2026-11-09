// Module scope: a plain script would share top-level names with other test files under ts-jest.
export {};

/**
 * The admin's client-IP derivation mirrors services/gateway/src/utils/clientIp.ts and reads
 * platform.security.trust_forwarded_for from api_config.json (mocked per case, like
 * credential-lifecycle.test.ts).
 */
const REAL_FS = jest.requireActual('fs');

function load(security: any) {
  jest.resetModules();
  jest.doMock('fs', () => ({
    ...REAL_FS,
    readFileSync: (p: string, enc?: any) =>
      String(p).endsWith('api_config.json')
        ? JSON.stringify({ api_config: { platform: { security } } })
        : REAL_FS.readFileSync(p, enc),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../../src/utils/clientIp');
}

function httpReq(headers: Record<string, string>, socketPeer = '203.0.113.9'): any {
  return { headers, ip: socketPeer, connection: { remoteAddress: socketPeer }, socket: { remoteAddress: socketPeer } };
}

describe('getClientIp with forwarded headers not trusted (shipped default)', () => {
  const ip = load({ trust_forwarded_for: false });
  it('returns the socket peer and ignores forged headers', () => {
    expect(ip.trustForwardedFor()).toBe(false);
    expect(ip.getClientIp(httpReq({ 'x-forwarded-for': '198.51.100.9', 'x-real-ip': '198.51.100.9' }))).toBe('203.0.113.9');
  });
  it('normalises an IPv4-mapped IPv6 peer and keeps a real IPv6 peer', () => {
    expect(ip.getClientIp(httpReq({}, '::ffff:203.0.113.7'))).toBe('203.0.113.7');
    expect(ip.getClientIp(httpReq({}, '::1'))).toBe('::1');
  });
  it('answers unknown without a socket', () => {
    expect(ip.getClientIp({ headers: {} })).toBe('unknown');
  });
});

describe('getClientIp with forwarded headers trusted', () => {
  const ip = load({ trust_forwarded_for: true });
  it('prefers X-Real-IP', () => {
    expect(ip.getClientIp(httpReq({ 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '10.0.0.1, 10.0.0.2' }))).toBe('198.51.100.9');
  });
  it('takes the LAST X-Forwarded-For hop, never the first', () => {
    expect(ip.getClientIp(httpReq({ 'x-forwarded-for': '10.0.0.1, 198.51.100.9' }))).toBe('198.51.100.9');
  });
  it('falls back to the peer without headers', () => {
    expect(ip.getClientIp(httpReq({}))).toBe('203.0.113.9');
  });
});

describe('clientContext', () => {
  const ip = load({});
  it('reads the Express request behind a CAP request and defaults unknown', () => {
    const req = { http: { req: httpReq({ 'user-agent': 'jest' }, '::ffff:203.0.113.7') } };
    expect(ip.clientContext(req)).toEqual({ clientIP: '203.0.113.7', userAgent: 'jest' });
    expect(ip.clientContext({})).toEqual({ clientIP: 'unknown', userAgent: 'unknown' });
  });
});
