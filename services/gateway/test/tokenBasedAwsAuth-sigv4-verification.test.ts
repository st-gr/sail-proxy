/**
 * tokenBasedAwsAuth verifies the SigV4 signature itself on every path: standalone, the
 * gateway's own validation cache, the unified validation cache, the admin service and the
 * local fallback. A validation result — cached or fresh — only says the access key id
 * exists; it never replaces the signature check.
 *
 * The signed requests are the botocore-signed Bedrock requests from sigv4Verifier.test.ts
 * (botocore 1.34.98, AWS's documented example secret, clock fixed at 2026-09-26T12:00:00Z).
 *
 * @see ../src/middlewares/tokenBasedAwsAuth.ts
 * @see ../src/utils/sigv4Verifier.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockEmitFailedAuth = jest.fn<any>();
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (...args: any[]) => mockEmitFailedAuth(...args) },
}));

const mockValidateAwsCredential = jest.fn<any>();
const mockResolveCredentialId = jest.fn<any>();
jest.mock('../src/services/unifiedAwsCredentialValidationService', () => ({
  __esModule: true,
  unifiedAwsCredentialValidationService: {
    validateAwsCredential: (...args: any[]) => mockValidateAwsCredential(...args),
    resolveCredentialId: (...args: any[]) => mockResolveCredentialId(...args),
    fetchSigningKeys: async () => { throw new Error('Admin service client not available'); },
  },
}));

// AWS's documented example secret — not a real credential.
const EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const EXAMPLE_ACCESS_KEY_ID = 'AKIDEXAMPLE';

jest.mock('../src/services/awsCredentialsService', () => ({
  __esModule: true,
  findAwsCredential: async (id: string) =>
    id === 'AKIDEXAMPLE' ? { id: 'cred-local-1', accessKeyId: id, userId: 'local-user', isActive: true } : null,
  getSecretForSignature: async (id: string) => (id === 'AKIDEXAMPLE' ? 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' : null),
}));

jest.mock('../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  isStandaloneMode: () => true,
  shouldEnableDistributedCaching: () => false,
}));
jest.mock('../src/clients/adminServiceClient', () => ({ __esModule: true, adminServiceClient: null }));

import tokenBasedAwsAuth, { TokenBasedAwsAuth } from '../src/middlewares/tokenBasedAwsAuth';
import { deriveSigningKey, SigningKeyProvider } from '../src/utils/sigv4Verifier';
import { localSigningKeyProvider } from '../src/services/awsSigningKeyProviders';

const BODY = '{"anthropic_version":"bedrock-2023-05-31","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}';
const URL_PATH = '/aws-bedrock/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke';
const GOOD_SIGNATURE = '60b52068207675b00eab1149b7ae865ba734d275dd72691a4275a20ebba0d0b0';
const WRONG_SIGNATURE = '60b52068207675b00eab1149b7ae865ba734d275dd72691a4275a20ebba0d0b1';
const SIGNED_AT = Date.UTC(2026, 8, 26, 12, 0, 0);

function makeReq(signature: string, overrides: { rawBody?: string; headers?: Record<string, any> } = {}) {
  const headers: Record<string, any> = {
    host: 'localhost:3000',
    'content-type': 'application/json',
    'x-amz-date': '20260926T120000Z',
    authorization: `AWS4-HMAC-SHA256 Credential=${EXAMPLE_ACCESS_KEY_ID}/20260926/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`,
    'user-agent': 'Boto3/1.34',
    ...overrides.headers,
  };
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
  return {
    headers,
    method: 'POST',
    path: '/model/anthropic.claude-3-haiku-20240307-v1:0/invoke',
    originalUrl: URL_PATH,
    query: {},
    rawBody: overrides.rawBody ?? BODY,
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
  } as any;
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
}

function validResult(source: 'admin_service' | 'local_fallback' | 'cache') {
  return {
    valid: true,
    authType: 'aws_credential',
    data: { credentialId: 'cred-1', userId: 'user-1', permissions: [], region: 'us-east-1' },
    keySource: source === 'local_fallback' ? 'local' : 'admin',
    auditInfo: { requestId: 'r-1', validationTime: 1, cacheHit: source === 'cache', source, responseTime: 1 },
  };
}

const exampleKeyProvider: SigningKeyProvider = {
  getSigningKey: async (id, scope) => (id === EXAMPLE_ACCESS_KEY_ID ? deriveSigningKey(EXAMPLE_SECRET, scope) : null),
};

async function run(auth: (req: any, res: any, next: any) => Promise<void>, req: any) {
  const res = makeRes();
  const next = jest.fn();
  await auth(req, res, next);
  return { res, next };
}

const byDefault = (req: any, res: any, next: any) => tokenBasedAwsAuth(req, res, next) as Promise<void>;

describe('tokenBasedAwsAuth verifies the SigV4 signature', () => {
  beforeEach(() => {
    mockEmitFailedAuth.mockReset();
    mockEmitFailedAuth.mockResolvedValue(undefined);
    mockValidateAwsCredential.mockReset();
    mockResolveCredentialId.mockReset();
    mockResolveCredentialId.mockResolvedValue(undefined);
    jest.spyOn(Date, 'now').mockReturnValue(SIGNED_AT + 5 * 60 * 1000);
  });

  describe('standalone (local credential store)', () => {
    beforeEach(() => { mockValidateAwsCredential.mockResolvedValue(validResult('local_fallback')); });

    it('valid signature -> next()', async () => {
      const req = makeReq(GOOD_SIGNATURE);
      const { res, next } = await run(byDefault, req);
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
      expect(req.isAwsAuthenticated).toBe(true);
    });

    it('wrong signature -> 403 and a failed-auth event', async () => {
      const req = makeReq(WRONG_SIGNATURE);
      const { res, next } = await run(byDefault, req);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(req.isAwsAuthenticated).toBeUndefined();
      expect(mockEmitFailedAuth).toHaveBeenCalledTimes(1);
      expect(mockEmitFailedAuth.mock.calls[0][0]).toMatchObject({ authType: 'aws_credential', statusCode: 403 });
    });

    it('tampered body -> 403', async () => {
      const { res, next } = await run(byDefault, makeReq(GOOD_SIGNATURE, { rawBody: BODY.replace('"hi"', '"ho"') }));
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('x-amz-date window', () => {
    beforeEach(() => { mockValidateAwsCredential.mockResolvedValue(validResult('local_fallback')); });

    // The response ordering (401 written before the lookup starts) is pinned in
    // failed-auth-refused-credential.test.ts; the lookup for the event never asks for signing keys.
    it('stale date (16 minutes old) -> 401 and a failed-auth event, decided and written before validation', async () => {
      (Date.now as jest.Mock<any>).mockReturnValue(SIGNED_AT + 16 * 60 * 1000);
      const { res, next } = await run(byDefault, makeReq(GOOD_SIGNATURE));
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      const validationCalls = [...mockValidateAwsCredential.mock.calls, ...mockResolveCredentialId.mock.calls];
      expect(validationCalls.length).toBeGreaterThan(0);
      for (const [request] of validationCalls) expect(request).not.toHaveProperty('signingScopes');
      expect(mockEmitFailedAuth).toHaveBeenCalledTimes(1);
      expect(mockEmitFailedAuth.mock.calls[0][0]).toMatchObject({ authType: 'aws_credential', statusCode: 401 });
    });

    it('missing x-amz-date -> 401', async () => {
      const { res, next } = await run(byDefault, makeReq(GOOD_SIGNATURE, { headers: { 'x-amz-date': undefined } }));
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('admin path', () => {
    it('is rejected when the admin signing-key provider cannot reach an admin, even with a valid signature', async () => {
      mockValidateAwsCredential.mockResolvedValue(validResult('admin_service'));
      // A fresh instance with the default providers: the singleton's validation cache
      // already holds this signature from the standalone tests. No admin client here, so the
      // key fetch fails (500); the admin path with keys is in tokenBasedAwsAuth-admin-signing-keys.
      const auth = new TokenBasedAwsAuth();
      const { res, next } = await run((req, r, n) => auth.authenticate(req, r, n), makeReq(GOOD_SIGNATURE));
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
      auth.destroy();
    });

    it('unified validation-cache hit still verifies: right signature -> next(), wrong -> 403', async () => {
      mockValidateAwsCredential.mockResolvedValue(validResult('cache'));
      const auth = new TokenBasedAwsAuth({ admin: exampleKeyProvider, local: localSigningKeyProvider });
      const handler = (req: any, res: any, next: any) => auth.authenticate(req, res, next);

      const good = await run(handler, makeReq(GOOD_SIGNATURE));
      expect(good.next).toHaveBeenCalledTimes(1);

      const bad = await run(handler, makeReq(WRONG_SIGNATURE));
      expect(bad.next).not.toHaveBeenCalled();
      expect(bad.res.status).toHaveBeenCalledWith(403);
      auth.destroy();
    });

    it("gateway validation-cache hit still verifies: replaying a signature with a changed body -> 403", async () => {
      mockValidateAwsCredential.mockResolvedValue(validResult('admin_service'));
      const auth = new TokenBasedAwsAuth({ admin: exampleKeyProvider, local: localSigningKeyProvider });
      const handler = (req: any, res: any, next: any) => auth.authenticate(req, res, next);

      const first = await run(handler, makeReq(GOOD_SIGNATURE));
      expect(first.next).toHaveBeenCalledTimes(1);

      const replay = await run(handler, makeReq(GOOD_SIGNATURE, { rawBody: BODY.replace('"hi"', '"ho"') }));
      expect(mockValidateAwsCredential).toHaveBeenCalledTimes(1); // second request was a cache hit
      expect(replay.next).not.toHaveBeenCalled();
      expect(replay.res.status).toHaveBeenCalledWith(403);
      auth.destroy();
    });
  });

  it('a signing-key provider that throws -> 500, never next()', async () => {
    mockValidateAwsCredential.mockResolvedValue(validResult('admin_service'));
    const throwing: SigningKeyProvider = { getSigningKey: async () => { throw new Error('key lookup failed'); } };
    const auth = new TokenBasedAwsAuth({ admin: throwing, local: throwing });
    const { res, next } = await run((req, r, n) => auth.authenticate(req, r, n), makeReq(GOOD_SIGNATURE));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    auth.destroy();
  });

  describe('local fallback when the admin service is unreachable', () => {
    const previous = process.env.UNIFIED_AUTH_FALLBACK_TO_LOCAL;
    let auth: TokenBasedAwsAuth;
    let handler: (req: any, res: any, next: any) => Promise<void>;

    beforeEach(() => {
      process.env.UNIFIED_AUTH_FALLBACK_TO_LOCAL = 'true';
      auth = new TokenBasedAwsAuth();
      process.env.UNIFIED_AUTH_FALLBACK_TO_LOCAL = previous;
      handler = (req, res, next) => auth.authenticate(req, res, next);
      mockValidateAwsCredential.mockRejectedValue(new Error('admin down'));
    });

    it('valid signature -> next()', async () => {
      const { res, next } = await run(handler, makeReq(GOOD_SIGNATURE));
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
      auth.destroy();
    });

    it('wrong signature -> 403', async () => {
      const { res, next } = await run(handler, makeReq(WRONG_SIGNATURE));
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      auth.destroy();
    });
  });
});
