/**
 * A tenant reprice and the nightly recalculation share one guard (spec 2026-10-25 §6): a reprice
 * asked for during the nightly run waits for it, and a nightly run due during a reprice runs after
 * it - neither runs beside the other, neither is lost. The reprice covers 62 days.
 */
jest.mock('@sap/cds', () => ({ connect: { to: jest.fn() }, ql: {
  SELECT: { from: () => ({ columns: () => ({ SELECT: 'SapTenants' }) }), one: { from: () => ({ columns: () => ({ where: () => ({ SELECT: 'SapTenant' }) }) }) } },
} }));
jest.mock('../../../src/services/sapCapacityService', () => ({ cacheBillingFactorsByProvider: () => new Map(), explicitBillingCurrency: () => null, isProductive: () => false, cuFactor: () => 1 }));
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../../../libs/logger', () => ({ getDefaultLogger: () => mockLogger }));
jest.mock('../../../src/services/usageCounters', () => ({ rebuild: jest.fn(async () => ({})) }));
jest.mock('../../../src/services/userQuotaService', () => ({ republishAll: jest.fn(async () => 0) }));
jest.mock('../../../src/services/teamQuotaService', () => ({ republishAllTeams: jest.fn(async () => 0) }));
jest.mock('../../../src/services/toolUsageService', () => ({ applyRetention: jest.fn(async () => ({})) }));

const cds = require('@sap/cds');
import { CostRecalculationService } from '../../../src/services/costRecalculationService';

/** A db whose UPDATE statements take `ms` and are logged in order as 'nightly' or 'reprice'. */
function slowDb(ms: number, log: string[]) {
  return {
    options: { credentials: { kind: 'sqlite' } },
    run: jest.fn(async (q: any, params?: any[]) => {
      if (typeof q !== 'string') return q?.SELECT === 'SapTenant' ? null : [];
      const kind = q.includes('sapTenant = ?') ? 'reprice' : 'nightly';
      log.push(`${kind}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${kind}:end`);
      if (kind === 'reprice') log.push(`cutoff:${params?.[1]}`);
      return { changes: 1 };
    }),
  };
}

const order = (log: string[]) => log.filter((l) => !l.startsWith('cutoff:'));

it('a reprice asked for during the nightly run runs after it', async () => {
  const log: string[] = [];
  cds.connect.to.mockResolvedValue(slowDb(20, log));
  const service = new CostRecalculationService();
  const nightly = service.runRecalculation();
  await new Promise((r) => setTimeout(r, 5));
  const reprice = service.repriceTenant('acme-tenant');
  await Promise.all([nightly, reprice]);
  expect(order(log)).toEqual(['nightly:start', 'nightly:end', 'nightly:start', 'nightly:end',
    'reprice:start', 'reprice:end', 'reprice:start', 'reprice:end']);
});

it('a nightly run due during a reprice runs after it, not skipped', async () => {
  const log: string[] = [];
  cds.connect.to.mockResolvedValue(slowDb(20, log));
  const service = new CostRecalculationService();
  const reprice = service.repriceTenant('acme-tenant');
  await new Promise((r) => setTimeout(r, 5));
  const result = await service.runRecalculation();
  await reprice;
  expect(result).toEqual({ apiKeyRecords: 1, awsRecords: 1 });
  expect(order(log)).toEqual(['reprice:start', 'reprice:end', 'reprice:start', 'reprice:end',
    'nightly:start', 'nightly:end', 'nightly:start', 'nightly:end']);
});

it('reprices the last 62 days', async () => {
  const log: string[] = [];
  cds.connect.to.mockResolvedValue(slowDb(0, log));
  await new CostRecalculationService().repriceTenant('acme-tenant');
  const cutoff = new Date(log.find((l) => l.startsWith('cutoff:'))!.slice('cutoff:'.length));
  const days = (Date.now() - cutoff.getTime()) / 86_400_000;
  expect(days).toBeGreaterThan(61.9);
  expect(days).toBeLessThan(62.1);
});
