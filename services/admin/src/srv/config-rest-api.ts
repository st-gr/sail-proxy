import express from 'express';
import { getDefaultLogger } from '@libs/logger';
import { notificationStreamService } from './notification-stream';

const cds = require('@sap/cds');
const logger = getDefaultLogger();
const router: express.Router = express.Router();

// Extend Request interface for user property
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        roles?: string[];
        scope?: string[];
        attr?: any;
        tenant?: string;
        locale?: string;
        is?: (role: string) => boolean;
        _roles?: string[];
      };
    }
  }
}

/**
 * Simple REST endpoint for Gateway service configuration retrieval
 * Provides backward compatibility with existing Gateway service
 */

/**
 * GET /api/admin/health
 * Simple health check for REST API
 */
router.get('/health', async (req, res) => {
  try {
    logger.info('ConfigEndpoint', '🩺 REST API health check called');
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      message: 'Admin REST API is working'
    });
  } catch (error) {
    logger.error('ConfigEndpoint', 'Health check failed', error as Error);
    res.status(500).json({
      status: 'error',
      message: 'Health check failed'
    });
  }
});

/**
 * GET /api/admin/api-config
 * Returns active configuration
 */
router.get('/api-config', async (req, res) => {
  try {
    logger.info('ConfigEndpoint', '🔍 REST API /api-config called', {
      user: req.user?.id,
      method: req.method,
      url: req.url
    });
    
    // Check if CDS services are available
    if (!cds.services) {
      logger.error('ConfigEndpoint', 'CDS services not available');
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'CDS services not initialized'
      });
    }
    
    logger.info('ConfigEndpoint', `Available CDS services: ${Object.keys(cds.services)}`);
    
    // Get CDS service
    const { AdminService } = cds.services;
    
    if (!AdminService) {
      logger.error('ConfigEndpoint', 'AdminService not found in cds.services');
      return res.status(503).json({
        error: 'Service unavailable', 
        message: 'AdminService not initialized'
      });
    }
    
    logger.info('ConfigEndpoint', 'Calling AdminService with user context', {
      user: req.user?.id,
      roles: req.user?.roles,
      hasUserContext: !!req.user
    });
    
    // Call the configuration service with proper user context
    let result;
    if (req.user) {
      // Use CDS.context to run with user context for authenticated requests
      const context = { user: req.user };
      result = await cds.run(async () => {
        return await AdminService.send('getActiveConfiguration');
      }, context);
    } else {
      // Fallback to system user for non-authenticated calls (should not happen in docker mode)
      result = await AdminService.send('getActiveConfiguration');
    }
    
    logger.info('ConfigEndpoint', 'AdminService response received', {
      success: result?.success,
      hasData: !!result?.data
    });
    
    if (!result.success) {
      logger.warn('ConfigEndpoint', 'No active configuration found');
      return res.status(404).json({
        error: 'No active configuration found'
      });
    }

    // Return in format expected by Gateway service
    // The configData already contains the proper structure with api_config wrapper
    const response = JSON.parse(result.data.configData);

    // Add metadata headers for change detection
    res.set({
      'X-Config-Version': result.data.version,
      'X-Config-Checksum': result.data.checksum,
      'X-Config-Deployed-At': result.data.deployedAt?.toISOString(),
      'ETag': `"${result.data.checksum}"`
    });

    logger.info('ConfigEndpoint', '✅ Configuration served successfully', {
      version: result.data.version,
      checksum: result.data.checksum.substring(0, 8)
    });

    return res.json(response);
  } catch (error) {
    logger.error('ConfigEndpoint', '❌ Failed to get configuration', error as Error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve configuration'
    });
  }
});

/**
 * PUT /api/admin/api-config  
 * Update configuration (for backward compatibility)
 * This endpoint creates a new configuration version and activates it
 */
