/**
 * The admin path end to end, with the admin service client mocked: the gateway's validation
 * request names the SigV4 scopes it needs (the Authorization header's scope plus the
 * bedrock <-> bedrock-runtime variant), the admin answers with day-scoped signing keys, and
 * tokenBasedAwsAuth verifies the signature with them. The keys live in process memory only;
 * the unified validation cache (Valkey tier faked here, encryption off so the payload is
 * inspectable) never holds them.
 *
 * Also pins the leftovers of 12a: the local validation path carries no secret, and a result
 * validated locally during an admin outage keeps using the local key provider when it comes
 * back from the cache.
 *
 * The signed request is the botocore-signed Bedrock request of tokenBasedAwsAuth-sigv4-
 * verification.test.ts (botocore 1.34.98, AWS's documented example secret, 2026-09-26T12:00:00Z).
 *
 * @see ../src/services/awsSigningKeyProviders.ts
 * @see ../src/services/awsSigningKeyCache.ts
 * @see ../src/services/unifiedAwsCredentialValidationService.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

process.env.METADATA_ENCRYPTION_KEY = process.env.METADATA_ENCRYPTION_KEY || 'test-encryption-key-32-chars-minimum-length-required-for-validation';
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLog }));

const mockEmitFailedAuth = jest.fn<any>();
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (...args: any[]) => mockEmitFailedAuth(...args) },
}));

// Unified auth on, not standalone, no real Valkey, cache encryption off. The object is shared,
// so a test can flip fallbackToLocal on the config the validation service already captured.
const mockConfig: any = {};
jest.mock('../src/config/unifiedAuthConfig', () => {
  const actual = jest.requireActual<any>('../src/config/unifiedAuthConfig');
  return {
    __esModule: true,
    ...actual,
    isStandaloneMode: () => false,
    shouldEnableDistributedCaching: () => false,
    getCachedUnifiedAuthConfig: () => {
      if (!mockConfig.enabled) {
        Object.assign(mockConfig, actual.getUnifiedAuthConfig(), {
          enabled: true, fallbackToLocal: false, hasValkey: false, isStandalone: false, encryptSecrets: false, healthCheckIntervalMs: 0,
        });
      }
      return mockConfig;
    },
  };
});

// AWS's documented example secret - not a real credential.
const EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const EXAMPLE_ACCESS_KEY_ID = 'AKIDEXAMPLE';

const mockCreateToken = jest.fn<any>();
const mockValidateToken = jest.fn<any>();
jest.mock('../src/clients/adminServiceClient', () => ({
  __esModule: true,
  adminServiceClient: {
    createUnifiedValidationToken: (...args: any[]) => mockCreateToken(...args),
    validateUnifiedAuthByToken: (...args: any[]) => mockValidateToken(...args),
    makeRequest: async () => ({}),
  },
}));

const mockFindAwsCredential = jest.fn<any>();
const mockGetSecretForSignature = jest.fn<any>();
jest.mock('../src/services/awsCredentialsService', () => ({
  __esModule: true,
  findAwsCredential: (...args: any[]) => mockFindAwsCredential(...args),
  getSecretForSignature: (...args: any[]) => mockGetSecretForSignature(...args),
}));

import { TokenBasedAwsAuth } from '../src/middlewares/tokenBasedAwsAuth';
import { deriveSigningKey } from '../src/utils/sigv4Verifier';
import { unifiedValidationCache } from '../src/services/unifiedValidationCache';
import { unifiedAwsCredentialValidationService } from '../src/services/unifiedAwsCredentialValidationService';
import { clearSigningKeys } from '../src/services/awsSigningKeyCache';

const BODY = '{"anthropic_version":"bedrock-2023-05-31","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}';
const URL_PATH = '/aws-bedrock/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke';
const GOOD_SIGNATURE = '60b52068207675b00eab1149b7ae865ba734d275dd72691a4275a20ebba0d0b0';
const WRONG_SIGNATURE = '60b52068207675b00eab1149b7ae865ba734d275dd72691a4275a20ebba0d0b1';
const SIGNED_AT = Date.UTC(2026, 8, 26, 12, 0, 0);

function makeReq(signature: string) {
  return {
    headers: {
      host: 'localhost:3000',
      'content-type': 'application/json',
      'x-amz-date': '20260926T120000Z',
      authorization: `AWS4-HMAC-SHA256 Credential=${EXAMPLE_ACCESS_KEY_ID}/20260926/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`,
      'user-agent': 'Boto3/1.34',
    },
    method: 'POST',
    path: '/model/anthropic.claude-3-haiku-20240307-v1:0/invoke',
    originalUrl: URL_PATH,
    query: {},
    rawBody: BODY,
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
  } as any;
}

async function run(auth: TokenBasedAwsAuth, req: any) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
  const next = jest.fn();
  await auth.authenticate(req, res, next);
  return { res, next };
}

/** Stands in for the Valkey tier: records the exact serialized entries written. */
const fakeValkey = () => {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (key: string, entry: any) => { store.set(key, JSON.stringify(entry)); }),
    get: jest.fn(async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null)),
    delete: jest.fn(async (key: string) => store.delete(key)),
    clear: jest.fn(async () => { store.clear(); }),
    clearPattern: jest.fn(async () => 0),
    disconnect: jest.fn(async () => undefined),
  };
};

