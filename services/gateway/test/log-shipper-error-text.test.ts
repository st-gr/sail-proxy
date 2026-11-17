/**
 * An error carrying an upstream's own text (`logText`) is stored as that logText, also where the
 * log line interpolated the error's message. The swap touches only that interpolation: a short
 * text is not hunted through the line, unrelated words stay, and a JSON-escaped copy is found.
 */
import { describe, it, expect } from '@jest/globals';
import type { LogEntry } from '@libs/logger';
import { shippedEntryOf, ShippedLogEntry } from '../src/services/logShipper';

const LOG_TEXT = 'upstream error (status 400)';
const ship = (message: string, errorMessage: string): ShippedLogEntry => shippedEntryOf({
  level: 'error', component: 'x', message, timestamp: '2026-11-12T10:00:00.000Z',
  error: { name: 'Error', message: errorMessage, logText: LOG_TEXT },
} as LogEntry, 'INFO', 1) as ShippedLogEntry;

describe('the shipper swaps an upstream text only where it was interpolated', () => {
  it('replaces the interpolated text at the end of the line', () => {
    expect(ship('Gemini request failed for m: Invalid value at Jane Roe', 'Invalid value at Jane Roe').message)
      .toBe(`Gemini request failed for m: ${LOG_TEXT}`);
  });

  it('stores a short text as its logText in the error field', () => {
    expect(ship('call failed: Bad', 'Bad').error).toBe(`Error: ${LOG_TEXT}`);
  });

  it('finds a JSON-escaped copy of the text', () => {
    const text = 'Invalid "name" for Jane Roe\nsecond line';
    const message = `Request failed: ${JSON.stringify({ upstream: text })}`;
    const shipped = ship(message, text);
    expect(shipped.message).not.toContain('Jane Roe');
    expect(shipped.message).toContain(LOG_TEXT);
  });

  it('replaces every occurrence of a text of 12 characters or more', () => {
    const text = 'request rejected by policy';
    expect(ship(`A ${text} earlier; now: ${text}`, text).message)
      .toBe(`A ${LOG_TEXT} earlier; now: ${LOG_TEXT}`);
  });

  it('replaces a plain and a JSON-escaped copy in the same line', () => {
    const text = 'Invalid "name" for Jane Roe';
    const message = `Failed: ${text} / ${JSON.stringify({ upstream: text })}`;
    const shipped = ship(message, text);
    expect(shipped.message).not.toContain('Jane Roe');
    expect(shipped.message).toBe(`Failed: ${LOG_TEXT} / {"upstream":"${LOG_TEXT}"}`);
  });

  it('replaces a short text at the end of the line, also before closing punctuation', () => {
    expect(ship('call failed: Jane', 'Jane').message).toBe(`call failed: ${LOG_TEXT}`);
    expect(ship('call failed: Jane.', 'Jane').message).toBe(`call failed: ${LOG_TEXT}.`);
    expect(ship('call failed (Jane)', 'Jane').message).toBe(`call failed (${LOG_TEXT})`);
    expect(ship('call failed: "Jane"', 'Jane').message).toBe(`call failed: "${LOG_TEXT}"`);
    expect(ship('call failed [Jane].', 'Jane').message).toBe(`call failed [${LOG_TEXT}].`);
  });

  it('leaves a short text in the middle of the line alone', () => {
    expect(ship('Jane called twice, then failed', 'Jane').message).toBe('Jane called twice, then failed');
    expect(ship('Upstream error while streaming: error', 'error').message).toBe(`Upstream error while streaming: ${LOG_TEXT}`);
  });

  it('replaces literally: regex metacharacters and $ in the text or in the replacement', () => {
    const text = 'bad (value) [x] $& $1 .* ^end$';
    const shipped = shippedEntryOf({
      level: 'error', component: 'x', message: `One ${text}, two ${text}`, timestamp: '2026-11-12T10:00:00.000Z',
      error: { name: 'Error', message: text, logText: 'status $& 400' },
    } as LogEntry, 'INFO', 1) as ShippedLogEntry;
    expect(shipped.message).toBe('One status $& 400, two status $& 400');
    const short = shippedEntryOf({
      level: 'error', component: 'x', message: 'failed: $1.', timestamp: '2026-11-12T10:00:00.000Z',
      error: { name: 'Error', message: '$1', logText: 'a$&b' },
    } as LogEntry, 'INFO', 1) as ShippedLogEntry;
    expect(short.message).toBe('failed: a$&b.');
  });
});
