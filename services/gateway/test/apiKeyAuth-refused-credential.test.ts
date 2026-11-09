/**
 * The legacy API-key path (unified auth off: standalone / npm-dist, or no Valkey or admin URL)
 * names a key that exists but is refused in its failed-auth event, exactly like the unified path:
 * the key's ID as credentialId plus the hint, and the client's 401 body unchanged. An unknown key
 * keeps the hash + hint of utils/credentialIdentity.ts.
 *
 * - disabled: the gateway's local key store (apiKeyService) holds the key with isActive=false.
 * - expired: only the admin knows expiry (the local store has none). With unified auth on and the
 *   legacy fallback, the admin's refusal names the key and the fallback does not emit a second,
 *   unlinked event.
 *
 * @see ../src/middlewares/apiKeyAuth.ts
 * @see ../src/middlewares/unifiedTokenAuth.ts
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
let mockStandalone = false;
jest.mock('../src/config/unifiedAuthConfig', () => {
  const actual = jest.requireActual<any>('../src/config/unifiedAuthConfig');
  return {
    __esModule: true,
    ...actual,
    isStandaloneMode: () => mockStandalone,
    shouldEnableDistributedCaching: () => false,
    getCachedUnifiedAuthConfig: () => mockConfig,
  };
});

const mockValidateToken = jest.fn<any>();
jest.mock('../src/clients/adminServiceClient', () => ({
  __esModule: true,
  adminServiceClient: {
    createUnifiedValidationToken: async () => ({ token: 'tok', expiresAt: Date.now() + 300000, requestId: 'tok-1' }),
    validateUnifiedAuthByToken: (...args: any[]) => mockValidateToken(...args),
    makeRequest: async () => ({}),
  },
}));

import apiKeyAuth from '../src/middlewares/apiKeyAuth';
import unifiedTokenAuth from '../src/middlewares/unifiedTokenAuth';
import apiKeyService from '../src/services/apiKeyService';
import { unifiedValidationCache } from '../src/services/unifiedValidationCache';
import { getUnifiedAuthConfig } from '../src/config/unifiedAuthConfig';

const KEY_UUID = '9e4c2b1a-7d6f-4a3b-8c2d-1e0f9a8b7c6d';
const UNKNOWN_KEY = 'sk-unknown-fixture-00000000000000000000';

function req(apiKey: string) {
  const headers: Record<string, string> = { 'x-api-key': apiKey, 'user-agent': 'jest' };
  return {
    headers, query: {}, body: {}, method: 'POST', path: '/v1/chat/completions', originalUrl: '/v1/chat/completions',
    ip: '127.0.0.1', connection: { remoteAddress: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' },
    get: (name: string) => headers[name.toLowerCase()],
  } as any;
}

/** Runs one request; returns every failed-auth event and the client's status and body. */
async function attempt(handler: (req: any, res: any, next: any) => Promise<unknown>, apiKey: string) {
  mockEmitFailedAuth.mockClear();
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
  const next = jest.fn();
  await handler(req(apiKey), res, next);
  expect(next).not.toHaveBeenCalled();
  return { events: mockEmitFailedAuth.mock.calls.map((c) => c[0] as Record<string, any>), status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
}

beforeEach(() => {
  mockEmitFailedAuth.mockReset();
  mockEmitFailedAuth.mockResolvedValue(undefined);
  mockValidateToken.mockReset();
  mockStandalone = false;
  for (const k of Object.keys(mockConfig)) delete mockConfig[k];
  Object.assign(mockConfig, getUnifiedAuthConfig(), { enabled: false, fallbackToLocal: true, encryptSecrets: false, healthCheckIntervalMs: 0 });
  (unifiedValidationCache as any).unifiedCache.clear();
  (unifiedValidationCache as any).valkeyAdapter = { get: async () => null, set: async () => undefined, delete: async () => true };
});

describe('legacy apiKeyAuth (unified auth off)', () => {
  it('standalone, a disabled key in the local store: the event carries its ID, the client body is unchanged', async () => {
    mockStandalone = true;
    const record = await apiKeyService.createApiKey('robin.fixture', 'robin.fixture@example.com');
    await apiKeyService.setApiKey(record.id, undefined, false);

    const unknown = await attempt(unifiedTokenAuth as any, UNKNOWN_KEY);
    const refused = await attempt(unifiedTokenAuth as any, record.key);

    expect(refused.events).toHaveLength(1);
    expect(refused.events[0]).toMatchObject({ authType: 'api_key', credentialId: record.id, credentialHint: record.key.slice(0, 8) });
    expect(refused.events[0].credentialMaterial).toBeUndefined();
    expect(JSON.stringify(refused.events[0])).not.toContain(record.key);
    expect(refused.status).toBe(401);
    expect(refused.status).toBe(unknown.status);
    expect(refused.body).toEqual(unknown.body);
    expect(JSON.stringify(refused.body)).not.toContain(record.id);
  });

  // The local store's IDs are the gateway's own (randomUUID at creation), never an admin row ID.
  // Where events reach an admin (not standalone), such an ID would link nothing, so it is not sent.
  it('with an admin receiving the events, a disabled local key keeps hash + hint, never the local ID', async () => {
    const record = await apiKeyService.createApiKey('quinn.fixture', 'quinn.fixture@example.com');
    await apiKeyService.setApiKey(record.id, undefined, false);
    const { events, status } = await attempt(apiKeyAuth as any, record.key);
    expect(status).toBe(401);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      credentialId: createHash('sha256').update(record.key).digest('hex'),
      credentialHint: record.key.slice(0, 8),
    });
    expect(JSON.stringify(events[0])).not.toContain(record.id);
  });

  it('an unknown key: the event carries the hash and hint only', async () => {
    const { events } = await attempt(apiKeyAuth as any, UNKNOWN_KEY);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      credentialId: createHash('sha256').update(UNKNOWN_KEY).digest('hex'),
      credentialHint: UNKNOWN_KEY.slice(0, 8),
    });
  });
});

describe('unified auth refusing, legacy fallback answering', () => {
  const refuses = (code: string, credentialId?: string) => mockValidateToken.mockResolvedValue({
    valid: false, authType: 'api_key', data: {}, auditInfo: { requestId: 'v', validationTime: 1, cacheHit: false },
    error: { code, message: 'refused', details: 'refused', ...(credentialId ? { credentialId } : {}) },
  });

  it.each([['disabled', 'API_KEY_NOT_FOUND'], ['expired', 'API_KEY_EXPIRED']])('%s: one event, carrying the key ID; the body is the unknown-key body', async (_state, code) => {
    mockConfig.enabled = true;
    const presented = 'sk-admin-refused-fixture-000000000000';
    refuses('API_KEY_NOT_FOUND');
    const unknown = await attempt(unifiedTokenAuth as any, presented);
    refuses(code, KEY_UUID);
    const refused = await attempt(unifiedTokenAuth as any, presented);

    expect(refused.events).toHaveLength(1);
    expect(refused.events[0]).toMatchObject({ authType: 'api_key', credentialId: KEY_UUID, credentialHint: presented.slice(0, 8) });
    expect(refused.status).toBe(unknown.status);
    expect(refused.body).toEqual(unknown.body);
  });
});
