/**
 * Encryption of stored AWS secret access keys (AwsCredentials.secretAccessKey), shared by the
 * admin service (create, rotate, display) and the validation service (signing keys).
 */
import crypto from 'crypto';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

const FALLBACK_ENCRYPTION_KEY = 'default-dev-key-not-for-production-use-12345';
/** The value services/admin/.env.sample ships: as public as the fallback. */
const SAMPLE_ENCRYPTION_KEY = 'deadbeef'.repeat(8);

/**
 * Encryption key for AWS secrets (in production, use proper key management like AWS KMS)
 */
function getEncryptionKey(): string {
  // In production, use environment variable or key management service
  return process.env.AWS_SECRET_ENCRYPTION_KEY || FALLBACK_ENCRYPTION_KEY;
}

/** Docker and Kyma set NODE_ENV=production; the other deploy targets are deployed installs too. */
const DEPLOYED_TARGETS = ['docker', 'xsuaa', 'btp', 'xsa'];

/**
 * At startup: a deployed install whose AWS_SECRET_ENCRYPTION_KEY is unset (the built-in fallback) or the
 * .env.sample value encrypts stored AWS secrets with a publicly known key. It keeps starting (existing
 * installs keep working) and says so loudly; local development and tests stay quiet. The key is never printed.
 * True when it warned.
 */
export function warnIfAwsSecretKeyIsPubliclyKnown(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => logger.warn('admin-service', message)
): boolean {
  const deployed = env.NODE_ENV === 'production' || DEPLOYED_TARGETS.includes(env.DEPLOY_TARGET ?? '');
  const key = env.AWS_SECRET_ENCRYPTION_KEY;
  if (!deployed || (key && key !== SAMPLE_ENCRYPTION_KEY)) return false;
  warn('SECURITY WARNING: AWS_SECRET_ENCRYPTION_KEY is unset or the .env.sample value, so stored AWS secret access keys '
    + 'are encrypted with a publicly known key. Set AWS_SECRET_ENCRYPTION_KEY to a generated value (for example '
    + '`openssl rand -hex 32`) and re-enter the stored AWS secret access keys afterwards: those encrypted with the old '
    + 'key cannot be decrypted with the new one.');
  return true;
}

// scryptSync blocks for tens of milliseconds; the AES key depends only on the encryption key.
const derivedKeys = new Map<string, Buffer>();

function getAesKey(): Buffer {
  const encryptionKey = getEncryptionKey();
  let key = derivedKeys.get(encryptionKey);
  if (!key) {
    key = crypto.scryptSync(encryptionKey, 'salt', 32);
    derivedKeys.set(encryptionKey, key);
  }
  return key;
}

/**
 * Encrypt secret access key for database storage
 */
export function encryptSecret(secret: string): string {
  try {
    const key = getAesKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(secret, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    logger.error('admin-service', 'Error encrypting secret', error as Error);
    throw new Error('Failed to encrypt secret');
  }
}

/**
 * The key and iv crypto.createCipher('aes-256-cbc', password) derived for the legacy format: OpenSSL's
 * EVP_BytesToKey with MD5, one iteration and no salt. Node 22 removed createCipher and createDecipher.
 */
function legacyKeyAndIv(password: string): { key: Buffer; iv: Buffer } {
  const pass = Buffer.from(password, 'utf8');
  const blocks: Buffer[] = [];
  let previous: Buffer = Buffer.alloc(0);
  while (blocks.length * 16 < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, pass])).digest();
    blocks.push(previous);
  }
  const material = Buffer.concat(blocks);
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

/**
 * Decrypt secret access key from database storage
 */
export function decryptSecret(encryptedSecret: string): string | null {
  try {
    const parts = encryptedSecret.split(':');
    if (parts.length === 2) {
      // New format: iv:encrypted
      const iv = Buffer.from(parts[0], 'hex');
      const encryptedData = parts[1];
      const key = getAesKey();
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } else {
      // Handle legacy encryption format
      const { key, iv } = legacyKeyAndIv(getEncryptionKey());
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encryptedSecret, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }
  } catch (error) {
    logger.error('admin-service', 'Error decrypting secret', error as Error);
    return null;
  }
}
