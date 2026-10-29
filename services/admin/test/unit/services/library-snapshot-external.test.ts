/**
 * An external (Connection) entry in the gateway's model list (spec 2026-10-23 §4.3) becomes a
 * Library row of origin 'external' named after its connection, and never a SAP price row: it has
 * no versions and its price is a list price set in the admin, not a SAP GenAI rate.
 */
import { mapModelToLibraryRow, GatewayModel } from '../../../src/services/librarySnapshot';

export {};

const NOW = new Date('2026-10-24T00:00:00Z');
const external = (extra: Record<string, unknown> = {}): GatewayModel => ({
  id: 'gpt-4o-mini--azure-prod', object: 'model', owned_by: 'azure-openai', accessType: 'external',
  connectionId: 'c-1', providerType: 'azure-openai', family: 'openai', upstreamModel: 'gpt-4o-mini',
  displayName: null, streamingSupported: true, routable: true, capabilities: ['chat', 'streaming', 'vision'], priced: true,
  ...extra,
} as unknown as GatewayModel);

describe('mapModelToLibraryRow and an external entry', () => {
  it('marks it external, names its connection and takes its capabilities', () => {
    const row = mapModelToLibraryRow(external(), NOW);
    expect(row).toMatchObject({
      modelId: 'gpt-4o-mini--azure-prod', baseModel: 'gpt-4o-mini', origin: 'external', connection: 'azure-prod',
      provider: 'azure-openai', accessType: 'external', provisioning: null, llmAccess: false, orchestration: false,
      displayName: 'gpt-4o-mini', streamingSupported: true, capText: true, inText: true, inImage: true, capImageRecognition: true,
      capEmbedding: false, deployment: null, versions: null, sapInputCost: null, absent: false, lastSeenAt: NOW,
    });
  });

  it('keeps a display name and maps embeddings', () => {
    const row = mapModelToLibraryRow(external({ id: 'emb--oa', upstreamModel: 'emb', displayName: 'Embeddings', capabilities: ['embeddings'] }), NOW);
    expect(row.displayName).toBe('Embeddings');
    expect(row.capEmbedding).toBe(true);
    expect(row.capText).toBe(false);
    expect(row.connection).toBe('oa');
  });

  it('leaves an SAP row origin sap with no connection', () => {
    const row = mapModelToLibraryRow({ id: 'gpt-4o', owned_by: 'OpenAI', versions: [] } as any, NOW);
    expect(row.origin).toBe('sap');
    expect(row.connection).toBeNull();
  });
});

describe('updatePricingDatabase and an external entry', () => {
  function loadService() {
    jest.resetModules();
    const mockRun = jest.fn();
    const mockError = jest.fn();
    jest.doMock('@sap/cds', () => ({
      connect: { to: jest.fn(() => Promise.resolve({ run: mockRun })) },
      ql: {
        SELECT: { from: jest.fn(() => ({ where: jest.fn().mockReturnThis() })) },
        INSERT: { into: jest.fn(() => ({ entries: jest.fn().mockReturnThis() })) },
        UPSERT: { into: jest.fn(() => ({ entries: jest.fn().mockReturnThis() })) },
        UPDATE: jest.fn(() => ({ set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis() })),
      },
    }));
    jest.doMock('axios');
    jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: mockError, trace: jest.fn() }) }));
    const { modelCostService } = require('../../../src/services/modelCostService');
    return { modelCostService, mockRun, mockError };
  }

  it('keeps the provider map of the last SAP list when the list holds connection models only', async () => {
    const { modelCostService } = loadService();
    const sapModel = { id: 'gpt-4o', owned_by: 'OpenAI', versions: [] };
    await (modelCostService as any).updatePricingDatabase([sapModel]);
    await (modelCostService as any).updatePricingDatabase([external()]);
    expect((modelCostService as any).modelProviderMap.get('gpt-4o')).toBe('OpenAI');
  });

  it('writes no ModelCosts row and logs no error', async () => {
    const { modelCostService, mockRun, mockError } = loadService();
    await (modelCostService as any).updatePricingDatabase([external()]);
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });
});