/** The admin's answer: valid, with hex(kSigning) for every requested scope (as the admin derives it). */
function adminAnswers() {
  mockCreateToken.mockImplementation(async (request: any) => ({
    token: Buffer.from(JSON.stringify({ signingScopes: request.signingScopes ?? [] })).toString('base64'),
    expiresAt: Date.now() + 300000,
    requestId: 'tok-1',
  }));
  mockValidateToken.mockImplementation(async ({ token }: any) => {
    const { signingScopes } = JSON.parse(Buffer.from(token, 'base64').toString());
    return {
      valid: true,
      authType: 'aws_credential',
      data: {
        credentialId: 'cred-admin-1', userId: 'quinn.fixture@example.com', permissions: [], region: 'us-east-1', sapAiRegion: 'eu10',
        rateLimits: { requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null },
        metadata: { isActive: true, lastUsed: '2026-09-26T00:00:00Z' },
        signingKeys: signingScopes.map((s: any) => ({ ...s, key: deriveSigningKey(EXAMPLE_SECRET, s).toString('hex') })),
      },
      auditInfo: { requestId: 'val-1', validationTime: 1, cacheHit: false },
    };
  });
}

const allKeyHexes = () => ['bedrock', 'bedrock-runtime'].map(service =>
  deriveSigningKey(EXAMPLE_SECRET, { date: '20260926', region: 'us-east-1', service }).toString('hex'));

let valkey: ReturnType<typeof fakeValkey>;

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(SIGNED_AT + 5 * 60 * 1000);
  mockEmitFailedAuth.mockReset();
  mockEmitFailedAuth.mockResolvedValue(undefined);
  mockCreateToken.mockReset();
  mockValidateToken.mockReset();
  mockFindAwsCredential.mockReset();
  mockGetSecretForSignature.mockReset();
  mockConfig.fallbackToLocal = false;
  clearSigningKeys();
  (unifiedValidationCache as any).unifiedCache.clear();
  valkey = fakeValkey();
  (unifiedValidationCache as any).valkeyAdapter = valkey;
  adminAnswers();
});

