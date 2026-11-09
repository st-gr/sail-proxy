/**
 * The AES key for stored AWS secrets comes from scryptSync (N=16384, about 30 ms, blocking).
 * It depends only on AWS_SECRET_ENCRYPTION_KEY, so it is derived once per key value, not on
 * every decrypt (every signing-key request from the gateway decrypts a secret).
 *
 * @see ../../../src/utils/awsSecretCrypto.ts
 */
import crypto from 'crypto';
import { encryptSecret, decryptSecret, warnIfAwsSecretKeyIsPubliclyKnown } from '../../../src/utils/awsSecretCrypto';

describe('awsSecretCrypto key derivation', () => {
  const originalKey = process.env.AWS_SECRET_ENCRYPTION_KEY;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalKey === undefined) delete process.env.AWS_SECRET_ENCRYPTION_KEY;
    else process.env.AWS_SECRET_ENCRYPTION_KEY = originalKey;
  });

  it('derives the AES key once for repeated encrypts and decrypts under the same key', () => {
    process.env.AWS_SECRET_ENCRYPTION_KEY = 'memo-test-key-one-0123456789abcdef';
    const scrypt = jest.spyOn(crypto, 'scryptSync');

    const stored = encryptSecret('example-secret-value');
    expect(decryptSecret(stored)).toBe('example-secret-value');
    expect(decryptSecret(stored)).toBe('example-secret-value');

    expect(scrypt).toHaveBeenCalledTimes(1);
  });

  it('derives a new key when AWS_SECRET_ENCRYPTION_KEY changes', () => {
    process.env.AWS_SECRET_ENCRYPTION_KEY = 'memo-test-key-two-0123456789abcdef';
    const stored = encryptSecret('example-secret-value');

    process.env.AWS_SECRET_ENCRYPTION_KEY = 'memo-test-key-three-0123456789abcd';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(decryptSecret(stored)).not.toBe('example-secret-value');

    process.env.AWS_SECRET_ENCRYPTION_KEY = 'memo-test-key-two-0123456789abcdef';
    expect(decryptSecret(stored)).toBe('example-secret-value');
  });
});

describe('the startup warning for a publicly known AWS secret encryption key', () => {
  const SAMPLE_KEY = 'deadbeef'.repeat(8); // services/admin/.env.sample
  const GENERATED = crypto.randomBytes(32).toString('hex');
  const check = (env: Record<string, string | undefined>) => {
    const warn = jest.fn();
    const warned = warnIfAwsSecretKeyIsPubliclyKnown(env as NodeJS.ProcessEnv, warn);
    return { warned, warn };
  };

  it.each([
    ['NODE_ENV=production', { NODE_ENV: 'production' }],
    ['DEPLOY_TARGET=docker', { DEPLOY_TARGET: 'docker' }],
    ['DEPLOY_TARGET=xsuaa', { NODE_ENV: 'development', DEPLOY_TARGET: 'xsuaa' }],
    ['DEPLOY_TARGET=btp', { DEPLOY_TARGET: 'btp' }],
    ['DEPLOY_TARGET=xsa', { DEPLOY_TARGET: 'xsa' }],
  ])('a deployed install (%s) without a key of its own is warned once, loudly, without the key', (_label, env) => {
    for (const key of [undefined, '', SAMPLE_KEY]) {
      const { warned, warn } = check({ ...env, AWS_SECRET_ENCRYPTION_KEY: key });
      expect(warned).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      const text = String(warn.mock.calls[0][0]);
      expect(text).toMatch(/AWS_SECRET_ENCRYPTION_KEY/);
      expect(text).toMatch(/publicly known/);
      expect(text).not.toContain('default-dev-key');
      expect(text).not.toContain(SAMPLE_KEY);
    }
  });

  it('says nothing for a generated key, and never prints it', () => {
    const { warned, warn } = check({ NODE_ENV: 'production', DEPLOY_TARGET: 'docker', AWS_SECRET_ENCRYPTION_KEY: GENERATED });
    expect(warned).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['tests', { NODE_ENV: 'test' }],
    ['local dev', { NODE_ENV: 'development', DEPLOY_TARGET: 'development' }],
    ['no settings at all', {}],
  ])('says nothing in %s, even without a key', (_label, env) => {
    expect(check(env).warned).toBe(false);
    expect(check({ ...env, AWS_SECRET_ENCRYPTION_KEY: SAMPLE_KEY }).warned).toBe(false);
  });
});
