/**
 * enforceEntitlement is the one guard every inference controller calls after model substitution.
 * It 403s with type model_not_entitled and emits a security event carrying the client IP; a null
 * block passes. The controllers are exercised through this helper, not through live upstream calls.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
const emit = jest.fn<any>().mockResolvedValue(undefined);
jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: (...a: any[]) => emit(...a) }, securityEventEmitter: { emitModelNotEntitled: (...a: any[]) => emit(...a) } }));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: {}, getTrustForwardedFor: () => false }));

import { enforceEntitlement } from '../src/utils/modelEntitlement';

function res() { return { status: jest.fn().mockReturnThis(), json: jest.fn() } as any; }
const block = { catalogId: 'c', catalogName: 'Team', mode: 'list', include: ['gpt-5.4--deployed'] };

describe('enforceEntitlement', () => {
  beforeEach(() => { emit.mockClear(); });

  it('passes without a block', () => {
    const r = res();
    expect(enforceEntitlement({ originalUrl: '/openai/v1/chat/completions' } as any, r, 'anything')).toBe(true);
    expect(r.status).not.toHaveBeenCalled();
  });

  it('passes an entitled model', () => {
    const r = res();
    expect(enforceEntitlement({ unifiedAuth: { data: { entitlement: block, keyId: 'k1' } } } as any, r, 'gpt-5.4--deployed')).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses with 403 model_not_entitled and emits the event with client IP and key id', () => {
    const r = res();
    const req: any = {
      unifiedAuth: { authType: 'api_key', data: { entitlement: block, keyId: 'k1', email: 'u@test.com' } },
      originalUrl: '/openai/v1/chat/completions', method: 'POST', socket: { remoteAddress: '203.0.113.7' }, ip: '203.0.113.7',
      headers: {}, get: () => 'jest', debugRequestId: 'req-1'
    };
    expect(enforceEntitlement(req, r, 'anthropic--claude-4.8-opus')).toBe(false);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).toHaveBeenCalledWith({ error: { type: 'model_not_entitled', message: expect.stringContaining('anthropic--claude-4.8-opus'), model: 'anthropic--claude-4.8-opus', catalog: 'Team' } });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'k1', authType: 'api_key', model: 'anthropic--claude-4.8-opus', catalog: 'Team', clientIP: '203.0.113.7', endpoint: '/openai/v1/chat/completions', requestId: 'req-1' }));
  });

  it('uses the AWS credential id for SigV4 callers', () => {
    const r = res();
    const req: any = { awsAuth: { entitlement: block, credentialId: 'aws-1' }, originalUrl: '/aws/bedrock/model/x/invoke', method: 'POST', ip: '198.51.100.9', socket: { remoteAddress: '198.51.100.9' }, headers: {}, get: () => 'jest' };
    expect(enforceEntitlement(req, r, 'x')).toBe(false);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'aws-1', authType: 'aws_credential' }));
  });
});
