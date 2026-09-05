const cds = require('@sap/cds');

describe('SAP-native usage fields', () => {
  it('adds the five SAP-native fields to ApiKeyUsage', async () => {
    const model = await cds.load(`${__dirname}/../../src/db/schema/api-keys.cds`);
    const e = model.definitions['sap.llm.gateway.admin.ApiKeyUsage'];
    for (const f of ['imageInputTokens', 'genAiTokens', 'capacityUnits', 'sapCost', 'sapCostCurrency']) {
      expect(e.elements[f]).toBeDefined();
    }
    expect(e.elements.genAiTokens.type).toBe('cds.Decimal');
    expect(e.elements.sapCostCurrency.length).toBe(3);
  });

  it('adds the five SAP-native fields to AwsCredentialUsage', async () => {
    const model = await cds.load(`${__dirname}/../../src/db/schema/aws-credentials.cds`);
    const e = model.definitions['sap.llm.gateway.admin.AwsCredentialUsage'];
    for (const f of ['imageInputTokens', 'genAiTokens', 'capacityUnits', 'sapCost', 'sapCostCurrency']) {
      expect(e.elements[f]).toBeDefined();
    }
    expect(e.elements.genAiTokens.type).toBe('cds.Decimal');
    expect(e.elements.sapCostCurrency.length).toBe(3);
  });
});
