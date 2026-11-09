/**
 * The admin authenticates to the gateway with the ADMIN_TO_GATEWAY service key that
 * modelCostService creates in ApiKeys. If this breaks, /v1/models pulls fail with 401 and every
 * library feature that depends on the snapshot is dark. Pins: reuse of an existing active key,
 * creation when none exists, and the row shape createServiceKeyData produces.
 */
export {};

const mockRun = jest.fn();
const mockTx = jest.fn((fn: any) => fn({ run: mockRun }));
jest.mock('@sap/cds', () => ({
  connect: { to: jest.fn(() => Promise.resolve({ run: mockRun })) },
  tx: (fn: any) => mockTx(fn),
  ql: {
    SELECT: { from: jest.fn(() => ({ where: jest.fn().mockReturnThis() })) },
    INSERT: { into: jest.fn(() => ({ entries: jest.fn().mockReturnThis() })) },
    UPDATE: jest.fn(() => ({ set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis() }))
  }
}));
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() })
}));

import { modelCostService } from '../../../src/services/modelCostService';
import { SERVICE_KEYS, createServiceKeyData } from '@libs/service-auth';

describe('ADMIN_TO_GATEWAY service key', () => {
  beforeEach(() => { mockRun.mockReset(); mockTx.mockClear(); (modelCostService as any).serviceApiKey = null; });

  it('reads the key in its own root transaction, never in the ambient request transaction', async () => {
    // The SQLite pool has one connection; a lookup inside the caller's request tx followed by the
    // gateway round-trip deadlocks the gateway's validation callback (see getServiceApiKey).
    mockRun.mockResolvedValueOnce([{ key: 'sk-existing-0123456789abcdef', email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL }]);
    await (modelCostService as any).getServiceApiKey();
    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing active key for admin2gateway.service.key', async () => {
    mockRun.mockResolvedValueOnce([{ key: 'sk-existing-0123456789abcdef', email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL }]);
    const key = await (modelCostService as any).getServiceApiKey();
    expect(key).toBe('sk-existing-0123456789abcdef');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('creates one when none exists and caches it', async () => {
    mockRun.mockResolvedValueOnce([]).mockResolvedValueOnce(1);
    const key = await (modelCostService as any).getServiceApiKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThanOrEqual(40);
    const again = await (modelCostService as any).getServiceApiKey();
    expect(again).toBe(key);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('createServiceKeyData yields an active, non-deletable row with the registry e-mail', () => {
    const row = createServiceKeyData('ADMIN_TO_GATEWAY');
    expect(row.email).toBe('admin2gateway.service.key');
    expect(row.isActive).toBe(true);
    expect(row.canBeDeleted).toBe(false);
    expect(row.key).toBeTruthy();
  });
});
