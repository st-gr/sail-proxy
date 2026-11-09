/**
 * The Connections snapshot as the admin's ValidationService.getConnections() hands it over
 * (services/admin/src/services/connectionSnapshot.ts, spec 2026-10-23 §4.2). It carries decrypted
 * credentials: kept in process memory only, never written to Valkey, disk or a log.
 */
export type ProviderType = 'azure-openai' | 'bedrock' | 'openai' | 'anthropic' | 'sap-ai-core';
export type ModelFamily = 'openai' | 'claude';

export interface ConnectionModel {
  modelId: string;
  upstreamModel: string;
  displayName: string | null;
  family: ModelFamily;
  capabilities: string[];
  /** A list price is in force: no price, no inference. */
  priced: boolean;
}

export interface Connection {
  id: string;
  name: string;
  providerType: ProviderType;
  /** Absent from an admin older than B1, which sends active connections only: absent means active. */
  isActive?: boolean;
  settings: Record<string, string | null>;
  credentials: { secret: string; sessionToken?: string } | null;
  models: ConnectionModel[];
}

/** Where the snapshot comes from: the admin (distributed deployments) or a file (standalone). */
export interface ConnectionBackend {
  fetch(): Promise<Connection[]>;
}
