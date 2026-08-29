/**
 * credentialIdentity turns a credential value presented by a client that did NOT resolve to
 * a stored row into the fields the SIEM export pipeline is allowed to carry: a stable hash for
 * correlation, an 8-character hint for format identification, and the raw material itself —
 * gated behind each sink's own `include_credential_material` opt-in at dispatch time
 * (services/admin/src/siem/dispatcher.ts), never emitted by default.
 *
 * @see ../src/utils/credentialIdentity.ts
 */
import { describe, it, expect } from '@jest/globals';
import { credentialIdentity } from '../src/utils/credentialIdentity';

const FAKE_KEY = 'sk-test-FAKE-SECRET-VALUE-abc123XYZ';
const FAKE_ACCESS_KEY_ID = 'AKIA-NOT-REAL-EXAMPLE-00000';

describe('credentialIdentity', () => {
  it('hashes a presented credential into a SHA-256 hex digest as credentialId', () => {
    const { credentialId } = credentialIdentity(FAKE_KEY);
    expect(credentialId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same input (correlation survives across attempts)', () => {
    expect(credentialIdentity(FAKE_KEY).credentialId).toBe(credentialIdentity(FAKE_KEY).credentialId);
  });

  it('produces different hashes for different inputs', () => {
    expect(credentialIdentity(FAKE_KEY).credentialId).not.toBe(credentialIdentity(FAKE_ACCESS_KEY_ID).credentialId);
  });

  it('never lets the hash contain any substring (length >= 4) of the input', () => {
    const { credentialId } = credentialIdentity(FAKE_KEY);
    for (let len = 4; len <= FAKE_KEY.length; len++) {
      for (let start = 0; start + len <= FAKE_KEY.length; start++) {
        expect(credentialId.includes(FAKE_KEY.slice(start, start + len))).toBe(false);
      }
    }
  });

  it('returns the first 8 characters of the presented value as credentialHint', () => {
    expect(credentialIdentity(FAKE_KEY).credentialHint).toBe(FAKE_KEY.slice(0, 8));
    expect(credentialIdentity(FAKE_ACCESS_KEY_ID).credentialHint).toBe('AKIA-NOT');
  });

  it('returns the full presented value as credentialMaterial for the opt-in export path', () => {
    expect(credentialIdentity(FAKE_KEY).credentialMaterial).toBe(FAKE_KEY);
  });

  it('passes short literal sentinels through unhashed, with no hint or material', () => {
    expect(credentialIdentity('missing')).toEqual({ credentialId: 'missing' });
    expect(credentialIdentity('unknown')).toEqual({ credentialId: 'unknown' });
  });
});
