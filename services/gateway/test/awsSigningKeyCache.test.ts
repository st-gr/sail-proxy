/**
 * The in-memory SigV4 signing-key cache is bounded: past MAX_SIGNING_KEYS entries the oldest
 * insert is evicted, so many access key ids and scopes within one day cannot grow it without limit.
 *
 * @see ../src/services/awsSigningKeyCache.ts
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  rememberSigningKeys,
  cachedSigningKey,
  clearSigningKeys,
  MAX_SIGNING_KEYS,
} from '../src/services/awsSigningKeyCache';

const DATE = '20260926';
const KEY_HEX = 'ab'.repeat(32);

function scope(i: number) {
  return { date: DATE, region: `region-${i}`, service: 'bedrock' };
}

describe('awsSigningKeyCache size cap', () => {
  beforeEach(() => {
    clearSigningKeys();
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 26, 12, 0, 0));
  });

  it('is capped at 10,000 entries', () => {
    expect(MAX_SIGNING_KEYS).toBe(10_000);
  });

  it('evicts the oldest entries once the cap is reached', () => {
    const keys = Array.from({ length: MAX_SIGNING_KEYS + 2 }, (_, i) => ({ ...scope(i), key: KEY_HEX }));
    rememberSigningKeys('AKIDEXAMPLE', keys);

    expect(cachedSigningKey('AKIDEXAMPLE', scope(0))).toBeNull();
    expect(cachedSigningKey('AKIDEXAMPLE', scope(1))).toBeNull();
    expect(cachedSigningKey('AKIDEXAMPLE', scope(2))).not.toBeNull();
    expect(cachedSigningKey('AKIDEXAMPLE', scope(MAX_SIGNING_KEYS + 1))).not.toBeNull();
  });

  it('evicts nothing when an existing entry is stored again at the cap', () => {
    const keys = Array.from({ length: MAX_SIGNING_KEYS }, (_, i) => ({ ...scope(i), key: KEY_HEX }));
    rememberSigningKeys('AKIDEXAMPLE', keys);
    rememberSigningKeys('AKIDEXAMPLE', [{ ...scope(5), key: KEY_HEX }]);

    expect(cachedSigningKey('AKIDEXAMPLE', scope(0))).not.toBeNull();
    expect(cachedSigningKey('AKIDEXAMPLE', scope(MAX_SIGNING_KEYS - 1))).not.toBeNull();
  });

  it('still drops entries whose scope day is more than a day old', () => {
    rememberSigningKeys('AKIDEXAMPLE', [{ ...scope(0), key: KEY_HEX }]);
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 28, 0, 0, 1));
    expect(cachedSigningKey('AKIDEXAMPLE', scope(0))).toBeNull();
  });
});
