import { describe, it, expect } from '@jest/globals';
import { CLOSE_GOING_AWAY, CLOSE_INTERNAL_ERROR, CLOSE_NORMAL, REASON_SERVER_SHUTDOWN, REASON_UPSTREAM_ERROR, isSendableCloseCode, propagatedClose } from '../../src/realtime/closeCodes';

describe('propagatedClose', () => {
  it('forwards a regular close code and reason unchanged', () => {
    expect(propagatedClose(1000, 'bye')).toEqual({ code: 1000, reason: 'bye' });
    expect(propagatedClose(4001, Buffer.from('custom'))).toEqual({ code: 4001, reason: 'custom' });
    expect(propagatedClose(1008, 'policy')).toEqual({ code: 1008, reason: 'policy' });
  });
  it('maps 1005 (no status received) to 1000', () => {
    expect(propagatedClose(1005, '')).toEqual({ code: CLOSE_NORMAL, reason: '' });
  });
  it('maps 1006 (abnormal closure) to 1011 upstream_error', () => {
    expect(propagatedClose(1006, '')).toEqual({ code: CLOSE_INTERNAL_ERROR, reason: REASON_UPSTREAM_ERROR });
  });
  it('maps codes the protocol forbids on the wire to 1011', () => {
    expect(propagatedClose(1004, 'x').code).toBe(1011);
    expect(propagatedClose(1015, 'x').code).toBe(1011);
    expect(propagatedClose(999, 'x').code).toBe(1011);
    expect(propagatedClose(5000, 'x').code).toBe(1011);
  });
  it('trims the reason to the 123-byte limit', () => {
    const { reason } = propagatedClose(1000, 'é'.repeat(100));
    expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
    expect(reason.startsWith('ééé')).toBe(true);
  });
});

describe('isSendableCloseCode', () => {
  it('accepts 1000, 1001-1003, 1007-1014 and 3000-4999', () => {
    for (const c of [1000, 1001, 1003, 1007, 1011, 1014, 3000, 4999]) expect(isSendableCloseCode(c)).toBe(true);
  });
  it('rejects 1004-1006, 1015, and anything outside 1000-4999', () => {
    for (const c of [1004, 1005, 1006, 1015, 999, 2000, 5000]) expect(isSendableCloseCode(c)).toBe(false);
  });
});

describe('the shutdown close', () => {
  it('is a sendable 1001 going-away with the reason clients are documented to see', () => {
    expect(CLOSE_GOING_AWAY).toBe(1001);
    expect(REASON_SERVER_SHUTDOWN).toBe('server_shutdown');
    expect(isSendableCloseCode(CLOSE_GOING_AWAY)).toBe(true);
    expect(propagatedClose(CLOSE_GOING_AWAY, REASON_SERVER_SHUTDOWN)).toEqual({ code: 1001, reason: 'server_shutdown' });
  });
});
