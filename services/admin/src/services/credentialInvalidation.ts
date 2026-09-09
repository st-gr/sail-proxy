/**
 * The one invalidation path for everything that changes what a validation response says about a
 * user (spec §7.2 item 3): entitlement changes, deactivation, reactivation, constraint edits.
 * Per-credential bulkInvalidate for named users; invalidatePattern('unified-cache:*') for changes
 * that affect everyone — never clearCachePattern alone, which does not reach the gateway's
 * in-process cache. Also drops the admin's own in-memory validation cache.
 */
import { getDefaultLogger } from '@libs/logger';
import { cacheInvalidationService } from './cacheInvalidationService';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

/**
 * The admin validates credentials itself and caches the result for 5-10 minutes, so clearing
 * only the gateway's cache would leave a re-validation after an entitlement change answered
 * from a stale admin-side entry. Same access path and key patterns as the API key rotation
 * handler in admin-service.ts. Never throws: an invalidation is best effort.
 */
export function clearLocalValidationCache(keys: string[], accessKeyIds: string[], everyone = false): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const validationService = require('../srv/validation-service').instance;
    if (!validationService || !validationService.cache) {
      logger.warn('CredentialInvalidation', 'validation service instance not available for local cache invalidation');
      return;
    }
    const { apiKeys, awsCredentials } = validationService.cache;
    if (everyone) { apiKeys?.clear(); awsCredentials?.clear(); return; }
    for (const key of keys) { apiKeys?.delete(`apikey:${key}`); apiKeys?.delete(`unified_apikey:${key}`); }
    for (const id of accessKeyIds) { awsCredentials?.delete(`aws:${id}`); awsCredentials?.delete(`unified_aws:${id}`); }
  } catch (e) {
    logger.warn('CredentialInvalidation', `local validation cache invalidation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Invalidate the gateway's cached validations for the users an entitlement or account change
 * affects. Returns `true` when every step succeeded (including the 'everyone' path), `false`
 * (after the warn below) when anything threw — callers that need to tell an operator their change
 * may still be honoured by a stale cached validation (e.g. deactivation) capture this.
 */
export async function invalidateForEmails(db: any, emails: string[] | 'everyone', reason: string, opts: { includeInactive?: boolean } = {}): Promise<boolean> {
  try {
    if (emails === 'everyone') {
      clearLocalValidationCache([], [], true);
      // invalidatePattern, not clearCachePattern: the latter only deletes the ValKey keys, and
      // every gateway process keeps the same validations in memory for an hour. The pattern
      // event is what reaches those in-process caches.
      await cacheInvalidationService.invalidatePattern('unified-cache:*', reason);
      return true;
    }
    if (emails.length === 0) return true;
    const { SELECT } = cds.ql;
    // Deactivation flips rows inactive BEFORE invalidating, so it asks for inactive rows too.
    const where = opts.includeInactive ? { email: { in: emails } } : { email: { in: emails }, isActive: true };
    const keys = await db.run(SELECT.from('sap.llm.gateway.admin.ApiKeys').columns('key').where(where));
    const creds = await db.run(SELECT.from('sap.llm.gateway.admin.AwsCredentials').columns('accessKeyId').where(where));
    clearLocalValidationCache(keys.filter((k: any) => k.key).map((k: any) => k.key), creds.filter((c: any) => c.accessKeyId).map((c: any) => c.accessKeyId));
    await cacheInvalidationService.bulkInvalidate([
      ...keys.filter((k: any) => k.key).map((k: any) => ({ credentialId: k.key, authType: 'api_key' as const, reason })),
      ...creds.filter((c: any) => c.accessKeyId).map((c: any) => ({ credentialId: c.accessKeyId, authType: 'aws_credential' as const, reason }))
    ]);
    return true;
  } catch (e) {
    logger.warn('CredentialInvalidation', `cache invalidation (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
