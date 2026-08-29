import { join } from 'path';
import * as crypto from 'crypto';

// Node's built-in crypto exports are non-configurable, so jest.spyOn(crypto, 'scryptSync')
// throws "Cannot redefine property". Mocking the module (wrapping the real implementation
// so behaviour is unchanged, just counted) is the way to observe call counts instead.
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, scryptSync: jest.fn(actual.scryptSync) };
});

const cds = require('@sap/cds');

import {
  setCredential, getCredential, deleteCredential, listCredentialNames,
} from '../src/siem/credentialStore';

describe('siem credential store', () => {
  const ENTITY = 'sap.llm.gateway.admin.SiemCredentials';
  // Credentials are scoped to a configuration, but this suite tests the encryption/storage
  // plumbing itself, not the scoping semantics (covered by siem-credential-scoping.test.ts) -
  // a single fixed configuration id is enough, and there is no FK constraint requiring a
  // matching ApiConfigurations row to exist.
  const CONFIG_ID = 'cred-store-test-config';

  beforeAll(async () => {
    process.env.SIEM_CREDENTIAL_KEY = 'test-encryption-key-for-siem-credentials';
    await cds.deploy(join(__dirname, '../src/db/schema')).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { DELETE } = cds.ql;
    await DELETE.from(ENTITY);
  });

  it('round-trips a value', async () => {
    await setCredential(CONFIG_ID, 'SIEM_TEST_TOKEN', 'super-secret-value', 'admin@example.invalid');
    expect(await getCredential(CONFIG_ID, 'SIEM_TEST_TOKEN')).toBe('super-secret-value');
  });

  it('never stores the plaintext', async () => {
    await setCredential(CONFIG_ID, 'SIEM_TEST_TOKEN', 'super-secret-value', 'admin@example.invalid');
    const { SELECT } = cds.ql;
    const rows = await SELECT.from(ENTITY);
    expect(JSON.stringify(rows)).not.toContain('super-secret-value');
  });

  it('uses a different salt and iv for each write', async () => {
    await setCredential(CONFIG_ID, 'SIEM_A', 'same-value', 'admin@example.invalid');
    await setCredential(CONFIG_ID, 'SIEM_B', 'same-value', 'admin@example.invalid');
    const { SELECT } = cds.ql;
    const [a, b] = await SELECT.from(ENTITY).orderBy('name');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('returns null rather than throwing when the ciphertext is tampered with', async () => {
    await setCredential(CONFIG_ID, 'SIEM_TEST_TOKEN', 'super-secret-value', 'admin@example.invalid');
    const { UPDATE } = cds.ql;
    await UPDATE(ENTITY).set({ ciphertext: 'deadbeef' }).where({ name: 'SIEM_TEST_TOKEN' });
    expect(await getCredential(CONFIG_ID, 'SIEM_TEST_TOKEN')).toBeNull();
  });

  it('overwrites rather than duplicating on repeated set', async () => {
    await setCredential(CONFIG_ID, 'SIEM_TEST_TOKEN', 'first', 'admin@example.invalid');
    await setCredential(CONFIG_ID, 'SIEM_TEST_TOKEN', 'second', 'admin@example.invalid');
    expect(await getCredential(CONFIG_ID, 'SIEM_TEST_TOKEN')).toBe('second');
    expect(await cds.ql.SELECT.from(ENTITY)).toHaveLength(1);
  });

  it('deletes and lists', async () => {
    await setCredential(CONFIG_ID, 'SIEM_TEST_TOKEN', 'v', 'admin@example.invalid');
    expect(await listCredentialNames(CONFIG_ID)).toEqual([
      expect.objectContaining({ name: 'SIEM_TEST_TOKEN' }),
    ]);
    await deleteCredential(CONFIG_ID, 'SIEM_TEST_TOKEN');
    expect(await listCredentialNames(CONFIG_ID)).toEqual([]);
    expect(await getCredential(CONFIG_ID, 'SIEM_TEST_TOKEN')).toBeNull();
  });

  it('returns null for an unknown name', async () => {
    expect(await getCredential(CONFIG_ID, 'SIEM_NOT_THERE')).toBeNull();
  });

  describe('carried fixes from Task 1 review', () => {
    it('caches the derived key so repeated reads do not re-run scrypt', async () => {
      await setCredential(CONFIG_ID, 'SIEM_CACHE_TEST', 'value', 'admin@example.invalid');
      const scryptMock = crypto.scryptSync as jest.Mock;
      scryptMock.mockClear();

      // The write above already derived and cached a key for this record's salt, so
      // reads against the same (unchanged) row must hit the cache, not scrypt again.
      await getCredential(CONFIG_ID, 'SIEM_CACHE_TEST');
      await getCredential(CONFIG_ID, 'SIEM_CACHE_TEST');
      await getCredential(CONFIG_ID, 'SIEM_CACHE_TEST');
      expect(scryptMock).not.toHaveBeenCalled();
    });

    it('does not serve a stale derived key after the master key changes', async () => {
      await setCredential(CONFIG_ID, 'SIEM_ROTATE_TEST', 'v1', 'admin@example.invalid');
      // Populate the cache for this record's salt under the original master key.
      expect(await getCredential(CONFIG_ID, 'SIEM_ROTATE_TEST')).toBe('v1');

      process.env.SIEM_CREDENTIAL_KEY = 'a-different-test-encryption-key';
      try {
        // A cache keyed only by salt (ignoring the master key) would still return the key
        // derived under the old master key and decrypt successfully here - which would mask
        // the rotation instead of forcing re-entry, as the security assessment requires.
        expect(await getCredential(CONFIG_ID, 'SIEM_ROTATE_TEST')).toBeNull();
      } finally {
        process.env.SIEM_CREDENTIAL_KEY = 'test-encryption-key-for-siem-credentials';
      }
    });

    it('gives an uninformative hint for a short secret', async () => {
      await setCredential(CONFIG_ID, 'SIEM_SHORT_HINT', 'abcdefghi', 'admin@example.invalid'); // 9 chars
      const [row] = await listCredentialNames(CONFIG_ID);
      expect(row.maskedHint).toBe('…');
    });

    it('ignores an attacker-tampered algorithm column and decrypts with the pinned algorithm', async () => {
      await setCredential(CONFIG_ID, 'SIEM_ALGO_TEST', 'value', 'admin@example.invalid');
      const { UPDATE } = cds.ql;
      await UPDATE(ENTITY).set({ algorithm: 'not-a-real-algorithm' }).where({ name: 'SIEM_ALGO_TEST' });
      expect(await getCredential(CONFIG_ID, 'SIEM_ALGO_TEST')).toBe('value');
    });
  });
});
