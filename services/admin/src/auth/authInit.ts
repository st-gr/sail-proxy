import { createAuthMiddleware } from '../middleware/authMiddleware';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

/**
 * Initialize authentication for CAP service based on deployment target
 * Supports multiple deployment modes:
 * - development: CAP mocked authentication
 * - docker: JWT via oauth2-proxy + Dex
 * - xsuaa/btp: SAP BTP XSUAA JWT authentication
 * - xsa: HANA XSA authentication
 */
export function initializeAuthentication(app: any): void {
  const deployTarget = process.env.DEPLOY_TARGET || 'development';
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  logger.info('AuthInit', `Initializing authentication for deployment target: ${deployTarget}, NODE_ENV: ${nodeEnv}`);

  // Only apply custom middleware for Docker deployment
  // Other deployment targets use CAP's native authentication
  if (deployTarget === 'docker') {
    logger.info('AuthInit', 'Setting up Docker JWT authentication middleware');
    
    // Apply auth middleware before CAP request handling
    // This middleware will validate JWT tokens from oauth2-proxy
    app.use(createAuthMiddleware());
    
    logger.info('AuthInit', 'Docker JWT authentication middleware initialized');
  } else {
    logger.info('AuthInit', `Using CAP native authentication for deployment target: ${deployTarget}`);
    
    // For other deployment targets (development, xsuaa, xsa), 
    // CAP's native authentication configuration in package.json will be used
    // 
    // Development: uses mocked users from cds.requires.auth[development]
    // XSUAA/BTP: uses JWT validation against XSUAA
    // XSA: uses XS authentication
  }
}

/**
 * Post-authentication setup for enhanced user context
 * This runs after CAP has processed authentication but before business logic
 */
export function setupUserContext(srv: any): void {
  const deployTarget = process.env.DEPLOY_TARGET || 'development';
  
  // Add before handlers to enhance user context if needed
  srv.before('*', (req: any) => {
    // Log authentication context for debugging
    if (req.user) {
      logger.info('AuthContext', `[RBAC DEBUG] User authenticated: ${req.user.id || req.user.email}`, {
        roles: req.user.roles,
        deployTarget,
        email: req.user.email,
        userObject: req.user
      });
      
      // Specific logging for the problematic user
      if ((req.user.email === 'user@example.com' || req.user.id === 'user@example.com')) {
        logger.warn('AuthContext', `[RBAC ISSUE] user@example.com detected with roles:`, {
          roles: req.user.roles,
          hasAdminRole: req.user.roles?.includes('admin'),
          hasUserRole: req.user.roles?.includes('user'),
          allProperties: Object.keys(req.user),
          fullUser: req.user
        });
      }
    } else {
      logger.warn('AuthContext', `[RBAC DEBUG] No user context found for request: ${req.method} ${req.path}`);
    }
    
    // For XSUAA deployments, we might need additional role mapping
    if (deployTarget === 'xsuaa' || deployTarget === 'btp') {
      enhanceXsuaaUserContext(req);
    }
  });
}

/**
 * Enhanced user context for XSUAA deployments
 * Maps XSUAA scopes to application roles if needed
 */
function enhanceXsuaaUserContext(req: any): void {
  if (!req.user || !req.user.scope) {
    return;
  }

  // XSUAA provides scopes, map them to roles if needed
  // This allows for consistent role checking across deployment targets
  if (!req.user.roles) {
    req.user.roles = req.user.scope;
  }

  // Apply role mapping if configured
  const roleMappingEnv = process.env.ROLE_MAPPING;
  if (roleMappingEnv) {
    try {
      const roleMapping = JSON.parse(roleMappingEnv);
      const mappedRoles: string[] = [];
      
      for (const scope of req.user.scope) {
        const mappedRole = roleMapping[scope];
        if (mappedRole) {
          mappedRoles.push(mappedRole);
        }
      }
      
      if (mappedRoles.length > 0) {
        req.user.roles = [...new Set([...req.user.roles, ...mappedRoles])];
        logger.debug('AuthContext', 'Enhanced XSUAA user context with role mapping', {
          originalScopes: req.user.scope,
          mappedRoles: req.user.roles
        });
      }
    } catch (error) {
      logger.warn('AuthContext', 'Failed to parse ROLE_MAPPING for XSUAA enhancement', error as Error);
    }
  }
}

/**
 * Utility function to check if custom JWT authentication is active
 * Used by other parts of the application to determine auth mode
 */
export function isCustomJwtAuthActive(): boolean {
  return process.env.DEPLOY_TARGET === 'docker';
}

/**
 * Utility function to get current authentication mode
 */
export function getAuthenticationMode(): string {
  const deployTarget = process.env.DEPLOY_TARGET || 'development';
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  switch (deployTarget) {
    case 'docker':
      return 'docker-jwt';
    case 'xsuaa':
    case 'btp':
      return 'xsuaa';
    case 'xsa':
      return 'xsa';
    default:
      return nodeEnv === 'development' ? 'mocked' : 'cap-jwt';
  }
}