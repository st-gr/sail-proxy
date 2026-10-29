/**
 * The admin refuses a credential that exists but is disabled or expired and names it in the
 * invalid validation response (`error.credentialId`, gateway service call only). The gateway puts
 * that ID into the failed-auth event, so the admin links the event to the credential and notifies
 * its owner. The client's response is the same as for an unknown key: the ID never reaches it.
 * An unknown key keeps the hash + hint of utils/credentialIdentity.ts.
 *
 * End to end through the real unified validation services, the admin service client mocked.
 * The AWS request is the botocore-signed Bedrock request of tokenBasedAwsAuth-sigv4-verification
 * (AWS's documented example credential, clock fixed at 2026-09-26T12:00:00Z).
 *
 * @see ../src/middlewares/unifiedTokenAuth.ts
 * @see ../src/middlewares/tokenBasedAwsAuth.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createHash } from 'crypto';

process.env.METADATA_ENCRYPTION_KEY = process.env.METADATA_ENCRYPTION_KEY || 'test-encryption-key-32-chars-minimum-length-required-for-validation';
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockEmitFailedAuth = jest.fn<any>();
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (...args: any[]) => mockEmitFailedAuth(...args) },
}));

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

const mockValidateToken = jest.fn<any>();
const mockCreateToken = jest.fn<any>();
jest.mock('../src/clients/adminServiceClient', () => ({
  __esModule: true,
  adminServiceClient: {
    createUnifiedValidationToken: (...args: any[]) => mockCreateToken(...args),
    validateUnifiedAuthByToken: (...args: any[]) => mockValidateToken(...args),
    makeRequest: async () => ({}),
  },
}));

import unifiedTokenAuth from '../src/middlewares/unifiedTokenAuth';
import { TokenBasedAwsAuth } from '../src/middlewares/tokenBasedAwsAuth';
import { unifiedValidationCache } from '../src/services/unifiedValidationCache';
import { unifiedAwsCredentialValidationService } from '../src/services/unifiedAwsCredentialValidationService';

const CREDENTIAL_UUID = '7d3e9a41-5b2c-4f8e-9a1d-2c3b4d5e6f70';
const EXAMPLE_ACCESS_KEY_ID = 'AKIDEXAMPLE';
const API_KEY = 'sk-refused-fixture-0123456789abcdef';
const SIGNATURE = '60b52068207675b00eab1149b7ae865ba734d275dd72691a4275a20ebba0d0b0';
const SIGNED_AT = Date.UTC(2026, 8, 26, 12, 0, 0);

/** The admin's invalid answer; `credentialId` only for a credential that exists. */
function adminRefuses(authType: 'api_key' | 'aws_credential', code: string, credentialId?: string) {
  mockValidateToken.mockResolvedValue({
    valid: false,
    authType,
    data: {},
    auditInfo: { requestId: 'val-1', validationTime: 1, cacheHit: false },
    error: { code, message: 'refused', details: 'refused', ...(credentialId ? { credentialId } : {}) },
  });
}

function awsReq(amzDate: string | null = '20260926T120000Z') {
  return {
    headers: {
      host: 'localhost:3000',
      'content-type': 'application/json',
      ...(amzDate === null ? {} : { 'x-amz-date': amzDate }),
      authorization: `AWS4-HMAC-SHA256 Credential=${EXAMPLE_ACCESS_KEY_ID}/20260926/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${SIGNATURE}`,
      'user-agent': 'Boto3/1.34',
    },
    method: 'POST',
    path: '/model/anthropic.claude-3-haiku-20240307-v1:0/invoke',
    originalUrl: '/aws-bedrock/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke',
    query: {},
    rawBody: '{}',
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
  } as any;
}

function apiKeyReq() {
  const headers: Record<string, string> = { 'x-api-key': API_KEY, 'user-agent': 'jest' };
  return {
    headers,
    get: (name: string) => headers[name.toLowerCase()],
    method: 'POST',
    path: '/v1/chat/completions',
    originalUrl: '/v1/chat/completions',
    query: {},
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

/** Runs one request; returns the failed-auth event and the client's status and body. */
async function attempt(handler: (req: any, res: any, next: any) => Promise<unknown>, req: any) {
  mockEmitFailedAuth.mockClear();
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
  const next = jest.fn();
  await handler(req, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(mockEmitFailedAuth).toHaveBeenCalledTimes(1);
  const body = JSON.parse(JSON.stringify(res.json.mock.calls[0][0]), (k, v) => (k === 'timestamp' ? '<ts>' : v));
  return { event: mockEmitFailedAuth.mock.calls[0][0] as Record<string, any>, status: res.status.mock.calls[0][0], body };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(SIGNED_AT + 5 * 60 * 1000);
  mockEmitFailedAuth.mockReset();
  mockEmitFailedAuth.mockResolvedValue(undefined);
  mockValidateToken.mockReset();
  mockCreateToken.mockReset();
  mockCreateToken.mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 300000, requestId: 'tok-1' });
  (unifiedValidationCache as any).unifiedCache.clear();
  (unifiedValidationCache as any).valkeyAdapter = { get: async () => null, set: async () => undefined, delete: async () => true };
});