router.put('/api-config', async (req, res) => {
  try {
    const { api_config } = req.body;
    const user = req.user?.id || 'system';
    
    if (!api_config) {
      return res.status(400).json({
        error: 'Missing api_config in request body'
      });
    }

    // Get CDS service
    const { AdminService } = cds.services;
    
    // Create new configuration with user context
    let createResult;
    if (req.user) {
      const context = { user: req.user };
      createResult = await cds.run(async () => {
        return await AdminService.send('createConfiguration', {
          name: `Config-${new Date().toISOString()}`,
          configData: JSON.stringify({ api_config }),
          description: 'Updated via REST API'
        });
      }, context);
    } else {
      createResult = await AdminService.send('createConfiguration', {
        name: `Config-${new Date().toISOString()}`,
        configData: JSON.stringify({ api_config }),
        description: 'Updated via REST API'
      });
    }

    if (!createResult.success) {
      logger.warn('ConfigEndpoint', 'Configuration validation failed', {
        errors: createResult.errors,
        warnings: createResult.warnings
      });
      return res.status(400).json({
        error: 'Configuration validation failed',
        errors: createResult.errors,
        warnings: createResult.warnings
      });
    }

    // Activate the new configuration with user context
    let activateResult;
    if (req.user) {
      const context = { user: req.user };
      activateResult = await cds.run(async () => {
        return await AdminService.send('activateConfiguration', {
          configId: createResult.configId
        });
      }, context);
    } else {
      activateResult = await AdminService.send('activateConfiguration', {
        configId: createResult.configId
      });
    }

    if (!activateResult.success) {
      logger.error('ConfigEndpoint', 'Failed to activate configuration', {
        configId: createResult.configId,
        error: activateResult.error
      } as any);
      return res.status(500).json({
        error: 'Failed to activate configuration',
        message: activateResult.error
      });
    }

    logger.info('ConfigEndpoint', 'Configuration updated successfully', {
      version: activateResult.version,
      user
    });

    return res.json({
      success: true,
      version: activateResult.version,
      checksum: activateResult.checksum,
      activatedAt: activateResult.activatedAt,
      warnings: createResult.warnings
    });
  } catch (error) {
    logger.error('ConfigEndpoint', 'Failed to update configuration', error as Error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update configuration'
    });
  }
});

/**
 * POST /api/admin/api-config/rollback
 * Rollback to previous configuration
 */
router.post('/api-config/rollback', async (req, res) => {
  try {
    const { reason } = req.body;
    
    // Get CDS service
    const { AdminService } = cds.services;
    
    let result;
    if (req.user) {
      const context = { user: req.user };
      result = await cds.run(async () => {
        return await AdminService.send('rollbackConfiguration', {
          reason: reason || 'Manual rollback via REST API'
        });
      }, context);
    } else {
      result = await AdminService.send('rollbackConfiguration', {
        reason: reason || 'Manual rollback via REST API'
      });
    }

    if (!result.success) {
      return res.status(400).json({
        error: result.error
      });
    }

    logger.info('ConfigEndpoint', 'Configuration rolled back', {
      from: result.rolledBackFrom,
      to: result.rolledBackTo,
      reason: result.reason
    });

    return res.json(result);
  } catch (error) {
    logger.error('ConfigEndpoint', 'Failed to rollback configuration', error as Error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to rollback configuration'
    });
  }
});

/**
 * GET /api/admin/api-config/status
 * Get configuration service status
 */
router.get('/api-config/status', async (req, res) => {
  try {
    // Get CDS service
    const { AdminService } = cds.services;
    
    let result;
    if (req.user) {
      const context = { user: req.user };
      result = await cds.run(async () => {
        return await AdminService.send('getConfigurationStatus');
      }, context);
    } else {
      result = await AdminService.send('getConfigurationStatus');
    }
    
    if (!result.success) {
      return res.status(500).json({
        error: result.error
      });
    }

    return res.json(result.status);
  } catch (error) {
    logger.error('ConfigEndpoint', 'Failed to get configuration status', error as Error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get configuration status'
    });
  }
});

/**
 * Detect identity provider based on environment and request headers
 */
function detectIdentityProvider(req: any) {
  const deployTarget = process.env.DEPLOY_TARGET || 'development';
  
  // Auto-detect based on deployment target and available headers/config
  switch (deployTarget) {
    case 'development':
      return { provider: 'basic-auth', deployTarget };
    
    case 'docker':
      // Check for oauth2-proxy headers to determine the upstream provider
      const oidcIssuer = process.env.OAUTH2_PROXY_OIDC_ISSUER_URL || '';
      if (oidcIssuer.includes('github')) {
        return { provider: 'github', deployTarget };
      } else if (oidcIssuer.includes('okta')) {
        return { provider: 'okta', deployTarget };
      } else if (req.headers['x-auth-request-email']) {
        // Generic OIDC/OAuth2 provider
        return { provider: 'oidc', deployTarget };
      } else {
        return { provider: 'local', deployTarget };
      }
    
    case 'xsa':
      return { provider: 'xsa', deployTarget };
    
    case 'xsuaa':
    case 'btp':
      return { provider: 'xsuaa', deployTarget };
    
    default:
      return { provider: 'unknown', deployTarget };
  }
}

