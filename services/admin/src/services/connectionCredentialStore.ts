/**
 * Encrypted credentials of provider Connections (spec 2026-10-23 §4.1). The crypto is the SIEM
 * credential store's (src/siem/credentialStore.ts): AES-256-GCM, a scrypt-derived key under a
 * required master key with a random per-record salt, the master key read on every call so a
 * rotation needs no restart. It is copied rather than shared so the SIEM store stays untouched.
 *
 * One row per connection holds JSON {secret, sessionToken?}; what `secret` is depends on the
 * connection's auth mode (API key, Entra client secret, AWS secret access key, Bedrock API key).
 * Values are never logged: log lines name the connection id only.
 */
import * as crypto from 'crypto';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();
const ENTITY = 'sap.llm.gateway.admin.ConnectionCredentials';
const CONNECTIONS = 'sap.llm.gateway.admin.ProviderConnections';
const ALGORITHM = 'aes-256-gcm';
export const CONNECTION_KEY_ENV = 'CONNECTION_CREDENTIAL_KEY';

export interface ConnectionSecret {
  secret: string;
  sessionToken?: string;
}

/** CONNECTION_CREDENTIAL_KEY is absent: this deployment cannot store connection credentials. Names the variable only. */
export class MissingConnectionKeyError extends Error {
  constructor() {
    super(`${CONNECTION_KEY_ENV} is not set; refusing to encrypt with a default key`);
    this.name = 'MissingConnectionKeyError';
  }
}

function getMasterKey(): string {
  const key = process.env[CONNECTION_KEY_ENV];
  if (!key) throw new MissingConnectionKeyError();
  return key;
}

/** scrypt costs ~27 ms; cached per (salt, master key), dropped whole when the master key changes. */
const derivedKeyCache = new Map<string, Buffer>();
let cachedMasterKey: string | undefined;

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

/** 'abcd…wxyz' once the value is at least 16 characters, so the hint never gives away half of it. */
export function maskHint(value: string): string {
  if (value.length < 16) return '…';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export async function setConnectionCredential(connectionId: string, value: ConnectionSecret, actor: string): Promise<{ hint: string }> {
  const { SELECT, INSERT, UPDATE } = cds.ql;
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(salt), iv);
  const plain = JSON.stringify(value.sessionToken ? { secret: value.secret, sessionToken: value.sessionToken } : { secret: value.secret });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('hex');
  const row = {
    connection_ID: connectionId,
    ciphertext,
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    algorithm: ALGORITHM,
    modifiedBy: actor,
  };
  const existing = await SELECT.one.from(ENTITY).columns('ID').where({ connection_ID: connectionId });
  if (existing) await UPDATE(ENTITY).set(row).where({ ID: existing.ID });
  else await INSERT.into(ENTITY).entries(row);
  const hint = maskHint(value.secret);
  await UPDATE(CONNECTIONS).set({ credentialHint: hint, credentialUpdatedAt: new Date().toISOString() }).where({ ID: connectionId });
  logger.info('ConnectionCredentialStore', `Stored the credential of connection ${connectionId}`);
  return { hint };
}

/**
 * Null when no credential is stored, the master key is missing or wrong, or the row was tampered
 * with (GCM's tag detects it). A failed DB read is not swallowed: it propagates, so a caller can
 * tell "no credential" from "could not find out".
 */
export async function getConnectionCredential(connectionId: string): Promise<ConnectionSecret | null> {
  const { SELECT } = cds.ql;
  const row = await SELECT.one.from(ENTITY).where({ connection_ID: connectionId });
  if (!row) return null;
  try {
    // Pinned to the constant, never row.algorithm: the row is attacker-controlled if the DB is.
    const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(Buffer.from(row.salt, 'hex')), Buffer.from(row.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(row.authTag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'hex')), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain);
    if (!parsed || typeof parsed.secret !== 'string') return null;
    return typeof parsed.sessionToken === 'string' ? { secret: parsed.secret, sessionToken: parsed.sessionToken } : { secret: parsed.secret };
  } catch (error) {
    // The error name only: a decipher error carries no secret, but nothing here should risk one.
    logger.error('ConnectionCredentialStore', `Cannot decrypt the credential of connection ${connectionId} (${(error as Error)?.name}); treating it as unset`);
    return null;
  }
}

export async function deleteConnectionCredential(connectionId: string): Promise<void> {
  const { DELETE, UPDATE } = cds.ql;
  await DELETE.from(ENTITY).where({ connection_ID: connectionId });
  await UPDATE(CONNECTIONS).set({ credentialHint: null, credentialUpdatedAt: null }).where({ ID: connectionId });
  logger.info('ConnectionCredentialStore', `Deleted the credential of connection ${connectionId}`);
}