describe('admin path: the gateway verifies with signing keys the admin returned', () => {
  it('asks for the header scope and its bedrock-runtime variant, never receives or caches a secret', async () => {
    const auth = new TokenBasedAwsAuth();
    const { res, next } = await run(auth, makeReq(GOOD_SIGNATURE));
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);

    expect(mockCreateToken).toHaveBeenCalledTimes(1);
    expect((mockCreateToken.mock.calls[0][0] as any).signingScopes).toEqual([
      { date: '20260926', region: 'us-east-1', service: 'bedrock' },
      { date: '20260926', region: 'us-east-1', service: 'bedrock-runtime' },
    ]);
    auth.destroy();
  });

  it('correct signature -> next(), wrong -> 403 with a failed-auth event', async () => {
    const auth = new TokenBasedAwsAuth();
    expect((await run(auth, makeReq(GOOD_SIGNATURE))).next).toHaveBeenCalledTimes(1);

    const bad = await run(auth, makeReq(WRONG_SIGNATURE));
    expect(bad.next).not.toHaveBeenCalled();
    expect(bad.res.status).toHaveBeenCalledWith(403);
    expect(mockEmitFailedAuth).toHaveBeenCalledTimes(1);
    expect(mockEmitFailedAuth.mock.calls[0][0]).toMatchObject({ authType: 'aws_credential', statusCode: 403 });
    auth.destroy();
  });

  it('a later request verifies with the in-memory key: no second admin call for keys', async () => {
    const first = new TokenBasedAwsAuth();
    expect((await run(first, makeReq(GOOD_SIGNATURE))).next).toHaveBeenCalledTimes(1);
    first.destroy();

    // A fresh middleware instance (empty per-signature cache) goes through the unified
    // validation cache, then asks the admin provider for the key.
    const second = new TokenBasedAwsAuth();
    const { res, next } = await run(second, makeReq(GOOD_SIGNATURE));
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockCreateToken).toHaveBeenCalledTimes(1);
    expect(mockValidateToken).toHaveBeenCalledTimes(1);
    second.destroy();
  });

  it('a validation-cache hit without an in-memory key fetches the keys from the admin once', async () => {
    const first = new TokenBasedAwsAuth();
    await run(first, makeReq(GOOD_SIGNATURE));
    first.destroy();
    clearSigningKeys(); // e.g. another gateway replica that only shares the Valkey tier

    const second = new TokenBasedAwsAuth();
    const { next } = await run(second, makeReq(GOOD_SIGNATURE));
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockValidateToken).toHaveBeenCalledTimes(2);
    expect((mockCreateToken.mock.calls[1][0] as any).signingScopes).toHaveLength(2); // both variants in one call
    second.destroy();
  });

  it('when the admin returns no key, the request is rejected (403), never accepted', async () => {
    mockValidateToken.mockImplementation(async () => ({
      valid: true, authType: 'aws_credential',
      data: { credentialId: 'cred-admin-1', userId: 'u', permissions: [], region: 'us-east-1', sapAiRegion: 'eu10', rateLimits: {}, metadata: { isActive: true, lastUsed: '' } },
      auditInfo: { requestId: 'v', validationTime: 1, cacheHit: false },
    }));
    const auth = new TokenBasedAwsAuth();
    const { res, next } = await run(auth, makeReq(GOOD_SIGNATURE));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    auth.destroy();
  });

  it('the unified validation cache (Valkey tier and memory) holds no signingKeys and no key material', async () => {
    const auth = new TokenBasedAwsAuth();
    await run(auth, makeReq(GOOD_SIGNATURE));
    auth.destroy();

    expect(valkey.set).toHaveBeenCalledTimes(1);
    const written = [...valkey.store.values()].join('\n');
    expect(written).toContain('cred-admin-1'); // plaintext payload: this really is the entry
    expect(written).not.toContain('signingKeys');
    for (const hex of allKeyHexes()) expect(written).not.toContain(hex);
    const local = JSON.stringify([...(unifiedValidationCache as any).unifiedCache.values()]);
    expect(local).not.toContain('signingKeys');
  });

  it('the validation result handed to the middleware carries no signingKeys', async () => {
    const r = await unifiedAwsCredentialValidationService.validateAwsCredential({
      accessKeyId: EXAMPLE_ACCESS_KEY_ID, signature: GOOD_SIGNATURE, clientIp: '127.0.0.1', method: 'POST', endpoint: URL_PATH,
      signingScopes: [{ date: '20260926', region: 'us-east-1', service: 'bedrock' }],
    } as any);
    expect(r.valid).toBe(true);
    expect(r.data).not.toHaveProperty('signingKeys');
  });

  it('keys are never logged', async () => {
    const auth = new TokenBasedAwsAuth();
    await run(auth, makeReq(GOOD_SIGNATURE));
    await run(auth, makeReq(WRONG_SIGNATURE));
    auth.destroy();
    const calls = Object.values(mockLog).flatMap((m: any) => m.mock.calls);
    expect(calls.length).toBeGreaterThan(0); // the spies see the auth path's logging
    const logged = JSON.stringify(calls);
    for (const hex of allKeyHexes()) expect(logged).not.toContain(hex);
    expect(logged).not.toContain(EXAMPLE_SECRET);
  });
});

