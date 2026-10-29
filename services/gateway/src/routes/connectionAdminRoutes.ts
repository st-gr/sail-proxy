/**
 * /api/admin/connections: the admin cockpit's connection test and upstream model list (spec
 * 2026-10-23 §5.2, §7). The admin holds the credential encrypted and never calls a provider itself;
 * the gateway, which holds the decrypted snapshot, does. Answers carry a reason code, never the
 * provider's text. A gateway with an admin takes the service key (ADMIN_TO_GATEWAY, connections:read)
 * or standalone, like /api/admin/deployments. A standalone gateway serves the same handlers to the
 * standalone caller only (like /aws/api-keys), plus POST /reload, which the CLI calls after it edits
 * connections.json.
 */
import express from 'express';
import { getDefaultLogger } from '@libs/logger';
import { gatewayStandaloneOnlyAuth, gatewayStandaloneOrServiceKeyAuth } from '../middlewares/gatewayServiceAuth';
import { isStandaloneMode } from '../config/unifiedAuthConfig';
import { connectionRegistry } from '../connections/connectionRegistry';
import type { Connection } from '../connections/types';
import { adapterFor } from '../upstreams';
import { failureOf, resultOf } from '../upstreams/probe';
import type { ProviderAdapter, TestResult } from '../upstreams/types';
import { targetFromConnection, testSapTarget } from '../sap/sapTargetSync';

const logger = getDefaultLogger();
export const CONNECTIONS_ADMIN_PATH = '/api/admin/connections';

type Lookup = { connection: Connection; adapter: ProviderAdapter | null } | { missing: true };

/** The connection as the admin has it now: the admin may have changed it a moment ago. */
async function lookup(id: string): Promise<Lookup> {
  connectionRegistry.markStale();
  await connectionRegistry.ensureFresh();
  const connection = connectionRegistry.getConnection(id);
  return connection ? { connection, adapter: adapterFor(connection) } : { missing: true };
}

const notFound = (res: express.Response, id: string) =>
  res.status(404).json({ error: 'connection_not_found', message: `No connection ${id}` });

/** A SAP AI Core connection is tested with its own target, which is never installed by a test. */
async function testSapConnection(connection: Connection): Promise<TestResult> {
  let target;
  try {
    target = targetFromConnection(connection);
  } catch {
    return { ok: false, error: { reason: 'no_credential' } };
  }
  return testSapTarget(target);
}

async function testRoute(req: express.Request, res: express.Response) {
  const found = await lookup(req.params.id);
  if ('missing' in found) return notFound(res, req.params.id);
  const { connection, adapter } = found;
  if (!connection.credentials?.secret) return res.json({ ok: false, error: { reason: 'no_credential' } });
  if (connection.providerType === 'sap-ai-core') {
    const result = await testSapConnection(connection);
    logger.info('ConnectionAdmin', `Connection ${connection.name} test: ${result.ok ? 'ok' : result.error.reason}`);
    return res.json(result);
  }
  if (!adapter) return res.json({ ok: false, error: { reason: 'not_supported' } });
  const result = await adapter.testConnection();
  logger.info('ConnectionAdmin', `Connection ${connection.name} test: ${result.ok ? 'ok' : result.error.reason}`);
  return res.json(result);
}

async function modelsRoute(req: express.Request, res: express.Response) {
  const found = await lookup(req.params.id);
  if ('missing' in found) return notFound(res, req.params.id);
  const { connection, adapter } = found;
  if (!connection.credentials?.secret) return res.status(409).json({ error: 'no_credential', message: 'The connection has no credential' });
  if (!adapter) return res.status(501).json({ error: 'not_supported', message: `Provider type ${connection.providerType} is not served yet` });
  try {
    return res.json({ models: await adapter.listModels() });
  } catch (error: any) {
    const result = typeof error?.status === 'number' ? resultOf({ status: error.status, data: undefined } as any) : failureOf(error);
    const failure = result.ok ? { reason: 'upstream_error' as const } : result.error;
    logger.warn('ConnectionAdmin', `Connection ${connection.name} model list failed: ${failure.reason}`);
    return res.status(502).json({ error: failure.reason, ...(failure.status ? { status: failure.status } : {}) });
  }
}

/** A standalone gateway's file is read again at once, not at the next TTL. */
async function reloadRoute(_req: express.Request, res: express.Response) {
  connectionRegistry.markStale();
  await connectionRegistry.ensureFresh();
  const connections = connectionRegistry.connections().length;
  const models = connectionRegistry.publishedModels().length;
  logger.info('ConnectionAdmin', `Connections reloaded: ${connections} connection(s), ${models} published model(s)`);
  res.json({ connections, models });
}

/** The handlers behind `auth`; a standalone gateway adds the reload route. */
function buildRouter(auth: express.RequestHandler, withReload: boolean): express.Router {
  const router = express.Router();
  router.use(auth);
  if (withReload) router.post('/reload', reloadRoute);
  router.post('/:id/test', testRoute);
  router.get('/:id/models', modelsRoute);
  return router;
}

export function mountConnectionAdminRoutes(app: express.Application): boolean {
  app.use(CONNECTIONS_ADMIN_PATH, isStandaloneMode() ? buildRouter(gatewayStandaloneOnlyAuth, true) : buildRouter(gatewayStandaloneOrServiceKeyAuth, false));
  return true;
}
