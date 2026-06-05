/**
 * Service Authentication Middleware
 * 
 * Express middleware functions for protecting endpoints with service-to-service
 * authentication including standalone mode checking and service key validation.
 */

import { Response, NextFunction } from 'express';
import { 
  AuthenticatedRequest, 
  ServiceAuthContext, 
  ServiceAuthMiddleware, 
  ServiceAuthOptions,
  AuthMode 
} from './types';
import { 
  requiresStandaloneOnly, 
  allowsServiceKeyAuth,
  getEndpointAuthRule,
  getRequiredServiceKeyType 
} from './service-keys';
import { 
  extractApiKey, 
  validateServiceKey, 
  createAuthErrorResponse,
  logAuthEvent,
  validateRequestContext 
} from './validators';
import { getDefaultLogger } from '../logger';

const logger = getDefaultLogger();

// Import isStandaloneMode from gateway config
// Note: This will need to be imported from the gateway service
let isStandaloneMode: () => boolean;

/**
 * Initialize service auth with dependencies
 * This allows us to inject the isStandaloneMode function from gateway config
 */
export function initializeServiceAuth(standaloneCheck: () => boolean): void {
  isStandaloneMode = standaloneCheck;
}

/**
 * Middleware that only allows access in standalone mode
 */
export function standaloneOnlyAuth(): ServiceAuthMiddleware {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { endpoint } = validateRequestContext(req);
      
      // Check if we're in standalone mode
      if (!isStandaloneMode || !isStandaloneMode()) {
        logAuthEvent('failure', {
          endpoint,
          authType: 'none',
          error: 'standalone_required',
          clientIp: req.ip,
          userAgent: req.get('User-Agent'),
        });
        
        const errorResponse = createAuthErrorResponse('standalone_required', 403);
        res.status(errorResponse.status).json({
          error: errorResponse.error,
          message: errorResponse.message,
        });
        return;
      }
      
      // Set auth context
      req.serviceAuth = {
        authType: 'standalone',
        isStandalone: true,
        permissions: ['*'], // Standalone mode has all permissions
      };
      
      logAuthEvent('success', {
        endpoint,
        authType: 'standalone',
        clientIp: req.ip,
        userAgent: req.get('User-Agent'),
      });
      
      next();
    } catch (error) {
      logger.error('ServiceAuth', 'Standalone auth error:', error as Error);
      res.status(500).json({
        error: 'internal_error',
        message: 'Authentication system error',
      });
      return;
    }
  };
}

/**
 * Middleware that requires a valid service API key
 */
export function serviceKeyAuth(
  allowedServiceKeys?: string[],
  apiKeyValidator?: (apiKey: string) => Promise<any>
): ServiceAuthMiddleware {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { endpoint, apiKey } = validateRequestContext(req);
      
      if (!apiKey) {
        logAuthEvent('failure', {
          endpoint,
          authType: 'none',
          error: 'missing_api_key',
          clientIp: req.ip,
          userAgent: req.get('User-Agent'),
        });
        
        const errorResponse = createAuthErrorResponse('missing_api_key', 401);
        res.status(errorResponse.status).json({
          error: errorResponse.error,
          message: errorResponse.message,
        });
        return;
      }
      
      // Validate API key using provided validator or default logic
      let validatedApiKey;
      if (apiKeyValidator) {
        try {
          validatedApiKey = await apiKeyValidator!(apiKey);
          if (!validatedApiKey) {
            throw new Error('API key validation failed');
          }
        } catch (error) {
          logAuthEvent('failure', {
            endpoint,
            authType: 'service-key',
            error: 'invalid_service_key',
            clientIp: req.ip,
            userAgent: req.get('User-Agent'),
          });
          
          const errorResponse = createAuthErrorResponse('invalid_service_key', 403);
          res.status(errorResponse.status).json({
            error: errorResponse.error,
            message: errorResponse.message,
          });
          return;
        }
      } else {
        // Default validation - will need to be connected to actual API key service
        logAuthEvent('failure', {
          endpoint,
          authType: 'service-key',
          error: 'no_validator_provided',
          clientIp: req.ip,
          userAgent: req.get('User-Agent'),
        });
        
        res.status(500).json({
          error: 'configuration_error',
          message: 'API key validator not configured',
        });
        return;
      }
      
      // Validate service key for this endpoint
      const validationResult = validateServiceKey(validatedApiKey, endpoint);
      if (!validationResult.isValid || !validationResult.isAuthorized) {
        logAuthEvent('failure', {
          endpoint,
          authType: 'service-key',
          serviceKeyEmail: validatedApiKey.email,
          error: 'invalid_service_key',
          clientIp: req.ip,
          userAgent: req.get('User-Agent'),
        });
        
        const errorResponse = createAuthErrorResponse('invalid_service_key', 403);
        res.status(errorResponse.status).json({
          error: errorResponse.error,
          message: validationResult.error || errorResponse.message,
        });
        return;
      }
      
      // Set auth context
      req.serviceAuth = {
        authType: 'service-key',
        serviceKey: validationResult.serviceKey,
        isStandalone: false,
        permissions: validationResult.serviceKey?.permissions || [],
      };
      
      logAuthEvent('success', {
        endpoint,
        authType: 'service-key',
        serviceKeyEmail: validatedApiKey.email,
        clientIp: req.ip,
        userAgent: req.get('User-Agent'),
      });
      
      next();
    } catch (error) {
      logger.error('ServiceAuth', 'Service key auth error:', error as Error);
      res.status(500).json({
        error: 'internal_error',
        message: 'Authentication system error',
      });
      return;
    }
  };
}

