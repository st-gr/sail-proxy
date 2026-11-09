/**
 * Usage from a connection model (spec 2026-10-23 §5.5): the event names the provider type, the
 * connection and the upstream model and says origin external, so the admin never prices it as
 * SAP. Every other event stays exactly as before.
 */
import { describe, it, expect, jest } from '@jest/globals';
const emitted: any[] = [];
jest.mock('../src/services/usageEventEmitter', () => ({ __esModule: true, default: { emit: jest.fn(async (e: any) => { emitted.push(e); }) } }));
jest.mock('../src/services/siemUsageEvent', () => ({ emitSiemUsageEvent: jest.fn() }));
jest.mock('../src/config/unifiedAuthConfig', () => ({ isStandaloneMode: () => false }));
jest.mock('../src/toolGovernance/record', () => ({ toolsForEvent: () => undefined }));
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
import { emitUsageEvent, createUsageMetrics } from '../src/utils/usageTracker';

const base = () => ({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k1' } }, originalUrl: '/openai/v1/chat/completions', get: () => 'jest' } as any);

describe('external usage events', () => {
  it('a usage event carries provider, connectionId, upstreamModel and origin external', async () => {
    emitted.length = 0;
    const req = { ...base(), __externalUsage: { provider: 'azure-openai', connectionId: 'c-az', upstreamModel: 'my-deployment' } };
    await emitUsageEvent(req, createUsageMetrics(), 'gpt-4o--az', 200);
    await new Promise((r) => setImmediate(r));
    expect(emitted[0]).toMatchObject({ provider: 'azure-openai', connectionId: 'c-az', upstreamModel: 'my-deployment', origin: 'external', model: 'gpt-4o--az' });
  });

  it('without it the event is unchanged', async () => {
    emitted.length = 0;
    await emitUsageEvent(base(), createUsageMetrics(), 'gpt-4o', 200);
    await new Promise((r) => setImmediate(r));
    expect(emitted[0].provider).toBe('unknown');
    expect(emitted[0]).not.toHaveProperty('origin');
    expect(emitted[0]).not.toHaveProperty('connectionId');
    expect(emitted[0]).not.toHaveProperty('upstreamModel');
  });
});
