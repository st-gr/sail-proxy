/**
 * A default-catalog entitlement change affects every caller without an assignment, so the admin
 * invalidates by pattern rather than enumerating credentials. Deleting the ValKey keys is only
 * half of it: each gateway process also holds the same validations in memory (unified-cache:*),
 * and nothing in a KEYS+DEL reaches those. The pattern has to travel as a pub/sub event that the
 * subscriber dispatches to every registered cache's clearByPattern - the hook index.ts registers
 * and that, before this, had no caller at all.
 *
 * The lib has no test setup of its own (libs/cache-invalidation holds a single source file), so
 * the dispatch is pinned here, next to the gateway that owns the subscriber side.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { CacheInvalidationService, CacheInvalidationEvent, CacheService } from '@libs/cache-invalidation/cacheInvalidationService';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };

// serviceName 'gateway' is the subscriber side; no valkeyUrl, so initialize() is never needed and
// nothing in this suite opens a connection.
const gateway = () => new CacheInvalidationService({ channelName: 'cache-invalidation', enableLogging: true, serviceName: 'gateway' }, logger);

const patternEvent = (pattern: string): CacheInvalidationEvent => ({
  type: 'pattern_invalidation', pattern, reason: 'entitlement', timestamp: Date.now()
});

describe('the subscriber dispatches pattern_invalidation to clearByPattern', () => {
  let clearByCredentialId: any;
  let clearByPattern: any;

  beforeEach(() => {
    logger.warn.mockClear();
    clearByCredentialId = jest.fn<any>().mockResolvedValue(true);
    clearByPattern = jest.fn<any>().mockResolvedValue(3);
  });

  const withCaches = (...services: CacheService[]) => {
    const svc = gateway();
    services.forEach(s => svc.registerCacheService(s));
    return svc;
  };

  it('reaches every registered cache with the pattern, and not clearByCredentialId', async () => {
    const svc = withCaches({ name: 'UnifiedValidationCache', clearByCredentialId, clearByPattern });

    await svc.processInvalidationEvent(patternEvent('unified-cache:*'));

    expect(clearByPattern).toHaveBeenCalledTimes(1);
    expect(clearByPattern).toHaveBeenCalledWith('unified-cache:*');
    expect(clearByCredentialId).not.toHaveBeenCalled();
  });

  it('skips a cache without clearByPattern instead of failing the dispatch', async () => {
    const svc = withCaches(
      { name: 'NoPattern', clearByCredentialId },
      { name: 'UnifiedValidationCache', clearByCredentialId, clearByPattern }
    );

    await expect(svc.processInvalidationEvent(patternEvent('unified-cache:*'))).resolves.toBeUndefined();
    expect(clearByPattern).toHaveBeenCalledWith('unified-cache:*');
  });

  it('a throwing cache does not stop the others', async () => {
    const boom = jest.fn<any>().mockRejectedValue(new Error('cache is gone'));
    const svc = withCaches(
      { name: 'Broken', clearByCredentialId, clearByPattern: boom },
      { name: 'UnifiedValidationCache', clearByCredentialId, clearByPattern }
    );

    await expect(svc.processInvalidationEvent(patternEvent('unified-cache:*'))).resolves.toBeUndefined();
    expect(boom).toHaveBeenCalled();
    expect(clearByPattern).toHaveBeenCalledWith('unified-cache:*');
  });

  it('ignores a pattern event with no pattern rather than clearing everything', async () => {
    const svc = withCaches({ name: 'UnifiedValidationCache', clearByCredentialId, clearByPattern });

    await svc.processInvalidationEvent({ type: 'pattern_invalidation', timestamp: Date.now() } as any);

    expect(clearByPattern).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('leaves the credential path untouched', async () => {
    const svc = withCaches({ name: 'UnifiedValidationCache', clearByCredentialId, clearByPattern });

    await svc.processInvalidationEvent({ type: 'api_key_deleted', credentialId: 'sk-x', authType: 'api_key', timestamp: Date.now() });

    expect(clearByCredentialId).toHaveBeenCalledWith('sk-x', 'api_key');
    expect(clearByPattern).not.toHaveBeenCalled();
  });

  it('does nothing on the admin side - only the gateway subscribes', async () => {
    const admin = new CacheInvalidationService({ channelName: 'cache-invalidation', enableLogging: false, serviceName: 'admin' }, logger);
    // registerCacheService is a no-op outside the gateway, so drive the dispatch directly.
    await admin.processInvalidationEvent(patternEvent('unified-cache:*'));
    expect(clearByPattern).not.toHaveBeenCalled();
  });
});

describe('invalidatePattern publishes as well as deleting', () => {
  it('clears the distributed keys first, then publishes the event the subscriber dispatches', async () => {
    const admin = new CacheInvalidationService({ channelName: 'cache-invalidation', enableLogging: true, serviceName: 'admin' }, logger);
    const order: string[] = [];
    const commandClient = {
      keys: jest.fn<any>(async () => { order.push('keys'); return ['unified-cache:a', 'unified-cache:b']; }),
      del: jest.fn<any>(async () => { order.push('del'); return 2; }),
      publish: jest.fn<any>(async () => { order.push('publish'); return 1; })
    };
    (admin as any).commandClient = commandClient;
    (admin as any).isCommandConnected = true;

    const cleared = await admin.invalidatePattern('unified-cache:*', 'entitlement', 'req-1');

    expect(cleared).toBe(2);
    expect(commandClient.del).toHaveBeenCalledWith('unified-cache:a', 'unified-cache:b');
    // in-memory caches would repopulate from ValKey if the event arrived before the DEL
    expect(order).toEqual(['keys', 'del', 'publish']);

    const [channel, json] = commandClient.publish.mock.calls[0] as [string, string];
    expect(channel).toBe('cache-invalidation');
    expect(JSON.parse(json)).toEqual(expect.objectContaining({
      type: 'pattern_invalidation', pattern: 'unified-cache:*', reason: 'entitlement', requestId: 'req-1'
    }));
  });

  it('still publishes when there is nothing to delete', async () => {
    const admin = new CacheInvalidationService({ channelName: 'cache-invalidation', enableLogging: false, serviceName: 'admin' }, logger);
    const publish = jest.fn<any>(async () => 1);
    (admin as any).commandClient = { keys: jest.fn<any>(async () => []), del: jest.fn<any>(), publish };
    (admin as any).isCommandConnected = true;

    await admin.invalidatePattern('unified-cache:*', 'entitlement');

    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('a raw credential never reaches a log line, only a hash-based label', () => {
  // A realistic-looking raw API key. If any log call's arguments were serialized and this
  // string showed up, the credential leaked verbatim into whatever transport the logger feeds
  // (console, a log shipper, SIEM, etc.) - the same defect class as the branch's logger fix.
  const RAW_KEY = 'sk-fixture-9d2c7b4a1e6f0035bd88c1a9e0f7d3b2';
  const RAW_AWS_CRED = 'FIXTUREAWSACCESSKEY0042';

  const assertNoRawCredentialLogged = (raw: string) => {
    for (const call of [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.debug.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(raw);
    }
  };

  beforeEach(() => {
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.debug.mockClear();
  });

  it('invalidateApiKey logs a label, not the raw key (admin side)', async () => {
    const admin = new CacheInvalidationService({ channelName: 'cache-invalidation', enableLogging: true, serviceName: 'admin' }, logger);

    await admin.invalidateApiKey(RAW_KEY, 'disabled');

    expect(logger.info).toHaveBeenCalled();
    assertNoRawCredentialLogged(RAW_KEY);
  });

  it('invalidateAwsCredential logs a label, not the raw credential id (admin side)', async () => {
    const admin = new CacheInvalidationService({ channelName: 'cache-invalidation', enableLogging: true, serviceName: 'admin' }, logger);

    await admin.invalidateAwsCredential(RAW_AWS_CRED, 'deleted');

    expect(logger.info).toHaveBeenCalled();
    assertNoRawCredentialLogged(RAW_AWS_CRED);
  });

  it('receiving and processing a credential invalidation event never logs the raw credentialId (gateway side)', async () => {
    const svc = gateway();
    const clearByCredentialId = jest.fn<any>().mockResolvedValue(true);
    svc.registerCacheService({ name: 'UnifiedValidationCache', clearByCredentialId });

    const message = JSON.stringify({ type: 'api_key_deleted', credentialId: RAW_KEY, authType: 'api_key', timestamp: Date.now() });
    await (svc as any).handleInvalidationEvent('cache-invalidation', message);

    expect(clearByCredentialId).toHaveBeenCalledWith(RAW_KEY, 'api_key');
    assertNoRawCredentialLogged(RAW_KEY);
  });

  it('publishing a credential invalidation event never logs the raw credentialId', async () => {
    const admin = new CacheInvalidationService({ channelName: 'cache-invalidation', enableLogging: true, serviceName: 'admin' }, logger);
    (admin as any).commandClient = { publish: jest.fn<any>(async () => 1) };
    (admin as any).isCommandConnected = true;

    await (admin as any).publishInvalidationEvent({ type: 'api_key_deleted', credentialId: RAW_KEY, authType: 'api_key', timestamp: Date.now() });

    assertNoRawCredentialLogged(RAW_KEY);
  });

  it('a malformed pub/sub message still logs no raw credential, even carrying one in unparsable JSON', async () => {
    const svc = gateway();
    // Truncated JSON: still contains the raw credential as a substring, but json.parse throws
    // and the failure handler used to dump the whole message into a warn log.
    const malformed = `{"type":"api_key_deleted","credentialId":"${RAW_KEY}"`;

    await (svc as any).handleInvalidationEvent('cache-invalidation', malformed);

    expect(logger.warn).toHaveBeenCalled();
    assertNoRawCredentialLogged(RAW_KEY);
  });
});
