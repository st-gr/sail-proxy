/**
 * Secrets stored before the iv:ciphertext format were written with crypto.createCipher, which
 * Node 22 removed together with createDecipher. The admin images run on Node 24, so the legacy
 * format is decrypted without them. The crypto module here is mocked to look like Node 22+.
 *
 * @see ../../../src/utils/awsSecretCrypto.ts
 */
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, createCipher: undefined, createDecipher: undefined };
});

import { decryptSecret } from '../../../src/utils/awsSecretCrypto';

// Node 20's crypto.createCipher('aes-256-cbc', <the fallback key>) of AWS's documented example
// secret: an anchor this code did not produce.
const LEGACY_FALLBACK_KEY = 'default-dev-key-not-for-production-use-12345';
const EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const LEGACY_STORED = '953eab8d6b3c93b63d3a85d05487f91bdcd7c0f1a7a8d5cab20e3a02f7e4916a3275ace3f30b3c50b1487931dca24d75';

describe('awsSecretCrypto legacy (pre-iv) format', () => {
  const originalKey = process.env.AWS_SECRET_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AWS_SECRET_ENCRYPTION_KEY;
    else process.env.AWS_SECRET_ENCRYPTION_KEY = originalKey;
  });

  it('decrypts a legacy secret on a Node without createDecipher', () => {
    process.env.AWS_SECRET_ENCRYPTION_KEY = LEGACY_FALLBACK_KEY;
    expect(decryptSecret(LEGACY_STORED)).toBe(EXAMPLE_SECRET);
  });

  it('answers null for a legacy secret under another key', () => {
    process.env.AWS_SECRET_ENCRYPTION_KEY = 'another-key-0123456789abcdef0123456789';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(decryptSecret(LEGACY_STORED)).not.toBe(EXAMPLE_SECRET);
  });
});
