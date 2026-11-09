/**
 * A4: an Authorization header that merely contains "AWS4-HMAC-SHA256" (but does not start
 * with "AWS4-HMAC-SHA256 ") used to be classified as AWS by unifiedTokenAuth and then
 * skipped by tokenBasedAwsAuth, which called next() without authenticating anyone. Routes
 * guarded by unifiedTokenAuth alone (/v1/models, /anthropic/v1/messages/count_tokens)
 * answered 200 to anonymous callers. Both middlewares now share isAwsSigV4Request.
 *
 * @see ../src/utils/sigv4Verifier.ts (isAwsSigV4Request)
 * @see ../src/middlewares/unifiedTokenAuth.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const authConfig = { enabled: true, fallbackToLocal: false };
jest.mock('../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  isStandaloneMode: () => false,
  shouldEnableDistributedCaching: () => false,
  getCachedUnifiedAuthConfig: () => authConfig,
}));

jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: jest.fn<any>().mockResolvedValue(undefined) },
}));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: {}, getTrustForwardedFor: () => false }));
jest.mock('../src/services/unifiedApiKeyValidationService', () => ({
  __esModule: true,
  unifiedApiKeyValidationService: { validateApiKey: jest.fn<any>() },
}));
jest.mock('../src/services/apiKeyService', () => ({ __esModule: true, default: { validateApiKey: jest.fn<any>().mockResolvedValue(null) } }));
jest.mock('../src/services/unifiedAwsCredentialValidationService', () => ({
  __esModule: true,
  unifiedAwsCredentialValidationService: { validateAwsCredential: jest.fn<any>() },
}));

const reached = jest.fn();
jest.mock('../src/controllers/modelController', () => ({
  getModels: (_req: any, res: any) => { reached('models'); res.status(200).json({ data: [] }); },
  getModelById: (_req: any, res: any) => res.status(200).json({}),
  clearModelsCache: (_req: any, res: any) => { reached('clear'); res.status(200).json({}); },
  getAnthropicModels: (_req: any, res: any) => res.status(200).json({ data: [] }),
  getAnthropicModelById: (_req: any, res: any) => res.status(200).json({}),
}));
jest.mock('../src/controllers/countTokensController', () => ({
  handleCountTokens: (_req: any, res: any) => { reached('count_tokens'); res.status(200).json({ input_tokens: 1 }); },
}));
jest.mock('../src/controllers/anthropicController', () => ({ handleMessages: jest.fn(), handleComplete: jest.fn() }));
jest.mock('../src/middlewares/quotaEnforcement', () => ({ __esModule: true, default: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/services/unifiedAuthProxyService', () => ({
  unifiedAuthProxyService: { createServiceAuthMiddleware: () => (_req: any, _res: any, next: any) => next() },
  serviceConfigurations: { anthropic: {} },
}));
jest.mock('../src/toolGovernance', () => ({ toolGovernance: () => (_req: any, _res: any, next: any) => next(), anthropicAdapter: {} }));

import modelRoutes from '../src/routes/modelRoutes';
import anthropicRoutes from '../src/routes/anthropicRoutes';

const app = express();
app.use(express.json());
app.use('/v1/models', modelRoutes);
app.use('/anthropic/v1', anthropicRoutes);

const SPOOFED = [
  'X AWS4-HMAC-SHA256 Credential=a/b/c',
  'Bearer AWS4-HMAC-SHA256 Credential=a/b/c',
  'aws4-hmac-sha256 Credential=a/b/c/d/e',
];

describe.each([
  ['unified auth enabled', true],
  ['unified auth disabled (legacy path)', false],
])('A4: spoofed SigV4 headers are not authenticated (%s)', (_label, enabled) => {
  beforeEach(() => {
    authConfig.enabled = enabled as boolean;
    reached.mockReset();
  });

  it.each(SPOOFED)('GET /v1/models with %j -> 401', async (authorization) => {
    const res = await request(app).get('/v1/models').set('x-amz-date', 'x').set('Authorization', authorization);
    expect(res.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
  });

  it('POST /v1/models/cache/clear -> 401', async () => {
    const res = await request(app).post('/v1/models/cache/clear').set('x-amz-date', 'x').set('Authorization', SPOOFED[0]!);
    expect(res.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
  });

  it('POST /anthropic/v1/messages/count_tokens -> 401', async () => {
    const res = await request(app)
      .post('/anthropic/v1/messages/count_tokens')
      .set('x-amz-date', 'x')
      .set('Authorization', SPOOFED[0]!)
      .send({ model: 'claude', messages: [] });
    expect(res.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
  });
});
