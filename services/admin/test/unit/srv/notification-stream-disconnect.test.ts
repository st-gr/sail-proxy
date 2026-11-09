/**
 * A browser that closes or reloads a cockpit tab aborts its notification stream. That is the normal
 * end of an SSE connection, not a server error: it used to be logged at ERROR with a stack trace and
 * the user id, twice per closed tab on Kyma.
 */
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => {
  const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
  return { getDefaultLogger: () => log, mockLog: log };
});
const { mockLog } = require('@libs/logger');
const { notificationStreamService } = require('../../../src/srv/notification-stream');

function connect() {
  const req = Object.assign(new EventEmitter(), { user: { id: 'user@example.org' } });
  const res = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(() => true), status: jest.fn().mockReturnThis(), json: jest.fn() };
  notificationStreamService.handleConnection(req as any, res as any);
  return req;
}

const errorWith = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

describe('notification stream disconnects', () => {
  beforeEach(() => jest.clearAllMocks());
  afterAll(() => notificationStreamService.shutdown?.());

  it.each([
    ['aborted', undefined],
    ['read ECONNRESET', 'ECONNRESET'],
    ['socket hang up', 'ECONNRESET'],
    ['write EPIPE', 'EPIPE'],
  ])('does not log a client abort (%s) as an error', (message, code) => {
    const req = connect();
    req.emit('error', errorWith(message, code));
    expect(mockLog.error).not.toHaveBeenCalled();
    expect(mockLog.debug.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')).toMatch(/closed by the client/);
  });

  it('still logs any other stream error as an error', () => {
    const req = connect();
    req.emit('error', errorWith('something else broke'));
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });
});
