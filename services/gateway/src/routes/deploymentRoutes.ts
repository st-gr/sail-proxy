/**
 * /api/admin/deployments — SAP AI Core deployment management for the admin's Model Library.
 * Service-key (ADMIN_TO_GATEWAY with deployments:read/write) or standalone mode, like api-config.
 */
import * as express from 'express';
import * as deploymentController from '../controllers/deploymentController';
import { gatewayStandaloneOrServiceKeyAuth } from '../middlewares/gatewayServiceAuth';
import { isStandaloneMode } from '../config/unifiedAuthConfig';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

const router: express.Router = express.Router();
router.use(gatewayStandaloneOrServiceKeyAuth);
router.get('/', deploymentController.list);
router.post('/', deploymentController.create);
router.get('/:id', deploymentController.status);

export const DEPLOYMENTS_PATH = '/api/admin/deployments';

/**
 * Mount the deployment routes, unless this gateway runs standalone.
 *
 * In standalone mode gatewayStandaloneOrServiceKeyAuth grants every request the '*' permission
 * set without any credential at all, which would leave POST /api/admin/deployments - an endpoint
 * that creates a billed SAP AI Core deployment - open to anyone who can reach the process. A
 * standalone gateway has no admin cockpit and therefore no reason to serve it, so it is not
 * mounted rather than being served unauthenticated.
 *
 * Returns whether the routes were mounted, which is what makes the decision testable without
 * booting index.ts.
 */
export function mountDeploymentRoutes(app: express.Application): boolean {
  if (isStandaloneMode()) {
    logger.info('Gateway Service', `Standalone mode - ${DEPLOYMENTS_PATH} not mounted (no admin service, and the endpoint would be unauthenticated)`);
    return false;
  }
  app.use(DEPLOYMENTS_PATH, router);
  return true;
}

export default router;
