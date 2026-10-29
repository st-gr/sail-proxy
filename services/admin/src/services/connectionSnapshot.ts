/**
 * The gateway's view of the Connections (spec 2026-10-23 §4.2), served by
 * ValidationService.getConnections() to the gateway's service JWT only. Every connection, with
 * isActive (the gateway lists only active ones and answers 503 for the others), its decrypted credential (null when none is stored or it cannot be decrypted) and their
 * published models, each saying whether a list price is in force - the gateway refuses an
 * unpriced one. The gateway keeps it in memory only; nothing here is logged beyond counts.
 */
import { getConnectionCredential, ConnectionSecret } from './connectionCredentialStore';
import { ProviderType, Family } from './connectionValidation';

const cds = require('@sap/cds');
const CONNECTIONS = 'sap.llm.gateway.admin.ProviderConnections';
const MODELS = 'sap.llm.gateway.admin.ConnectionModels';
const MODEL_COSTS = 'sap.llm.gateway.admin.ModelCosts';

/** The non-secret settings of every provider type; the gateway's adapters read the ones of their type. */
export const SETTING_FIELDS = [
  'endpoint', 'apiMode', 'apiVersion', 'authMode', 'tenantId', 'clientId',
  'region', 'runtimeEndpoint', 'accessKeyId',
  'baseUrl', 'organization', 'project', 'anthropicVersion',
  'resourceGroup',
] as const;

export interface SnapshotModel {
  modelId: string;
  upstreamModel: string;
  displayName: string | null;
  family: Family;
  capabilities: string[];
  priced: boolean;
}

export interface SnapshotConnection {
  id: string;
  name: string;
  providerType: ProviderType;
  isActive: boolean;
  settings: Record<string, string | null>;
  credentials: ConnectionSecret | null;
  models: SnapshotModel[];
}

function parseCapabilities(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export async function buildConnectionSnapshot(now: Date = new Date()): Promise<{ connections: SnapshotConnection[] }> {
  const { SELECT } = cds.ql;
  const rows: any[] = await cds.run(SELECT.from(CONNECTIONS).orderBy('name'));
  if (rows.length === 0) return { connections: [] };
  const models: any[] = await cds.run(SELECT.from(MODELS)
    .where({ connection_ID: { in: rows.map((r) => r.ID) } }).and({ isPublished: true }).orderBy('modelId'));
  const nowIso = now.toISOString();
  const priced = new Set<string>(models.length === 0 ? [] : (await cds.run(SELECT.from(MODEL_COSTS).columns('model')
    .where({ model: { in: models.map((m) => m.modelId) } }).and({ pricingKind: 'list_price' })
    .and({ dateFrom: { '<=': nowIso } }).and({ dateTo: { '>': nowIso } }))).map((r: any) => r.model));

  const connections: SnapshotConnection[] = [];
  for (const row of rows) {
    connections.push({
      id: row.ID,
      name: row.name,
      providerType: row.providerType,
      isActive: !!row.isActive,
      settings: Object.fromEntries(SETTING_FIELDS.map((f) => [f, row[f] ?? null])),
      credentials: await getConnectionCredential(row.ID),
      models: models.filter((m) => m.connection_ID === row.ID).map((m) => ({
        modelId: m.modelId,
        upstreamModel: m.upstreamModel,
        displayName: m.displayName ?? null,
        family: m.family,
        capabilities: parseCapabilities(m.capabilities),
        priced: priced.has(m.modelId),
      })),
    });
  }
  return { connections };
}