describe.each([
  ['AWS credential', 'aws_credential' as const, ['AWS_CREDENTIAL_NOT_FOUND', 'AWS_CREDENTIAL_EXPIRED'], EXAMPLE_ACCESS_KEY_ID,
    () => { const auth = new TokenBasedAwsAuth(); return { handler: (q: any, r: any, n: any) => auth.authenticate(q, r, n), req: awsReq(), done: () => auth.destroy() }; }],
  ['API key', 'api_key' as const, ['API_KEY_NOT_FOUND', 'API_KEY_EXPIRED'], API_KEY,
    () => ({ handler: unifiedTokenAuth as any, req: apiKeyReq(), done: () => undefined })],
])('%s refused by the admin', (_label, authType, [disabledCode, expiredCode], presented, setup) => {
  const unknownHash = createHash('sha256').update(presented).digest('hex');

  it.each([['disabled', disabledCode], ['expired', expiredCode]])('%s: the event carries the credential ID, the client body is unchanged', async (_state, code) => {
    const { handler, req, done } = setup();
    adminRefuses(authType, disabledCode);
    const unknown = await attempt(handler, req);

    adminRefuses(authType, code, CREDENTIAL_UUID);
    const refused = await attempt(handler, setup().req);
    done();

    expect(refused.event).toMatchObject({ authType, credentialId: CREDENTIAL_UUID, credentialHint: presented.slice(0, 8) });
    expect(refused.event.credentialMaterial).toBeUndefined();
    expect(JSON.stringify(refused.event)).not.toContain(presented);
    expect(refused.status).toBe(unknown.status);
    expect(refused.body).toEqual(unknown.body);
    expect(JSON.stringify(refused.body)).not.toContain(CREDENTIAL_UUID);
  });

  it('unknown: the event carries the hash and hint only', async () => {
    const { handler, req, done } = setup();
    adminRefuses(authType, disabledCode);
    const { event } = await attempt(handler, req);
    done();
    expect(event).toMatchObject({ authType, credentialId: unknownHash, credentialHint: presented.slice(0, 8) });
  });
});

// A replay of an old captured request (stale x-amz-date) or one without a date is refused before
// any lookup, exactly as before; the credential is resolved afterwards, only for the event, through
// the same validation call a wrong signature triggers, without asking for signing keys.
describe('AWS request date refused', () => {
  const STALE = '20260926T113000Z'; // 35 minutes before the pinned clock
  const adminKnows = () => mockValidateToken.mockResolvedValue({
    valid: true, authType: 'aws_credential',
    data: { credentialId: CREDENTIAL_UUID, userId: 'robin.fixture@example.com', permissions: [], region: 'us-east-1', rateLimits: {}, metadata: {} },
    auditInfo: { requestId: 'val-1', validationTime: 1, cacheHit: false },
  });
  const run = async (amzDate: string | null) => {
    const auth = new TokenBasedAwsAuth();
    try {
      return await attempt((q, r, n) => auth.authenticate(q, r, n), awsReq(amzDate));
    } finally {
      auth.destroy();
    }
  };

  it.each([['stale', STALE], ['missing', null]])('%s date, known access key id: 401 and the event names the credential', async (_case, amzDate) => {
    adminKnows();
    const { event, status, body } = await run(amzDate);
    expect(status).toBe(401);
    expect(body).toEqual({ error: { code: 'INVALID_REQUEST_DATE', message: 'Request date missing or outside the allowed clock skew', timestamp: '<ts>' } });
    expect(event).toMatchObject({ authType: 'aws_credential', statusCode: 401, credentialId: CREDENTIAL_UUID, credentialHint: 'AKIDEXAM' });
    expect(event.credentialMaterial).toBeUndefined();
    expect(mockCreateToken).toHaveBeenCalledTimes(1);
    expect((mockCreateToken.mock.calls[0][0] as any).signingScopes).toBeUndefined();
  });

  // The client never waits for the lookup: known and unknown key ids answer equally fast, and an
  // admin outage cannot hold the 401 back.
  it('writes the 401 before the credential lookup starts, and the event still names the credential', async () => {
    adminKnows();
    const order: string[] = [];
    const original = unifiedAwsCredentialValidationService.validateAwsCredential.bind(unifiedAwsCredentialValidationService);
    const validate = jest.spyOn(unifiedAwsCredentialValidationService, 'validateAwsCredential')
      .mockImplementation(async (request) => { order.push('validate'); return original(request); });
    const auth = new TokenBasedAwsAuth();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(() => { order.push('response'); return res; }) } as any;
    try {
      await auth.authenticate(awsReq(STALE), res, jest.fn());
    } finally {
      auth.destroy();
      validate.mockRestore();
    }
    expect(order).toEqual(['response', 'validate']);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockEmitFailedAuth).toHaveBeenCalledTimes(1);
    expect(mockEmitFailedAuth.mock.calls[0][0]).toMatchObject({ credentialId: CREDENTIAL_UUID });
  });

  it('stale date, disabled access key id: the event names the refused credential', async () => {
    adminRefuses('aws_credential', 'AWS_CREDENTIAL_NOT_FOUND', CREDENTIAL_UUID);
    const { event, status } = await run(STALE);
    expect(status).toBe(401);
    expect(event.credentialId).toBe(CREDENTIAL_UUID);
  });

  it("stale date, unknown access key id: today's response and an unlinked event", async () => {
    adminKnows();
    const known = await run(STALE);
    (unifiedValidationCache as any).unifiedCache.clear(); // the known key id's validation was cached
    adminRefuses('aws_credential', 'AWS_CREDENTIAL_NOT_FOUND');
    const unknown = await run(STALE);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(known.body);
    expect(unknown.event).toMatchObject({
      credentialId: createHash('sha256').update(EXAMPLE_ACCESS_KEY_ID).digest('hex'),
      credentialHint: 'AKIDEXAM',
    });
  });

  it("a failing lookup changes nothing for the client: today's 401 and an unlinked event", async () => {
    mockCreateToken.mockRejectedValue(new Error('admin unreachable'));
    const { event, status, body } = await run(STALE);
    expect(status).toBe(401);
    expect(body.error.code).toBe('INVALID_REQUEST_DATE');
    expect(event.credentialId).toBe(createHash('sha256').update(EXAMPLE_ACCESS_KEY_ID).digest('hex'));
  });
});
