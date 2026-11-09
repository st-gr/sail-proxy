/**
 * The last-known SAP AI Core target (spec 2026-10-25 §5): the target a gateway last installed from
 * the admin, shared in Valkey so that a gateway booting while the admin is down serves the tenant
 * the administrator chose, not the environment key (which may point at a tenant the deployment
 * moved away from).
 *
 * The value holds a client secret, so it is AES-256-GCM ciphertext only, under a key derived from
 * VALIDATION_TOKEN_SECRET: every gateway of a deployment already holds that secret (the admin
 * refuses a gateway without it) and nothing else that reads Valkey does. With a publicly known
 * secret (unset, the default, the .env.sample placeholder) the copy is not written to Valkey: it
 * would be readable by anyone who knows the default. Without Valkey the copy lives in this
 * process only, so a cold boot during an admin outage then uses the environment target.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { getDefaultLogger } from '@libs/logger';
import { isPubliclyKnownValidationTokenSecret } from '../../../../libs/aws-token-validation/validation-token-secrets';
import { sapTargetFingerprint, type SapTarget } from './sapTarget';

const logger = getDefaultLogger();

export const LAST_KNOWN_KEY = 'sail-proxy:sap-target:last-known';
const KEY_SALT = 'sail-proxy-sap-target';
const KEY_INFO = 'last-known-v1';

/** The Valkey commands used here; index.ts adapts its client. */
export interface LastKnownStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

let store: LastKnownStore | null = null;
let memory: SapTarget | null = null;
let weakSecretLogged = false;

export function setLastKnownStore(next: LastKnownStore | null): void {
  store = next;
}

function encryptionKey(): Buffer | null {
  const secret = process.env.VALIDATION_TOKEN_SECRET;
  if (!secret || isPubliclyKnownValidationTokenSecret(secret)) {
    if (!weakSecretLogged) {
      weakSecretLogged = true;
      logger.warn('SapTarget', 'VALIDATION_TOKEN_SECRET is unset or publicly known: the last-known SAP AI Core target is kept in this process only, not in Valkey');
    }
    return null;
  }
  return Buffer.from(hkdfSync('sha256', secret, KEY_SALT, KEY_INFO, 32));
}

const errorName = (error: unknown) => (error as Error)?.name ?? 'Error';

export async function saveLastKnown(t: SapTarget): Promise<void> {
  memory = t;
  if (!store) return;
  const key = encryptionKey();
  if (!key) return;
  const { version: _version, ...rest } = t;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(rest), 'utf8'), cipher.final()]);
  const value = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  try {
    await store.set(LAST_KNOWN_KEY, value);
  } catch (error) {
    logger.warn('SapTarget', `Could not write the last-known SAP AI Core target to Valkey (${errorName(error)})`);
  }
}

/** The last-known target, or null when there is none or it cannot be read with this gateway's secret. */
export async function loadLastKnown(): Promise<SapTarget | null> {
  if (!store) return memory;
  const key = encryptionKey();
  if (!key) return memory;
  let raw: string | null;
  try {
    raw = await store.get(LAST_KNOWN_KEY);
  } catch (error) {
    logger.warn('SapTarget', `Could not read the last-known SAP AI Core target from Valkey (${errorName(error)})`);
    return memory;
  }
  if (!raw) return null;
  try {
    const { iv, tag, ciphertext } = JSON.parse(raw);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
    const { fingerprint: _stored, ...inputs } = JSON.parse(plain);
    return { ...inputs, fingerprint: sapTargetFingerprint(inputs), version: 0 };
  } catch (error) {
    // A copy written under another VALIDATION_TOKEN_SECRET, or a damaged value.
    logger.warn('SapTarget', `The last-known SAP AI Core target in Valkey cannot be read (${errorName(error)}); ignoring it`);
    return null;
  }
}

/** Whether a copy exists at all, readable by this gateway or not (one GET). */
export async function hasLastKnown(): Promise<boolean> {
  if (!store) return memory !== null;
  try {
    return (await store.get(LAST_KNOWN_KEY)) !== null;
  } catch (error) {
    logger.warn('SapTarget', `Could not read the last-known SAP AI Core target from Valkey (${errorName(error)})`);
    return false;
  }
}

/** True once the copy is gone (or there is no store); false when Valkey refused the delete. */
export async function clearLastKnown(): Promise<boolean> {
  memory = null;
  if (!store) return true;
  try {
    await store.del(LAST_KNOWN_KEY);
    return true;
  } catch (error) {
    logger.warn('SapTarget', `Could not clear the last-known SAP AI Core target in Valkey (${errorName(error)})`);
    return false;
  }
}