describe('local validation (fallback during an admin outage)', () => {
  beforeEach(() => {
    mockConfig.fallbackToLocal = true;
    mockFindAwsCredential.mockImplementation(async (id: string) =>
      (id === EXAMPLE_ACCESS_KEY_ID ? { id: 'cred-local-1', accessKeyId: id, userId: 'local-user', isActive: true } : null));
    mockGetSecretForSignature.mockImplementation(async (id: unknown) => (id === EXAMPLE_ACCESS_KEY_ID ? EXAMPLE_SECRET : null));
    mockCreateToken.mockRejectedValue(new Error('admin down'));
  });

  it('puts no secret into the validation data or the cache', async () => {
    const r = await unifiedAwsCredentialValidationService.validateAwsCredential({
      accessKeyId: EXAMPLE_ACCESS_KEY_ID, signature: GOOD_SIGNATURE, clientIp: '127.0.0.1', method: 'POST', endpoint: URL_PATH,
    });
    expect(r.valid).toBe(true);
    expect(r.data).not.toHaveProperty('secretAccessKey');
    expect(JSON.stringify(r)).not.toContain(EXAMPLE_SECRET);
    expect([...valkey.store.values()].join('\n')).not.toContain(EXAMPLE_SECRET);
    // the secret is only ever looked up by access key id, by the local signing-key provider
    for (const call of mockGetSecretForSignature.mock.calls) expect(call[0]).toBe(EXAMPLE_ACCESS_KEY_ID);
  });

  it('a locally validated result keeps the local key source when it comes back from the cache', async () => {
    const outage = await unifiedAwsCredentialValidationService.validateAwsCredential({
      accessKeyId: EXAMPLE_ACCESS_KEY_ID, signature: GOOD_SIGNATURE, clientIp: '127.0.0.1', method: 'POST', endpoint: URL_PATH,
    });
    expect((outage as any).keySource).toBe('local');

    adminAnswers(); // the admin is back; the cached fallback result is still served
    const hit = await unifiedAwsCredentialValidationService.validateAwsCredential({
      accessKeyId: EXAMPLE_ACCESS_KEY_ID, signature: GOOD_SIGNATURE, clientIp: '127.0.0.1', method: 'POST', endpoint: URL_PATH,
    });
    expect(hit.auditInfo.source).toBe('cache');
    expect((hit as any).keySource).toBe('local');
  });

  it('end to end: a request validated locally during the outage verifies with the local key after it, without asking the admin', async () => {
    const during = new TokenBasedAwsAuth();
    expect((await run(during, makeReq(GOOD_SIGNATURE))).next).toHaveBeenCalledTimes(1);
    during.destroy();

    adminAnswers();
    const after = new TokenBasedAwsAuth();
    const { res, next } = await run(after, makeReq(GOOD_SIGNATURE));
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockValidateToken).not.toHaveBeenCalled();
    after.destroy();
  });
});
