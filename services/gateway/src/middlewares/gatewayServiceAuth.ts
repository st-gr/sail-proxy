/**
 * Gateway Service Authentication Middleware
 * 
 * Integrates the shared service-auth library with Gateway's existing
 * authentication infrastructure and isStandaloneMode configuration.
 */

import { Response, NextFunction } from 'express';
import { 
  standaloneOnlyAuth,
  standaloneOrServiceKeyAuth,
  initializeServiceAuth,
  AuthenticatedRequest,
  ServiceAuthMiddleware 
} from '../../../../libs/service-auth';
import { isStandaloneMode } from '../config/unifiedAuthConfig';
import { unifiedApiKeyValidationService } from '../services/unifiedApiKeyValidationService';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Initialize service auth with gateway's standalone mode check
initializeServiceAuth(isStandaloneMode);

/**
 * API key validator function for service auth middleware
 * Integrates with Gateway's existing API key validation service
 */
// Store current request context for validation
let currentRequestContext: AuthenticatedRequest | undefined;

async function validateApiKeyForServiceAuth(apiKey: string) {
  try {
    if (!apiKey) return null;
    
    // Use unified validation service which properly calls admin service when not in standalone mode
    // Get the full endpoint path
    const endpoint = currentRequestContext?.originalUrl?.split('?')[0] || 
                    (currentRequestContext?.baseUrl && currentRequestContext?.path ? 
                     currentRequestContext.baseUrl + currentRequestContext.path : 
                     currentRequestContext?.path) || '/api/admin/api-config';
    
    const validationRequest = {
      apiKey,
      clientIp: currentRequestContext?.ip || 'unknown', // Use actual client IP from request
      method: currentRequestContext?.method || 'GET',
      endpoint, // Use actual endpoint being accessed
      userAgent: currentRequestContext?.get('User-Agent') || 'Gateway-Service-Auth'
    };
    
    const validationResult = await unifiedApiKeyValidationService.validateApiKey(validationRequest);
    
    if (!validationResult.valid || !validationResult.data) {
      return null;
    }
    
    // Convert unified validation result to format expected by service auth
    return {
      id: validationResult.data.keyId,
      key: apiKey,
      name: validationResult.data.name,
      email: validationResult.data.email, // Now properly retrieved from admin service
      isActive: true, // If validation passed, it's active
      permissions: validationResult.data.permissions || [],
      endpoints: [], // Will be populated by service auth validation
    };
  } catch (error) {
    logger.error('GatewayServiceAuth', 'API key validation error:', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Middleware that only allows access in standalone mode
 * For endpoints: /api/admin/api-keys, /aws/api-keys
 */
export const gatewayStandaloneOnlyAuth = standaloneOnlyAuth();

/**
 * Middleware that allows access in standalone mode OR with valid service key
 * For endpoint: /api/admin/api-config
 */
/**
 * Create a context-aware middleware that captures request information
 */
function createContextAwareMiddleware(middlewareFactory: any): ServiceAuthMiddleware {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    // Set the current request context for the validator
    currentRequestContext = req;
    
    try {
      // Create and execute the middleware with the validator
      const middleware = middlewareFactory(validateApiKeyForServiceAuth);
      await middleware(req, res, next);
    } finally {
      // Clear the context
      currentRequestContext = undefined;
    }
  };
}

export const gatewayStandaloneOrServiceKeyAuth = createContextAwareMiddleware(standaloneOrServiceKeyAuth);

/**
 * Utility function to add service auth context to request
 * Can be used for debugging or additional context in other middleware
 */
export function addGatewayServiceAuthContext(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Add gateway-specific context if needed
  if (req.serviceAuth) {
    req.serviceAuth.isStandalone = isStandaloneMode();
  }
  next();
}