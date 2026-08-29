import * as crypto from 'crypto';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();
const ENTITY = 'sap.llm.gateway.admin.SiemCredentials';
const ALGORITHM = 'aes-256-gcm';

export interface CredentialMetadata {
  name: string;
  updatedAt?: string;
  updatedBy?: string;
  maskedHint?: string;
}

/**
 * Thrown when SIEM_CREDENTIAL_KEY is absent, so a caller can tell "this deployment is not
 * configured for credential storage" apart from "the write failed" and say which it was.
 * Every credential Set fails this way on a stack that never had the variable wired in, and a
 * generic 'Failed to store the credential' names no cause for the operator to act on. Carries
 * the NAME of the missing variable only - never a key value, absent or otherwise.
 */
export class MissingCredentialKeyError extends Error {
  constructor() {
    super('SIEM_CREDENTIAL_KEY is not set; refusing to encrypt with a default key');
    this.name = 'MissingCredentialKeyError';
  }
}

/**
 * The master key. Deliberately read at call time rather than cached at module load so a
 * rotated key takes effect without a restart, matching how the sinks resolve their own
 * secrets. Throws rather than falling back to a default: a silent default would encrypt
 * production credentials under a guessable key.
 */
function getMasterKey(): string {
  const key = process.env.SIEM_CREDENTIAL_KEY;
  if (!key) {
    throw new MissingCredentialKeyError();
  }
  return key;
}

/**
 * scryptSync measured at 27.3ms/call - paid on every setCredential/getCredential and
 * blocking the event loop while it runs. The salt is per-record and random (see deriveKey
 * below), so it never repeats across records, but the same record's salt is stable until
 * that record is rewritten - which makes it a safe cache key: a refresh that reads N stored
 * credentials repeatedly re-derives the same N keys unless this is cached.
 *
 * Keyed by (salt, master key) so a rotated SIEM_CREDENTIAL_KEY can never serve a key derived
 * under the old master key: cachedMasterKey is checked on every call, and any mismatch
 * (including the value changing, or being unset then reset) drops the whole cache before the
 * lookup, forcing a fresh derivation under the current key.
 */
const derivedKeyCache = new Map<string, Buffer>();
let cachedMasterKey: string | undefined;

/** A per-write random salt - never a constant. See the note in the plan's Global Constraints. */
function deriveKey(salt: Buffer): Buffer {
  const masterKey = getMasterKey();
  if (masterKey !== cachedMasterKey) {
    derivedKeyCache.clear();
    cachedMasterKey = masterKey;
  }

  const saltHex = salt.toString('hex');
  const cached = derivedKeyCache.get(saltHex);
  if (cached) return cached;

  const derived = crypto.scryptSync(masterKey, salt, 32);
  derivedKeyCache.set(saltHex, derived);
  return derived;
}

/**
 * 'abcd…wxyz' - enough for an admin to recognise which value is stored, useless to an
 * attacker. The format reveals up to 8 characters (4 + 4), so it only kicks in once the
 * value is long enough that those 8 characters are at most half of it; anything shorter
 * gets an uninformative hint instead of handing over most (or all) of a short secret.
 */
function maskHint(value: string): string {
  if (value.length < 16) return '…';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export async function setCredential(
  configurationId: string, name: string, value: string, actor: string,
): Promise<void> {
  const { SELECT, INSERT, UPDATE } = cds.ql;
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(salt), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  const row = {
    configuration_ID: configurationId,
    name,
    ciphertext,
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    authTag,
    algorithm: ALGORITHM,
    maskedHint: maskHint(value),
    modifiedBy: actor,
  };

  const existing = await SELECT.one.from(ENTITY).where({ configuration_ID: configurationId, name });
  if (existing) {
    await UPDATE(ENTITY).set(row).where({ configuration_ID: configurationId, name });
  } else {
    await INSERT.into(ENTITY).entries(row);
  }
  // The NAME only. Never the value.
  logger.info('SiemCredentialStore', `Stored credential '${name}' for configuration ${configurationId}`);
}

/**
 * Returns null - never logs the value - when the row is absent, the master key is wrong, or
 * the ciphertext has been tampered with. GCM's auth tag makes the last case detectable, which
 * CBC could not do.
 *
 * Only decrypt failures are swallowed into null. A DB failure while reading the row is a
 * different thing from "this credential is absent" and is deliberately NOT caught here - it
 * propagates so a caller like secretResolver's refresh() can tell "no credential" apart from
 * "could not find out right now" and keep serving its last-known value instead of treating a
 * transient outage as every credential having been deleted.
 */
export async function getCredential(configurationId: string, name: string): Promise<string | null> {
  const { SELECT } = cds.ql;
  const row = await SELECT.one.from(ENTITY).where({ configuration_ID: configurationId, name });
  if (!row) return null;

  try {
    // Pinned to the constant, never row.algorithm: the DB row is attacker-controlled if the
    // DB is, and createDecipheriv's first argument must not come from untrusted input.
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      deriveKey(Buffer.from(row.salt, 'hex')),
      Buffer.from(row.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(row.authTag, 'hex'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'hex')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch (error) {
    logger.error(
      'SiemCredentialStore',
      `Failed to decrypt credential '${name}'; treating it as unset`,
      error as Error,
    );
    return null;
  }
}

export async function deleteCredential(configurationId: string, name: string): Promise<void> {
  const { DELETE } = cds.ql;
  await DELETE.from(ENTITY).where({ configuration_ID: configurationId, name });
  logger.info('SiemCredentialStore', `Deleted credential '${name}' for configuration ${configurationId}`);
}

/** Metadata only - no ciphertext, no plaintext. This is what the UI is allowed to see. */
export async function listCredentialNames(configurationId: string): Promise<CredentialMetadata[]> {
  const { SELECT } = cds.ql;
  const rows = await SELECT.from(ENTITY)
    .columns('name', 'modifiedAt', 'modifiedBy', 'maskedHint')
    .where({ configuration_ID: configurationId });
  return rows.map((r: Record<string, string>) => ({
    name: r.name,
    updatedAt: r.modifiedAt,
    updatedBy: r.modifiedBy,
    maskedHint: r.maskedHint,
  }));
}

/**
 * Copies every credential of one configuration to another, re-encrypting each with a fresh
 * salt and IV. Used when a configuration is duplicated: without this the duplicate activates
 * with no credentials and every sink fails authentication.
 */
export async function copyCredentials(
  fromConfigurationId: string, toConfigurationId: string, actor: string,
): Promise<void> {
  for (const { name } of await listCredentialNames(fromConfigurationId)) {
    const value = await getCredential(fromConfigurationId, name);
    if (value !== null) await setCredential(toConfigurationId, name, value, actor);
  }
}