/**
 * POST /api/admin/logout
 * Universal logout endpoint with automatic IdP detection
 * Uses single LOGOUT_REDIRECT_URL for all scenarios
 */
router.post('/logout', async (req, res) => {
  try {
    const { provider, deployTarget } = detectIdentityProvider(req);
    // Use BASE_URL for correct public URL, fallback to constructed URL for development
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const logoutRedirectUrl = process.env.LOGOUT_REDIRECT_URL || `${baseUrl}/admin/shell/index.html`;
    
    logger.info('LogoutEndpoint', '🚪 Logout requested', {
      user: req.user?.id,
      email: req.user?.email,
      provider,
      deployTarget,
      logoutRedirectUrl,
      userAgent: req.headers['user-agent']
    });
    
    // Handle logout based on detected provider
    if (provider === 'basic-auth') {
      // Development mode - clear session cleanly without Basic Auth challenge
      if ((req as any).session && typeof (req as any).session.destroy === 'function') {
        await new Promise<void>((resolve) => {
          (req as any).session.destroy((err: any) => {
            if (err) {
              logger.warn('LogoutEndpoint', 'Failed to destroy session', err);
            }
            resolve();
          });
        });
      }
      
      // Clear session cookie and browser storage
      res.clearCookie('cap.sid', {
        path: '/',
        httpOnly: true,
        sameSite: 'lax'
      });
      res.setHeader('Clear-Site-Data', '"cookies", "storage"');
      res.setHeader('Cache-Control', 'no-store');
      
      logger.info('LogoutEndpoint', '✅ Development logout completed (Basic Auth cache limitation noted)');
      
      // Clean logout response without WWW-Authenticate header to avoid browser popup loop
      res.json({
        success: true,
        action: 'redirect',
        redirectUrl: logoutRedirectUrl,
        message: 'Development logout complete. Session cleared.',
        devNote: 'Note: HTTP Basic Auth credentials remain cached by browser. Use incognito mode for clean testing.',
        provider: 'basic-auth'
      });
      return;
    }
    
    // Check if we should use OAuth2-proxy logout flow
    // Only use OAuth2-proxy if we're in Docker mode AND using an OAuth provider
    // AND the user hasn't set a custom LOGOUT_REDIRECT_URL (i.e., using default shell URLs)
    const isDefaultShellUrl = process.env.LOGOUT_REDIRECT_URL && (
      process.env.LOGOUT_REDIRECT_URL.includes('/admin/shell/') ||
      process.env.LOGOUT_REDIRECT_URL.includes('/admin/app/shell/')
    );
    const hasCustomLogoutUrl = process.env.LOGOUT_REDIRECT_URL && !isDefaultShellUrl;
    
    if (deployTarget === 'docker' && 
        (provider === 'github' || provider === 'okta' || provider === 'oidc') &&
        !hasCustomLogoutUrl) {
      // OAuth-based authentication has inherent logout limitations:
      // - OAuth2-proxy can only clear its own session
      // - GitHub OAuth authorization persists (app remains authorized)
      // - Automatic re-authentication occurs when revisiting the app
      // 
      // This is expected behavior for OAuth systems - not a bug
      const oauth2LogoutUrl = `/auth/sign_out?rd=${encodeURIComponent(logoutRedirectUrl)}`;
      
      res.json({
        success: true,
        action: 'redirect',
        redirectUrl: oauth2LogoutUrl,
        message: 'OAuth2-proxy session cleared. Note: OAuth-based authentication has inherent logout limitations.',
        limitation: 'To switch GitHub accounts, you must manually revoke app authorization at github.com/settings/applications/authorized',
        provider
      });
    } else {
      // Respect user's custom logout URL or use default behavior for other providers
      res.json({
        success: true,
        action: 'redirect',
        redirectUrl: logoutRedirectUrl,
        message: 'Redirecting to configured logout URL.',
        provider
      });
    }
    
    // Log the logout action for audit purposes
    logger.info('LogoutEndpoint', '✅ Logout completed', {
      user: req.user?.id,
      provider,
      deployTarget,
      success: true
    });
    
  } catch (error) {
    logger.error('LogoutEndpoint', '❌ Logout failed', error as Error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to process logout request'
    });
  }
});

/**
 * SSE endpoint for real-time notifications
 * GET /api/notifications/stream
 */
router.get('/notifications/stream', notificationStreamService.handleConnection);

// Export the router
module.exports = router;

export default router;