/**
 * A request's masking allow-list names what must not be masked, typically people. Its patterns
 * stay out of the stored log: the WARN names the entry's index and the error's name, the pattern
 * goes to the console only. And as a class: a RegExp SyntaxError quotes its pattern
 * ("Invalid regular expression: /<pattern>/: <reason>"); the shipper leaves the pattern out of
 * the stored message and error. The messages are made here, so the test follows Node's wording.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { LogEntry } from '@libs/logger';
import { compileAllowlist } from '../src/pluginSupport/pseudonymization/detectors/allowlist';
import { shippedEntryOf, startLogShipper, ShippedLogEntry } from '../src/services/logShipper';

const MARKER = 'CONTENT-MARKER-of-Jane-Roe';
const regexpError = (source: string, flags?: string): Error => {
  try {
    new RegExp(source, flags);
  } catch (error) {
    return error as Error;
  }
  throw new Error('the pattern compiled');
};
const ship = (message: string, error?: Error): ShippedLogEntry => shippedEntryOf({
  level: 'warn', component: 'x', message, timestamp: '2026-11-12T10:00:00.000Z',
  ...(error ? { error: { name: error.name, message: error.message } } : {}),
} as LogEntry, 'INFO', 1) as ShippedLogEntry;

describe('the quoted pattern of a RegExp error is not stored', () => {
  it.each([
    ['an unterminated class', `^(?:${MARKER}[)$`, undefined],
    ['nothing to repeat', `*${MARKER}`, undefined],
    ['with flags', `${MARKER}(`, 'u'],
  ])('%s', (_name, source, flags) => {
    const error = regexpError(source, flags);
    expect(error.message).toContain(MARKER);
    const shipped = ship(`Ignoring a pattern: ${error.message}. The rest still applies.`, error);
    expect(shipped.message).not.toContain(MARKER);
    expect(shipped.message).toMatch(/^Ignoring a pattern: Invalid regular expression: .+\. The rest still applies\.$/);
    expect(shipped.error).not.toContain(MARKER);
    expect(shipped.error).toMatch(/^SyntaxError: Invalid regular expression: /);
  });

  it('a pattern with a line break, with a slash and a colon-space inside, and a plain one', () => {
    for (const source of [`^(?:Jane\nRoe[)$`, `a/b: ${MARKER}[`, `${MARKER}(`]) {
      const error = regexpError(source);
      const text = `Ignoring a pattern: ${error.message}. Then it went on.`;
      const marker = source.includes('Jane') ? 'Jane' : MARKER;
      expect(text).toContain(marker);
      const shipped = ship(text, error);
      expect(shipped.message).not.toContain(marker);
      expect(shipped.message).not.toContain('Roe');
      expect(shipped.message).toMatch(/^Ignoring a pattern: Invalid regular expression: \(pattern not stored\): .+\. Then it went on\.$/);
      expect(shipped.error).not.toContain(marker);
      expect(shipped.error).toMatch(/^SyntaxError: Invalid regular expression: \(pattern not stored\): /);
    }
  });

  it('a message with the words but not the shape stays as it is', () => {
    const message = 'Invalid regular expression in the settings: check the pattern';
    expect(ship(message).message).toBe(message);
  });

  it('a message that is not a RegExp error stays as it is', () => {
    const message = 'Request /v1/chat/completions: refused';
    expect(ship(message).message).toBe(message);
  });
});

describe("a request's allow-list patterns stay out of the stored log", () => {
  let consoleLines: string[];
  let shipped: ShippedLogEntry[];
  let stop: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleLines = [];
    shipped = [];
    for (const m of ['info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, m).mockImplementation((l: unknown) => { consoleLines.push(String(l)); });
    }
    stop = startLogShipper({ publish: async (b) => { shipped.push(...b); }, settings: () => ({ enabled: true, minLevel: 'INFO' }), warn: () => undefined });
  });
  afterEach(() => { stop(); jest.useRealTimers(); jest.restoreAllMocks(); });

  it('an invalid and an over-broad pattern: the index on record, the pattern on the console only', async () => {
    compileAllowlist({ patterns: ['ok', `${MARKER}[`, `(?:${MARKER}|.+)`] } as any);
    await jest.advanceTimersByTimeAsync(1000);
    expect(consoleLines.filter((l) => l.includes(MARKER)).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(shipped)).not.toContain(MARKER);
    expect(shipped.map((e) => e.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/pattern #1 .*SyntaxError/),
      expect.stringMatching(/pattern #2 also matches ordinary personal data/),
    ]));
  });
});
