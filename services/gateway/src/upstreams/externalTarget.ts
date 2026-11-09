/**
 * The per-request decision about a model id (spec 2026-10-23 §5.1, §5.4), made by every inference
 * route after substitution and before anything SAP-specific:
 *
 * - not a Connection model: `sap`, and the route carries on exactly as before;
 * - a Connection model it must not serve: the refusal is sent in the route's error shape and the
 *   answer is `handled` (not entitled 403, wrong route 400, connection unavailable 503, unpriced 409);
 * - otherwise `external`, with the connection, the model and the adapter to call.
 *
 * Entitlement is checked here again, against the registry view the dispatch uses: the controller's
 * own check may have run before a background refresh published the model, and the default catalog
 * grants every id it does not know to be a Connection model.
 */
import type { Request, Response } from 'express';
import { connectionRegistry } from '../connections/connectionRegistry';
import type { Connection, ConnectionModel, ModelFamily } from '../connections/types';
import { emitNotEntitled, entitlementFromRequest, isModelEntitled, logEntitlementDecision, respondNotEntitled } from '../utils/modelEntitlement';
import { adapterFor } from './index';
import type { ProviderAdapter } from './types';

export type ErrorShape = 'openai' | 'anthropic' | 'gemini';

export interface ExternalTarget {
  connection: Connection;
  model: ConnectionModel;
  adapter: ProviderAdapter;
}

export type ExternalResolution = { kind: 'sap' } | { kind: 'handled' } | { kind: 'external'; target: ExternalTarget };

/** The routes that serve each family (spec §5.3), named in a mismatch refusal. */
const ROUTES_FOR: Record<ModelFamily, string> = {
  openai: '/openai/v1/chat/completions, /openai/v1/responses or /openai/v1/embeddings',
  claude: '/anthropic/v1/messages',
};

const GEMINI_STATUS: Record<number, string> = { 400: 'INVALID_ARGUMENT', 403: 'PERMISSION_DENIED', 409: 'FAILED_PRECONDITION', 503: 'UNAVAILABLE' };

/** A refusal in the error envelope the route's clients parse. */
export function sendRefusal(res: Response, shape: ErrorShape, status: number, code: string, message: string): void {
  const type = status >= 500 ? 'api_error' : 'invalid_request_error';
  if (shape === 'anthropic') {
    res.status(status).json({ type: 'error', error: { type, message: `${code}: ${message}` } });
  } else if (shape === 'gemini') {
    res.status(status).json({ error: { code: status, message: `${code}: ${message}`, status: GEMINI_STATUS[status] ?? 'UNKNOWN' } });
  } else {
    res.status(status).json({ error: { message, type, code } });
  }
}

/**
 * @param served the family this route serves, or null for a route that serves no Connection model
 * @param shape  the error envelope of this route
 */
export async function resolveExternalTarget(req: Request, res: Response, modelId: string,
  served: ModelFamily | null, shape: ErrorShape): Promise<ExternalResolution> {
  if (!modelId) return { kind: 'sap' };
  await connectionRegistry.refreshForRequest();
  const hit = connectionRegistry.resolveExternal(modelId);
  if (!hit) return { kind: 'sap' };
  const { connection, model } = hit;

  // As enforceEntitlement, but in the route's shape: /google's clients parse the Gemini envelope.
  const block = entitlementFromRequest(req);
  if (block && !isModelEntitled(block, modelId)) {
    logEntitlementDecision(req, modelId, false);
    if (shape === 'gemini') sendRefusal(res, shape, 403, 'model_not_entitled', `Model ${modelId} is not in your entitlement catalog "${block.catalogName}"`);
    else respondNotEntitled(res, modelId, block);
    emitNotEntitled(req, modelId, block);
    return { kind: 'handled' };
  }

  if (served !== model.family) {
    sendRefusal(res, shape, 400, 'model_route_mismatch',
      `Model ${modelId} is served by a connection on ${ROUTES_FOR[model.family] ?? 'another route'}, not on this route.`);
    return { kind: 'handled' };
  }
  if (connection.isActive === false) {
    sendRefusal(res, shape, 503, 'connection_unavailable', `Connection "${connection.name}" is not active.`);
    return { kind: 'handled' };
  }
  const adapter = adapterFor(connection);
  if (!adapter) {
    const why = connection.credentials?.secret
      ? `provider type ${connection.providerType} is not served yet`
      : 'it has no usable credential';
    sendRefusal(res, shape, 503, 'connection_unavailable', `Connection "${connection.name}" cannot serve requests: ${why}.`);
    return { kind: 'handled' };
  }
  if (!model.priced) {
    sendRefusal(res, shape, 409, 'model_unpriced',
      `Model ${modelId} has no list price in force; an administrator must set one before it can be used.`);
    return { kind: 'handled' };
  }

  (req as any).__externalUsage = { provider: connection.providerType, connectionId: connection.id, upstreamModel: model.upstreamModel };
  return { kind: 'external', target: { connection, model, adapter } };
}
