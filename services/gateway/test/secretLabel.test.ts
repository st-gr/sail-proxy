/**
 * secretLabel is the one shared helper every auth-layer log site now uses to
 * turn a raw credential into something safe to print. These tests pin down
 * the three properties every call site depends on: stability (so log lines
 * stay correlatable), non-reversibility, and "never contains the input".
 *
 * @see ../src/utils/secretLabel.ts
 */
import { describe, it, expect } from '@jest/globals';
import { secretLabel } from '../src/utils/secretLabel';

const FAKE_KEY = 'sk-test-FAKE-SECRET-VALUE-abc123XYZ';
const FAKE_ACCESS_KEY_ID = 'AKIAFAKEEXAMPLE00000';

describe('secretLabel', () => {
  it('never contains any substring (length >= 4) of the input', () => {
    const label = secretLabel(FAKE_KEY);
    for (let len = 4; len <= FAKE_KEY.length; len++) {
      for (let start = 0; start + len <= FAKE_KEY.length; start++) {
        const chunk = FAKE_KEY.slice(start, start + len);
        expect(label.includes(chunk)).toBe(false);
      }
    }
  });

  it('is stable for the same input', () => {
    expect(secretLabel(FAKE_KEY)).toBe(secretLabel(FAKE_KEY));
    expect(secretLabel(FAKE_ACCESS_KEY_ID)).toBe(secretLabel(FAKE_ACCESS_KEY_ID));
  });

  it('produces different labels for different inputs', () => {
    expect(secretLabel(FAKE_KEY)).not.toBe(secretLabel(FAKE_ACCESS_KEY_ID));
    expect(secretLabel(FAKE_KEY)).not.toBe(secretLabel(FAKE_KEY + 'x'));
  });

  it('returns a short fixed-length hex string, not a length-preserving encoding', () => {
    const label = secretLabel(FAKE_KEY);
    expect(label).toMatch(/^[0-9a-f]{8}$/);
    // A hex-encoding (reversible) of the input would be far longer than 8 chars
    // for any non-trivial secret; confirm we produce a hash, not an encoding.
    expect(Buffer.from(FAKE_KEY, 'utf8').toString('hex')).not.toBe(label);
  });

  it('does not depend on input length for its output length', () => {
    expect(secretLabel('a').length).toBe(secretLabel(FAKE_KEY).length);
  });
});
