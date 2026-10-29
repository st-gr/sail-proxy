/**
 * The SAP AI Core region new AWS credentials are stamped with: the region of the active
 * sap-ai-core Connection (the parser's format, e.g. "prod.eu-central-1"), else SAP_AI_REGION
 * (else us-east-1) as before. Read it with cds.run; in a handler, only after any gateway call.
 */
const cds = require('@sap/cds');

const CONNECTIONS = 'sap.llm.gateway.admin.ProviderConnections';

export async function activeSapRegion(): Promise<string> {
  const row = await cds.run(
    cds.ql.SELECT.one.from(CONNECTIONS).columns('region').where({ providerType: 'sap-ai-core', isActive: true })
  ) as { region?: string | null } | undefined;
  return row?.region || process.env.SAP_AI_REGION || 'us-east-1';
}
