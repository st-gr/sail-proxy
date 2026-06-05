/**
 * Routes for API configuration management
 */
import * as express from 'express';
import * as configController from '../controllers/configController';
import { gatewayStandaloneOrServiceKeyAuth } from '../middlewares/gatewayServiceAuth';
import rateLimitManager from '../services/rateLimitManager';

const router: express.Router = express.Router();

// Apply standalone OR service key authentication to all routes
router.use(gatewayStandaloneOrServiceKeyAuth);

// GET /api-config - Get the current API configuration
router.get('/', configController.getConfig);

// PUT /api-config - Update the entire API configuration
router.put('/', configController.updateConfig);

// PATCH /api-config - Update parts of the API configuration
router.patch('/', configController.patchConfig);

// POST /api-config/reset - Reset the API configuration to defaults
router.post('/reset', configController.resetConfig);

// Add rate limit status endpoint
router.get('/rate-limits', (_req, res) => {
  try {
    const status = rateLimitManager.getStatus();
    res.json({
      status: 'success',
      data: status,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.delete('/rate-limits', (_req, res) => {
  try {
    rateLimitManager.clearAllRateLimits();
    res.json({
      status: 'success',
      message: 'All rate limits cleared',
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Add deployment status endpoint for monitoring and debugging
router.get('/deployment-status', async (_req, res) => {
  try {
    // Import deployment service dynamically
    const deploymentService = await import('../services/deploymentDiscoveryService');
    const configService = await import('../services/configService');
    
    const sapConfig = configService.getSAPAICoreConfig();
    const cacheStatus = deploymentService.getCacheStatus();
    const deploymentIdCacheStatus = configService.getDeploymentIdCacheStatus();
    
    let currentDeploymentId = null;
    let deploymentError = null;
    
    try {
      currentDeploymentId = await configService.getDeploymentId();
    } catch (error: any) {
      deploymentError = error.message;
    }
    
    let availableDeployments: any[] = [];
    let discoveryError: string | null = null;
    
    if (sapConfig.autoDiscoverDeployment) {
      try {
        availableDeployments = await deploymentService.getOrchestrationDeployments();
      } catch (error: any) {
        discoveryError = error.message;
      }
    }
    
    res.json({
      status: 'success',
      data: {
        configuration: {
          autoDiscoveryEnabled: sapConfig.autoDiscoverDeployment,
          manualDeploymentId: sapConfig.deploymentId,
          currentDeploymentId,
          deploymentError
        },
        discovery: {
          availableDeployments: availableDeployments.map(d => ({
            id: d.id,
            configurationName: d.configurationName,
            status: d.status,
            scenarioId: d.scenarioId,
            createdAt: d.createdAt,
            deploymentUrl: d.deploymentUrl
          })),
          discoveryError,
          cacheStatus
        },
        caching: {
          deploymentIdCache: deploymentIdCacheStatus
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;