/**
 * Middleware that allows access in standalone mode OR with valid service key
 */
export function standaloneOrServiceKeyAuth(
  apiKeyValidator?: (apiKey: string) => Promise<any>
): ServiceAuthMiddleware {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { endpoint, apiKey } = validateRequestContext(req);
      
      // Check standalone mode first
      if (isStandaloneMode && isStandaloneMode()) {
        req.serviceAuth = {
          authType: 'standalone',
          isStandalone: true,
          permissions: ['*'],
        };
        
        logAuthEvent('success', {
          endpoint,
          authType: 'standalone',
          clientIp: req.ip,
          userAgent: req.get('User-Agent'),
        });
        
        return next();
      }
      
      // If not standalone, require service key
      if (!apiKey) {
        logAuthEvent('failure', {
          endpoint,
          authType: 'none',
          error: 'service_key_required',
          clientIp: req.ip,
          userAgent: req.get('User-Agent'),
        });
        
        const errorResponse = createAuthErrorResponse('service_key_required', 401);
        res.status(errorResponse.status).json({
          error: errorResponse.error,
          message: errorResponse.message,
        });
        return;
      }
      
      // Validate service key
      if (!apiKeyValidator) {
        res.status(500).json({
          error: 'configuration_error',
          message: 'API key validator not configured',
        });
        return;
      }
      
      let validatedApiKey;
      try {
        validatedApiKey = await apiKeyValidator!(apiKey);
        if (!validatedApiKey) {
          throw new Error('API key validation failed');
        }
      } catch (error) {
        logAuthEvent('failure', {
          endpoint,
          authType: 'service-key',
          error: 'invalid_service_key',
          clientIp: req.ip,
          userAgent: req.get('User-Agent'),
        });
        
        const errorResponse = createAuthErrorResponse('invalid_service_key', 403);
        res.status(errorResponse.status).json({
          error: errorResponse.error,
          message: errorResponse.message,
        });
        return;
      }
      
      // Validate service key for this endpoint
      const validationResult = validateServiceKey(validatedApiKey, endpoint);
      if (!validationResult.isValid || !validationResult.isAuthorized) {
        logAuthEvent('failure', {
          endpoint,
          authType: 'service-key',
          serviceKeyEmail: validatedApiKey.email,
          error: 'invalid_service_key',
          clientIp: req.ip,
          userAgent: req.get('User-Agent'),
        });
        
        const errorResponse = createAuthErrorResponse('invalid_service_key', 403);
        res.status(errorResponse.status).json({
          error: errorResponse.error,
          message: validationResult.error || errorResponse.message,
        });
        return;
      }
      
      // Set auth context
      req.serviceAuth = {
        authType: 'service-key',
        serviceKey: validationResult.serviceKey,
        isStandalone: false,
        permissions: validationResult.serviceKey?.permissions || [],
      };
      
      logAuthEvent('success', {
        endpoint,
        authType: 'service-key',
        serviceKeyEmail: validatedApiKey.email,
        clientIp: req.ip,
        userAgent: req.get('User-Agent'),
      });
      
      next();
    } catch (error) {
      logger.error('ServiceAuth', 'Combined auth error:', error as Error);
      res.status(500).json({
        error: 'internal_error',
        message: 'Authentication system error',
      });
      return;
    }
  };
}

/**
 * Factory function to create custom service authentication middleware
 */
export function createServiceAuthMiddleware(
  options: ServiceAuthOptions,
  apiKeyValidator?: (apiKey: string) => Promise<any>
): ServiceAuthMiddleware {
  switch (options.mode) {
    case 'STANDALONE_ONLY':
      return standaloneOnlyAuth();
    
    case 'SERVICE_KEY_ONLY':
      return serviceKeyAuth(options.allowedServiceKeys, apiKeyValidator);
    
    case 'STANDALONE_OR_SERVICE_KEY':
      return standaloneOrServiceKeyAuth(apiKeyValidator);
    
    case 'ALWAYS_ALLOW':
      return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        req.serviceAuth = {
          authType: 'none',
          isStandalone: false,
          permissions: [],
        };
        next();
      };
    
    default:
      throw new Error(`Unknown auth mode: ${options.mode}`);
  }
}

/**
 * Utility middleware to add service auth context to request
 */
export function addServiceAuthContext(): ServiceAuthMiddleware {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.serviceAuth) {
      req.serviceAuth = {
        authType: 'none',
        isStandalone: isStandaloneMode ? isStandaloneMode() : false,
        permissions: [],
      };
    }
    next();
  };
}