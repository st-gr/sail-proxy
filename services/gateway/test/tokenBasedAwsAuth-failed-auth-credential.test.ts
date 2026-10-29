/**
 * A failed-auth event for an access key id that validation resolved to a stored credential
 * carries that credential's ID as credentialId, so the admin links the event to the credential
 * and notifies its owner. An access key id that resolves to nothing keeps the hash + hint of
 * utils/credentialIdentity.ts. Neither carries the secret, a signing key or the signature.
 *
 * The signed request is the botocore-signed Bedrock request from sigv4Verifier.test.ts
 * (AWS's documented example secret, clock fixed at 2026-09-26T12:00:00Z).
 *
 * @see ../src/middlewares/tokenBasedAwsAuth.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createHash } from 'crypto';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockEmitFailedAuth = jest.fn<any>();
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (...args: any[]) => mockEmitFailedAuth(...args) },
}));

const mockValidateAwsCredential = jest.fn<any>();
jest.mock('../src/services/unifiedAwsCredentialValidationService', () => ({
  __esModule: true,
  unifiedAwsCredentialValidationService: {
    validateAwsCredential: (...args: any[]) => mockValidateAwsCredential(...args),
  },
}));

jest.mock('../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  isStandaloneMode: () => true,
  shouldEnableDistributedCaching: () => false,
}));
jest.mock('../src/clients/adminServiceClient', () => ({ __esModule: true, adminServiceClient: null }));

import { TokenBasedAwsAuth } from '../src/middlewares/tokenBasedAwsAuth';
import { deriveSigningKey, SigningKeyProvider } from '../src/utils/sigv4Verifier';

// AWS's documented example secret — not a real credential.
const EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const EXAMPLE_ACCESS_KEY_ID = 'AKIDEXAMPLE';
const CREDENTIAL_UUID = '5f0c2a7e-3b1d-4c9a-8e6f-1a2b3c4d5e6f';

const BODY = '{"anthropic_version":"bedrock-2023-05-31","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}';
const GOOD_SIGNATURE = '60b52068207675b00eab1149b7ae865ba734d275dd72691a4275a20ebba0d0b0';
const WRONG_SIGNATURE = '60b52068207675b00eab1149b7ae865ba734d275dd72691a4275a20ebba0d0b1';
const SIGNED_AT = Date.UTC(2026, 8, 26, 12, 0, 0);

function makeReq(signature: string, rawBody: string = BODY) {
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
    originalUrl: '/aws-bedrock/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke',
    query: {},
    rawBody,
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
  } as any;
}

const knownCredential = {
  valid: true,
  authType: 'aws_credential',
  data: { credentialId: CREDENTIAL_UUID, userId: 'robin.fixture@example.com', permissions: [], region: 'us-east-1' },
  keySource: 'admin',
  auditInfo: { requestId: 'r-1', validationTime: 1, cacheHit: false, source: 'admin_service', responseTime: 1 },
};

const unknownCredential = {
  valid: false,
  authType: 'aws_credential',
  auditInfo: { requestId: 'r-2', validationTime: 1, cacheHit: false, source: 'admin_service', responseTime: 1 },
  error: { code: 'validation_failed', message: 'AWS credential validation failed' },
};

const exampleKeyProvider: SigningKeyProvider = {
  getSigningKey: async (id, scope) => (id === EXAMPLE_ACCESS_KEY_ID ? deriveSigningKey(EXAMPLE_SECRET, scope) : null),
};

async function failedAuthEventFor(req: any): Promise<Record<string, any>> {
  const auth = new TokenBasedAwsAuth({ admin: exampleKeyProvider, local: exampleKeyProvider });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
  const next = jest.fn();
  await auth.authenticate(req, res, next);
  auth.destroy();
  expect(next).not.toHaveBeenCalled();
  expect(mockEmitFailedAuth).toHaveBeenCalledTimes(1);
  return mockEmitFailedAuth.mock.calls[0][0] as Record<string, any>;
}

function expectNoSecretMaterial(event: Record<string, any>, signature: string) {
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(EXAMPLE_SECRET);
  expect(serialized).not.toContain(signature);
  expect(serialized).not.toContain('AWS4-HMAC-SHA256');
}

describe('tokenBasedAwsAuth failed-auth events name the resolved credential', () => {
  beforeEach(() => {
    mockEmitFailedAuth.mockReset();
    mockEmitFailedAuth.mockResolvedValue(undefined);
    mockValidateAwsCredential.mockReset();
    jest.spyOn(Date, 'now').mockReturnValue(SIGNED_AT + 5 * 60 * 1000);
  });

  it('a wrong signature for a known access key id carries the credential ID', async () => {
    mockValidateAwsCredential.mockResolvedValue(knownCredential);
    const event = await failedAuthEventFor(makeReq(WRONG_SIGNATURE));
    expect(event).toMatchObject({ authType: 'aws_credential', statusCode: 403, reason: 'Invalid AWS signature' });
    expect(event.credentialId).toBe(CREDENTIAL_UUID);
    expect(event.credentialHint).toBe(EXAMPLE_ACCESS_KEY_ID.slice(0, 8));
    expect(event.credentialMaterial).toBeUndefined();
    expectNoSecretMaterial(event, WRONG_SIGNATURE);
  });

  it('a body that does not match a valid signature for a known access key id carries the credential ID', async () => {
    mockValidateAwsCredential.mockResolvedValue(knownCredential);
    const event = await failedAuthEventFor(makeReq(GOOD_SIGNATURE, BODY.replace('"hi"', '"ho"')));
    expect(event.credentialId).toBe(CREDENTIAL_UUID);
    expectNoSecretMaterial(event, GOOD_SIGNATURE);
  });

  it('an unknown access key id carries only the hash and hint', async () => {
    mockValidateAwsCredential.mockResolvedValue(unknownCredential);
    const event = await failedAuthEventFor(makeReq(WRONG_SIGNATURE));
    expect(event.statusCode).toBe(403);
    expect(event.credentialId).toBe(createHash('sha256').update(EXAMPLE_ACCESS_KEY_ID).digest('hex'));
    expect(event.credentialHint).toBe(EXAMPLE_ACCESS_KEY_ID.slice(0, 8));
    expect(JSON.stringify(event)).not.toContain(CREDENTIAL_UUID);
    expectNoSecretMaterial(event, WRONG_SIGNATURE);
  });
});
