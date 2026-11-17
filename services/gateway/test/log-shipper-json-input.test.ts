/**
 * A JSON.parse error quotes a piece of its input ("Unexpected token 'C', "CONTENT-MA"... is not
 * valid JSON"). Where that input is model output, a tool call's arguments, a request body or an
 * upstream body, the quoted piece is conversation content. The shipper leaves that piece out of
 * the stored message and error; the console line keeps it.
 *
 * The messages are made by parsing here, so the test follows the wording of the Node version it
 * runs on.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { getDefaultLogger } from '@libs/logger';
import type { LogEntry } from '@libs/logger';
import { shippedEntryOf, startLogShipper, ShippedLogEntry } from '../src/services/logShipper';

const MARKER = 'CONTENT-MARKER-of-Jane-Roe';
const parseError = (text: string): Error => {
  try {
    JSON.parse(text);
  } catch (error) {
    return error as Error;
  }
  throw new Error('the text parsed');
};
const entry = (message: string, error?: Error): LogEntry => ({
  level: 'error', component: 'x', message, timestamp: '2026-11-12T10:00:00.000Z',
  ...(error ? { error: { name: error.name, message: error.message, stack: error.stack } } : {}),
});
const ship = (message: string, error?: Error): ShippedLogEntry => shippedEntryOf(entry(message, error), 'INFO', 1) as ShippedLogEntry;

describe('the quoted input of a JSON.parse error is not stored', () => {
  it('an unexpected token: the message and the error lose the quoted input and say a JSON input was refused', () => {
    const error = parseError(`${MARKER} and more`);
    expect(error.message).toContain(MARKER.slice(0, 5));
    const shipped = ship(`Error parsing JSON for request r1: ${error.message}`, error);
    expect(shipped.message).not.toContain(MARKER.slice(0, 5));
    expect(shipped.message.startsWith('Error parsing JSON for request r1: ')).toBe(true);
    expect(shipped.message).toContain('is not valid JSON');
    expect(shipped.error).not.toContain(MARKER.slice(0, 5));
    expect(shipped.error).toMatch(/^SyntaxError: .*is not valid JSON$/);
  });

  it('an unexpected token in a long input (the quote starts and ends with an ellipsis)', () => {
    const error = parseError(`[${'1,'.repeat(30)} ${MARKER} ${'y'.repeat(40)}]`);
    expect(error.message).toContain(MARKER.slice(0, 5));
    const shipped = ship(`Failed to parse data as JSON: ${error.message}, then more`, error);
    expect(shipped.message).not.toContain(MARKER.slice(0, 5));
    expect(shipped.message.endsWith(', then more')).toBe(true);
    expect(shipped.error).not.toContain(MARKER.slice(0, 5));
  });

  it('an unexpected quote character as the token', () => {
    const error = parseError(`'${MARKER}'`);
    const shipped = ship(error.message, error);
    expect(shipped.message).not.toContain(MARKER.slice(0, 5));
    expect(shipped.error).not.toContain(MARKER.slice(0, 5));
  });

  it('an unterminated string and an unexpected end quote nothing and stay as they are', () => {
    for (const text of [`{"a": "${MARKER}`, `{"a": "${MARKER}"`]) {
      const error = parseError(text);
      expect(error.message).not.toContain(MARKER.slice(0, 5));
      expect(ship(error.message, error)).toMatchObject({ message: error.message, error: `SyntaxError: ${error.message}` });
    }
  });

  it('a message that is not a JSON.parse error stays as it is', () => {
    const message = 'Request failed with status code 400: Unexpected token "a" is not valid here';
    const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
    expect(ship(message, error)).toMatchObject({ message, error: 'Error: connect ECONNREFUSED 127.0.0.1:443' });
  });

  describe('through the shipper', () => {
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

    it('the console line keeps the quoted input, the shipped entry does not', async () => {
      const error = parseError(`${MARKER} as model output`);
      getDefaultLogger().error('SAPAIService', `Error parsing JSON for request r1: ${error.message}`, error);
      await jest.advanceTimersByTimeAsync(1000);
      expect(consoleLines.some((l) => l.includes(MARKER.slice(0, 10)))).toBe(true);
      expect(shipped).toHaveLength(1);
      expect(JSON.stringify(shipped)).not.toContain(MARKER.slice(0, 5));
    });
  });
});
