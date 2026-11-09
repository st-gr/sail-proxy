/**
 * Signing-key providers for the SigV4 verifier (utils/sigv4Verifier.ts).
 *
 * A provider returns the day-scoped kSigning for an access key id, never the secret.
 * Keys live in process memory only; nothing here writes to Valkey or the logger.
 */
import { deriveSigningKey, signingScopesFor, SigningKeyProvider, SigningScope } from '../utils/sigv4Verifier';
import { getSecretForSignature } from './awsCredentialsService';
import { cachedSigningKey } from './awsSigningKeyCache';

/** Standalone and local-fallback path: derive the key from the local credential store's secret. */
export const localSigningKeyProvider: SigningKeyProvider = {
  async getSigningKey(accessKeyId: string, scope: SigningScope): Promise<Buffer | null> {
    const secret = await getSecretForSignature(accessKeyId);
    return secret ? deriveSigningKey(secret, scope) : null;
  }
};

/**
 * Admin path: the keys the admin returned with a validation, from process memory. On a miss
 * (a validation-cache hit, another replica's validation, a new day) the admin is asked once for
 * the scope and its bedrock variant. No key means the request is rejected, never accepted.
 */
export const adminSigningKeyProvider: SigningKeyProvider = {
  async getSigningKey(accessKeyId: string, scope: SigningScope): Promise<Buffer | null> {
    const cached = cachedSigningKey(accessKeyId, scope);
    if (cached) return cached;
    // Required lazily, as tokenBasedAwsAuth does: loading it at import builds the admin client and
    // validation-cache singletons in every module graph that imports the auth middleware.
    const { unifiedAwsCredentialValidationService } = require('./unifiedAwsCredentialValidationService');
    await unifiedAwsCredentialValidationService.fetchSigningKeys(accessKeyId, signingScopesFor(scope));
    return cachedSigningKey(accessKeyId, scope);
  }
};
