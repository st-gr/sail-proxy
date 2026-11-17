/**
 * The log shipper: entries of the gateway's logger are queued in memory and handed to Valkey in
 * batches on a timer. A request never waits for it: the sink only pushes to an array.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createLogger, getDefaultLogger } from '@libs/logger';
import type { LogEntry } from '@libs/logger';
import { shippedEntryOf, startLogShipper, logShippingAllowed, ShippedLogEntry } from '../src/services/logShipper';

const entry = (level: LogEntry['level'], component: string, message: string): LogEntry =>
  ({ level, component, message, timestamp: '2026-11-11T10:00:00.000Z' });

describe('shippedEntryOf', () => {
  it('drops health-check access lines, entries below the lowest stored level, and the metadata', () => {
    expect(shippedEntryOf(entry('info', 'HTTP', '10.0.0.1 - - [11/Nov/2026:10:00:00 +0000] "GET /health HTTP/1.1" 200 15 "-" "kube-probe/1.30"'), 'INFO', 1)).toBeNull();
    expect(shippedEntryOf(entry('info', 'HTTP', '10.0.0.1 - - [11/Nov/2026:10:00:00 +0000] "GET /health?probe=1 HTTP/1.1" 200 15 "-" "-"'), 'INFO', 1)).toBeNull();
    expect(shippedEntryOf(entry('debug', 'x', 'detail'), 'INFO', 1)).toBeNull();
    expect(shippedEntryOf({ ...entry('warn', 'x', 'refused'), metadata: { data: 'a body' } }, 'INFO', 7))
      .toEqual({ t: expect.any(String), seq: 7, level: 'WARN', component: 'x', message: 'refused' });
  });

  it('keeps other lines that merely mention health', () => {
    expect(shippedEntryOf(entry('info', 'HTTP', '10.0.0.1 - - [x] "GET /v1/models HTTP/1.1" 200 15 "-" "health-checker"'), 'INFO', 1)).not.toBeNull();
    expect(shippedEntryOf(entry('info', 'HTTP', '10.0.0.1 - - [x] "GET /healthy-models HTTP/1.1" 200 15 "-" "-"'), 'INFO', 1)).not.toBeNull();
    expect(shippedEntryOf(entry('warn', 'Health', 'health check of the upstream failed'), 'INFO', 1)).not.toBeNull();
  });

  it('carries the request id and the error, and takes the level case-insensitively', () => {
    const shipped = shippedEntryOf({ ...entry('error', 'x', 'failed'), requestId: 'req-1', error: { name: 'Error', message: 'boom', stack: 'Error: boom\n at x' } }, 'warn', 3);
    expect(shipped).toEqual({ t: '2026-11-11T10:00:00.000Z', seq: 3, level: 'ERROR', component: 'x', requestId: 'req-1', message: 'failed', error: 'Error: boom' });
  });

  it('cuts the message at 2,000 characters and the error at 500, and keeps line breaks inside one entry', () => {
    const shipped = shippedEntryOf({ ...entry('info', 'x', `first\nsecond ${'a'.repeat(3000)}`), error: { name: 'Error', message: 'b'.repeat(900) } }, 'INFO', 1) as ShippedLogEntry;
    expect(shipped.message).toHaveLength(2000);
    expect(shipped.message.startsWith('first\nsecond ')).toBe(true);
    expect(shipped.error).toHaveLength(500);
    expect(JSON.parse(JSON.stringify(shipped)).message).toBe(shipped.message);
  });
});

describe('logShippingAllowed', () => {
  it('is not allowed standalone, without VALKEY_URL, or with GATEWAY_LOG_SHIPPING=off', () => {
    expect(logShippingAllowed({ VALKEY_URL: 'redis://valkey:6379' }, false)).toBe(true);
    expect(logShippingAllowed({ VALKEY_URL: 'redis://valkey:6379' }, true)).toBe(false);
    expect(logShippingAllowed({}, false)).toBe(false);
    expect(logShippingAllowed({ VALKEY_URL: 'redis://valkey:6379', GATEWAY_LOG_SHIPPING: 'off' }, false)).toBe(false);
    expect(logShippingAllowed({ VALKEY_URL: 'redis://valkey:6379', GATEWAY_LOG_SHIPPING: 'on' }, false)).toBe(true);
  });
});

describe('startLogShipper', () => {
  const logger = getDefaultLogger();
  let stops: Array<() => void>;
  const start = (deps: Parameters<typeof startLogShipper>[0]) => { const stop = startLogShipper(deps); stops.push(stop); return stop; };
  const on = () => ({ enabled: true, minLevel: 'INFO' });

  beforeEach(() => {
    jest.useFakeTimers();
    stops = [];
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    stops.forEach((stop) => stop());
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('publishes at most 200 entries per batch, on the timer', async () => {
    const batches: ShippedLogEntry[][] = [];
    start({ publish: async (b) => { batches.push(b); }, settings: on, warn: jest.fn() });
    for (let i = 0; i < 450; i++) logger.info('Test', `line ${i}`);
    expect(batches).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1000);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches[0][0].message).toBe('line 0');
    const seqs = batches.flat().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(450);
  });

  it('ships nothing while the settings say disabled, and follows a change without a restart', async () => {
    const batches: ShippedLogEntry[][] = [];
    let enabled = false;
    start({ publish: async (b) => { batches.push(b); }, settings: () => ({ enabled, minLevel: 'INFO' }), warn: jest.fn() });
    logger.info('Test', 'while off');
    await jest.advanceTimersByTimeAsync(1000);
    expect(batches).toHaveLength(0);
    enabled = true;
    await jest.advanceTimersByTimeAsync(1000);
    logger.info('Test', 'while on');
    await jest.advanceTimersByTimeAsync(1000);
    expect(batches.flat().map((e) => e.message)).toEqual(['while on']);
  });

  it('a publish that never resolves delays no caller: log() returns at once and the queue stops at 5,000', async () => {
    const warn = jest.fn();
    const publish = jest.fn(() => new Promise<void>(() => undefined));
    start({ publish, settings: on, warn });
    await jest.advanceTimersByTimeAsync(1000);
    const before = process.hrtime.bigint();
    for (let i = 0; i < 6000; i++) logger.info('Test', `line ${i}`);
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
    expect(elapsedMs).toBeLessThan(2000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(1); // the first batch hangs; no second one starts
    await jest.advanceTimersByTimeAsync(60_000);
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toMatch(/dropped/);
    expect(said).toMatch(/1[0-9]{3}/); // at least 1,000 dropped: 6,000 pushed, 5,000 fit (200 already taken)
  });

  it('counts as dropped only what would have been stored: not lines below the level, not health checks', async () => {
    // Review finding 2026-11-12: the full-queue check ran before the filter, so with the queue
    // full every DEBUG line and every /health access line raised the count of lost entries.
    const warn = jest.fn();
    start({ publish: () => new Promise<void>(() => undefined), settings: on, warn });
    logger.info('Test', 'first');
    await jest.advanceTimersByTimeAsync(1000); // the first batch hangs from here on
    for (let i = 0; i < 5000; i++) logger.info('Test', `line ${i}`); // the queue is full now
    for (let i = 0; i < 300; i++) logger.debug('Test', 'below the stored level');
    for (let i = 0; i < 40; i++) logger.info('HTTP', '10.0.0.1 - - [11/Nov/2026:10:00:00 +0000] "GET /health HTTP/1.1" 200 15 "-" "kube-probe/1.30"');
    for (let i = 0; i < 7; i++) logger.info('Test', 'really lost');
    await jest.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/\b7 .*dropped|dropped.*\b7\b/);
  });

  it('keeps the entries of a failed publish for the next flush', async () => {
    const batches: ShippedLogEntry[][] = [];
    let fail = true;
    start({ publish: async (b) => { if (fail) throw new Error('down'); batches.push(b); }, settings: on, warn: jest.fn() });
    logger.info('Test', 'kept');
    await jest.advanceTimersByTimeAsync(1000);
    expect(batches).toHaveLength(0);
    fail = false;
    await jest.advanceTimersByTimeAsync(1000);
    expect(batches.flat().map((e) => e.message)).toEqual(['kept']);
  });

  it('says "entries dropped" through warn at most once a minute, with the count, and never through the logger', async () => {
    const warn = jest.fn();
    const batches: ShippedLogEntry[][] = [];
    let hang = true;
    start({ publish: (b) => hang ? new Promise<void>(() => undefined) : Promise.resolve().then(() => { batches.push(b); }), settings: on, warn });
    logger.info('Test', 'first');
    await jest.advanceTimersByTimeAsync(1000); // the first batch hangs from here on
    for (let i = 0; i < 5100; i++) logger.info('Test', `line ${i}`); // 100 do not fit
    await jest.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/100 .*dropped|dropped.*100/);
    for (let i = 0; i < 50; i++) logger.info('Test', 'more');
    await jest.advanceTimersByTimeAsync(30_000);
    expect(warn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(31_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toMatch(/50/);
    // the warning never entered the queue: nothing of it shows up in what is published
    hang = false;
    stops.pop()!();
    await jest.advanceTimersByTimeAsync(0);
    expect(batches.flat().some((e) => /dropped/i.test(e.message))).toBe(false);
  });

  it('on stop makes one last attempt at what is queued without waiting for it', async () => {
    const batches: ShippedLogEntry[][] = [];
    const stop = start({ publish: (b) => new Promise<void>(() => { batches.push(b); }), settings: on, warn: jest.fn() });
    await jest.advanceTimersByTimeAsync(1000);
    logger.info('Test', 'last words');
    expect(() => stop()).not.toThrow(); // returns although publish never resolves
    expect(batches.flat().map((e) => e.message)).toEqual(['last words']);
    logger.info('Test', 'after stop');
    await jest.advanceTimersByTimeAsync(5000);
    expect(batches.flat().map((e) => e.message)).toEqual(['last words']);
  });

  it('a rejecting publish at stop is not an unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const stop = start({ publish: () => Promise.reject(new Error('down')), settings: on, warn: jest.fn() });
      await jest.advanceTimersByTimeAsync(1000);
      logger.info('Test', 'x');
      stop();
      await jest.advanceTimersByTimeAsync(10);
      jest.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve)); // unhandled rejections surface after the microtasks, on a macrotask
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('Logger.addSink', () => {
  beforeEach(() => { jest.spyOn(console, 'info').mockImplementation(() => undefined); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('calls the sink after the console line, returns a remover, and swallows its exception', () => {
    const logger = createLogger({ enableColors: false, enableFileLogging: false });
    const order: string[] = [];
    (console.info as jest.Mock).mockImplementation(() => { order.push('console'); });
    const seen: LogEntry[] = [];
    const remove = logger.addSink((e) => { order.push('sink'); seen.push(e); });
    logger.addSink(() => { throw new Error('sink broke'); });
    expect(() => logger.info('t', 'hello')).not.toThrow();
    expect(order).toEqual(['console', 'sink']);
    expect(seen[0]).toMatchObject({ level: 'info', component: 't', message: 'hello' });
    remove();
    logger.info('t', 'again');
    expect(seen).toHaveLength(1);
  });

  it('does not call the sink for a level that is not enabled', () => {
    const logger = createLogger({ enableColors: false, enableFileLogging: false });
    const sink = jest.fn();
    logger.addSink(sink);
    logger.debug('t', 'quiet');
    expect(sink).not.toHaveBeenCalled();
  });
});
