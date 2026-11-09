/** The usage event carries the team the request was enforced under (spec 2026-10-14 §5): what was enforced is what is billed. */
import { describe, it, expect, jest } from '@jest/globals';
const emitted: any[] = [];
jest.mock('../src/services/usageEventEmitter', () => ({ __esModule: true, default: { emit: jest.fn(async (e: any) => { emitted.push(e); }) } }));
jest.mock('../src/services/siemUsageEvent', () => ({ emitSiemUsageEvent: jest.fn() }));
jest.mock('../src/config/unifiedAuthConfig', () => ({ isStandaloneMode: () => false }));
jest.mock('../src/toolGovernance/record', () => ({ toolsForEvent: () => undefined }));
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
import { emitUsageEvent, createUsageMetrics } from '../src/utils/usageTracker';

const base = (data: any) => ({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k1', ...data } }, originalUrl: '/v1/chat/completions', get: () => 'jest' } as any);

describe('emitUsageEvent teamId', () => {
  it('copies the team id from the team block, from awsAuth for SigV4, and leaves it out without a team', async () => {
    emitted.length = 0;
    await emitUsageEvent(base({ team: { teamId: 't-a', teamName: 'Alpha', limits: {} } }), createUsageMetrics(), 'm', 200);
    await emitUsageEvent({ ...base({}), awsAuth: { team: { teamId: 't-b', teamName: 'Beta', limits: {} } } }, createUsageMetrics(), 'm', 200);
    await emitUsageEvent(base({}), createUsageMetrics(), 'm', 200);
    await new Promise((r) => setImmediate(r));
    expect(emitted.map((e) => e.teamId)).toEqual(['t-a', 't-b', undefined]);
  });

  it('books no team for a malformed block that enforcement ignores (no teamName)', async () => {
    emitted.length = 0;
    await emitUsageEvent(base({ team: { teamId: 't-bad', limits: {} } }), createUsageMetrics(), 'm', 200);
    await new Promise((r) => setImmediate(r));
    expect(emitted.map((e) => e.teamId)).toEqual([undefined]);
  });
});
