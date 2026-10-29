/**
 * Connection models in the gateway's model list (spec 2026-10-23 §4.3). The entry carries what
 * dispatch needs (accessType 'external', the connection, the upstream name, the family that picks
 * the matching routes) whether or not SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES is on.
 */
import { getDefaultLogger } from '@libs/logger';
import type { Connection, ConnectionModel } from './types';

const logger = getDefaultLogger();

/** The gateway's default model timestamp (modelService.ts), for entries with no creation date of their own. */
const DEFAULT_CREATED = 184978800;

export interface ModelEntry {
  id: string;
  [key: string]: any;
}

export function externalModelEntry(c: Connection, m: ConnectionModel): ModelEntry {
  return {
    id: m.modelId,
    object: 'model',
    created: DEFAULT_CREATED,
    owned_by: c.providerType,
    accessType: 'external',
    connectionId: c.id,
    providerType: c.providerType,
    family: m.family,
    upstreamModel: m.upstreamModel,
    displayName: m.displayName,
    streamingSupported: true,
    routable: true,
    capabilities: m.capabilities,
    priced: m.priced,
  };
}

/**
 * Whether a model list may go to the admin's Library snapshot: it must hold at least one SAP model.
 * A list built while the SAP fetch failed holds connection models only; published, it would make
 * the admin mark every SAP model absent.
 */
export function isPublishableModelList(list: ModelEntry[] | null | undefined): boolean {
  return Array.isArray(list) && list.some((m) => m?.accessType !== 'external');
}

/** SAP entries first, in their order, then the external ones; an external id equal to an SAP id is dropped (SAP wins). */
export function mergeExternalModels(sap: ModelEntry[], external: ModelEntry[]): { data: ModelEntry[]; shadowed: string[] } {
  const sapIds = new Set(sap.map((m) => m.id));
  const shadowed: string[] = [];
  const kept = external.filter((m) => {
    if (!sapIds.has(m.id)) return true;
    shadowed.push(m.id);
    logger.warn('ModelService', `Connection model '${m.id}' has the id of an SAP AI Core model and is not listed; the SAP model wins`);
    return false;
  });
  return { data: [...sap, ...kept], shadowed };
}
