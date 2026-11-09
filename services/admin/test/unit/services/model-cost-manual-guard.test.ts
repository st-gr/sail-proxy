/**
 * modelCostService.updatePricingDatabase must never close or overwrite a manual price row set via
 * modelPriceService.setManualPrice — the gateway refresh only touches rows with source='sap' —
 * and must ignore a model the gateway cannot route (M). Isolated in its own file: it needs
 * jest.resetModules() + jest.doMock('@sap/cds', ...), which would collide with
 * model-price-service.test.ts's top-level jest.mock('@libs/logger').
 */
export {};

/** modelCostService with @sap/cds and axios doubled; `run` records every statement it issues. */
function loadService() {
  jest.resetModules();
  const mockRun = jest.fn();
  jest.doMock('@sap/cds', () => ({
    connect: { to: jest.fn(() => Promise.resolve({ run: mockRun })) },
    ql: {
      SELECT: { from: jest.fn(() => ({ where: jest.fn().mockReturnThis() })) },
      INSERT: { into: jest.fn(() => ({ entries: jest.fn().mockReturnThis() })) },
      UPSERT: { into: jest.fn(() => ({ entries: jest.fn().mockReturnThis() })) },
      UPDATE: jest.fn(() => ({ set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis() }))
    }
  }));
  jest.doMock('axios');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { modelCostService } = require('../../../src/services/modelCostService');
  return { modelCostService, mockRun };
}

const priced = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  owned_by: 'OpenAI',
  versions: [{ name: '1', isLatest: true, cost: [{ inputCost: '0.001' }, { outputCost: '0.002' }] }],
  ...extra
});

/**
 * M: the gateway lists a foundation model it cannot route (routable:false) so the Model Library
 * can show it. It never serves a request, so it must not reach the pricing tables — the library
 * snapshot is its only consumer.
 */
describe('updatePricingDatabase and a model the gateway cannot route', () => {
  it('never looks a non-routable model up, let alone writes a price row for it', async () => {
    const { modelCostService, mockRun } = loadService();
    await (modelCostService as any).updatePricingDatabase([priced('openai--gpt-4o-realtime', { routable: false })]);
    expect(mockRun).not.toHaveBeenCalled();
    // and it is not attributed to a provider either
    expect((modelCostService as any).modelProviderMap.has('openai--gpt-4o-realtime')).toBe(false);
  });

  it('still prices the routable models beside it, flag or no flag', async () => {
    const { modelCostService, mockRun } = loadService();
    mockRun.mockResolvedValue([]);
    await (modelCostService as any).updatePricingDatabase([
      priced('openai--gpt-4o-realtime', { routable: false }),
      priced('anthropic--claude-4.5-haiku', { routable: true }),
      priced('openai--gpt-5')            // an older gateway sends no flag at all
    ]);
    const map = (modelCostService as any).modelProviderMap;
    expect(map.has('openai--gpt-4o-realtime')).toBe(false);
    expect(map.has('anthropic--claude-4.5-haiku')).toBe(true);
    expect(map.has('openai--gpt-5')).toBe(true);
  });
});

describe('updatePricingDatabase keeps manual rows', () => {
  it('skips a model whose current row is manual', async () => {
    jest.resetModules();
    const mockRun = jest.fn();
    jest.doMock('@sap/cds', () => ({
      connect: { to: jest.fn(() => Promise.resolve({ run: mockRun })) },
      ql: {
        SELECT: { from: jest.fn(() => ({ where: jest.fn().mockReturnThis() })) },
        INSERT: { into: jest.fn(() => ({ entries: jest.fn().mockReturnThis() })) },
        UPSERT: { into: jest.fn(() => ({ entries: jest.fn().mockReturnThis() })) },
        UPDATE: jest.fn(() => ({ set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis() }))
      }
    }));
    jest.doMock('axios');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { modelCostService } = require('../../../src/services/modelCostService');
    mockRun.mockResolvedValueOnce([{ ID: 'man', inputCost: '9', outputCost: '9', source: 'manual' }]);
    await (modelCostService as any).updatePricingDatabase([{ id: 'm1', owned_by: 'Anthropic', versions: [{ name: '1', isLatest: true, cost: [{ inputCost: '0.001' }, { outputCost: '0.002' }] }] }]);
    // one SELECT, no UPDATE (close) and no INSERT
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});
