/**
 * A standalone gateway (GATEWAY_STANDALONE=true: the npm-dist CLI) authenticates its local API keys
 * on the legacy path. Files, vector stores and the Responses file_search tool scope every row by
 * the caller's e-mail, so a key that passes the legacy check carries the same fixed owner the
 * unified local path uses: every key of a standalone gateway shares one file-search owner.
 * Outside standalone mode the legacy path is unchanged; a failed key is still a 401.
 *
 * @see ../src/middlewares/apiKeyAuth.ts
 * @see ../src/services/unifiedApiKeyValidationService.ts
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';

process.env.METADATA_ENCRYPTION_KEY = process.env.METADATA_ENCRYPTION_KEY || 'test-encryption-key-32-chars-minimum-length-required-for-validation';
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: jest.fn(async () => undefined) },
}));

const mockConfig: any = {};
jest.mock('../src/config/unifiedAuthConfig', () => {
  const actual = jest.requireActual<any>('../src/config/unifiedAuthConfig');
  return {
    __esModule: true,
    ...actual,
    shouldEnableDistributedCaching: () => false,
    getCachedUnifiedAuthConfig: () => mockConfig,
  };
});

import apiKeyAuth from '../src/middlewares/apiKeyAuth';
import unifiedTokenAuth from '../src/middlewares/unifiedTokenAuth';
import apiKeyService from '../src/services/apiKeyService';
import { getUnifiedAuthConfig, STANDALONE_OWNER_EMAIL } from '../src/config/unifiedAuthConfig';

const ENV_KEYS = ['GATEWAY_STANDALONE', 'UNIFIED_TOKEN_SYSTEM_ENABLED', 'VALKEY_URL', 'ADMIN_SERVICE_URL'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function req(apiKey: string, via: 'bearer' | 'x-goog-api-key' | 'key' = 'bearer') {
  const headers: Record<string, string> = { 'user-agent': 'jest' };
  const query: Record<string, string> = {};
  if (via === 'bearer') headers.authorization = `Bearer ${apiKey}`;
  else if (via === 'x-goog-api-key') headers['x-goog-api-key'] = apiKey;
  else query.key = apiKey;
  return {
    headers, query, body: {}, method: 'POST', path: '/v1/files', originalUrl: '/v1/files',
    ip: '127.0.0.1', connection: { remoteAddress: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' },
    get: (name: string) => headers[name.toLowerCase()],
  } as any;
}

async function run(handler: (req: any, res: any, next: any) => Promise<unknown>, apiKey: string, via: 'bearer' | 'x-goog-api-key' | 'key' = 'bearer') {
  const request = req(apiKey, via);
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
  const next = jest.fn();
  await handler(request, res, next);
  return { request, res, next };
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of Object.keys(mockConfig)) delete mockConfig[k];
  Object.assign(mockConfig, getUnifiedAuthConfig(), { enabled: false, fallbackToLocal: true, encryptSecrets: false, healthCheckIntervalMs: 0 });
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('legacy apiKeyAuth: the standalone file-search owner', () => {
  it('is the fixed owner the unified local path uses', async () => {
    expect(STANDALONE_OWNER_EMAIL).toBe('local@fallback.com');
    process.env.GATEWAY_STANDALONE = 'true';
    mockConfig.enabled = true;
    const record = await apiKeyService.createApiKey('sail-proxy-cli', '');
    const { request, next } = await run(unifiedTokenAuth as any, record.key);
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.apiKeyInfo.email).toBe(STANDALONE_OWNER_EMAIL);
  });

  it('standalone: a key that passes the legacy check carries the shared owner', async () => {
    process.env.GATEWAY_STANDALONE = 'true';
    const first = await apiKeyService.createApiKey('sail-proxy-cli', '');
    const second = await apiKeyService.createApiKey('other-fixture', 'other.fixture@example.com');

    for (const record of [first, second]) {
      const { request, res, next } = await run(unifiedTokenAuth as any, record.key);
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
      expect(request.apiKeyInfo).toEqual({ ...(await apiKeyService.validateApiKey(record.key)), email: STANDALONE_OWNER_EMAIL });
      expect(request.apiKey).toEqual({ key: record.key, ...request.apiKeyInfo });
      expect(request.apiKey.id).toBe(record.id);
    }
  });

  it.each([[undefined], ['false']])('GATEWAY_STANDALONE=%s: the legacy result is passed on unchanged', async (value) => {
    if (value !== undefined) process.env.GATEWAY_STANDALONE = value;
    const record = await apiKeyService.createApiKey('quinn.fixture', 'quinn.fixture@example.com');
    const validated = await apiKeyService.validateApiKey(record.key);
    const { request, next } = await run(apiKeyAuth as any, record.key);
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.apiKeyInfo).toEqual(validated);
    expect(request.apiKeyInfo).not.toHaveProperty('email');
    expect(request.apiKey).toEqual({ key: record.key, ...validated });
  });

  it('standalone: an unknown or disabled key is still a 401 without an identity', async () => {
    process.env.GATEWAY_STANDALONE = 'true';
    const disabled = await apiKeyService.createApiKey('robin.fixture', '');
    await apiKeyService.setApiKey(disabled.id, undefined, false);
    for (const key of ['sk-unknown-fixture-00000000000000000000', disabled.key]) {
      const { request, res, next } = await run(apiKeyAuth as any, key);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(request.apiKey).toBeUndefined();
      expect(request.apiKeyInfo).toBeUndefined();
    }
  });

  it.each([['x-goog-api-key'], ['key']])('standalone: a valid key sent as %s is accepted by the legacy path', async (via) => {
    process.env.GATEWAY_STANDALONE = 'true';
    const record = await apiKeyService.createApiKey('gemini-client.fixture', '');
    for (const handler of [apiKeyAuth, unifiedTokenAuth]) {
      const { request, res, next } = await run(handler as any, record.key, via as 'x-goog-api-key' | 'key');
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
      expect(request.apiKeyInfo.email).toBe(STANDALONE_OWNER_EMAIL);
    }
  });

  it('reads the key sources in the same order as the unified path', async () => {
    const first = await apiKeyService.createApiKey('first.fixture', 'first.fixture@example.com');
    const second = await apiKeyService.createApiKey('second.fixture', 'second.fixture@example.com');
    const request = req(second.key, 'key');
    request.headers['x-goog-api-key'] = first.key;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
    const next = jest.fn();
    await apiKeyAuth(request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.apiKey.id).toBe(first.id);
  });
});
