/** The nightly cost recalculation rebuilds the usage buckets and republishes every night (spec §3.5). */
jest.mock('@sap/cds', () => ({ connect: { to: jest.fn() } }));
jest.mock('../../../src/services/sapCapacityService', () => ({ getCacheBillingFactors: () => ({ read: 1, write: 1 }), isProductive: () => true, cuFactor: () => 1 }));
jest.mock('../../../../../libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../../../src/services/usageCounters', () => ({ rebuild: jest.fn(async () => ({ users: 1, buckets: 1, durationMs: 1 })) }));
jest.mock('../../../src/services/userQuotaService', () => ({ republishAll: jest.fn(async () => 1) }));
jest.mock('../../../src/services/toolUsageService', () => ({ applyRetention: jest.fn(async () => ({ rawDeleted: 0, dailyDeleted: 0 })) }));

const cds = require('@sap/cds');
import { CostRecalculationService } from '../../../src/services/costRecalculationService';
import { rebuild } from '../../../src/services/usageCounters';
import { republishAll } from '../../../src/services/userQuotaService';
import { applyRetention } from '../../../src/services/toolUsageService';

const dbWith = (changes: number) => ({ options: { credentials: { kind: 'sqlite' } }, run: jest.fn(async () => ({ changes })) });

beforeEach(() => jest.clearAllMocks());

it('rebuilds and republishes after a run that updated rows', async () => {
  cds.connect.to.mockResolvedValue(dbWith(3));
  await new CostRecalculationService().runRecalculation();
  expect(rebuild).toHaveBeenCalledTimes(1);
  expect(republishAll).toHaveBeenCalledTimes(1);
});

// The retention lives in rebuild() and the quota documents expire after 24 h, so a quiet night —
// no row rewritten — must still rebuild and republish; gating on the counts let both lapse.
it('still rebuilds and republishes after a run that updated no rows', async () => {
  cds.connect.to.mockResolvedValue(dbWith(0));
  await new CostRecalculationService().runRecalculation();
  expect(rebuild).toHaveBeenCalledTimes(1);
  expect(republishAll).toHaveBeenCalledTimes(1);
});

it('still returns the real record counts when rebuild rejects; republish is skipped', async () => {
  (rebuild as jest.Mock).mockRejectedValueOnce(new Error('boom'));
  cds.connect.to.mockResolvedValue(dbWith(3));
  const result = await new CostRecalculationService().runRecalculation();
  expect(result).toEqual({ apiKeyRecords: 3, awsRecords: 3 });
  expect(republishAll).not.toHaveBeenCalled();
});

// The retention purge is the one step with its own boundary: stale tool rows can wait for the next
// night, the quota documents (24 h TTL) cannot, so a failing purge must not skip the republish.
it('still republishes when the tool usage retention purge rejects', async () => {
  (applyRetention as jest.Mock).mockRejectedValueOnce(new Error('purge boom'));
  cds.connect.to.mockResolvedValue(dbWith(3));
  const result = await new CostRecalculationService().runRecalculation();
  expect(result).toEqual({ apiKeyRecords: 3, awsRecords: 3 });
  expect(rebuild).toHaveBeenCalledTimes(1);
  expect(republishAll).toHaveBeenCalledTimes(1);
});
