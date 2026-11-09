/**
 * Service Authentication Validators
 * 
 * Core validation logic for service keys, permissions, and endpoint access.
 * Provides utilities for validating service-to-service authentication.
 */

import { 
  ValidatedServiceApiKey, 
  ServiceKeyValidationResult,
  AuthenticatedRequest 
} from './types';
import { 
  isServiceKeyEmail, 
  findServiceKeyByEmail, 
  isServiceKeyAuthorizedForEndpoint,
  validateServiceKeyPermissions,
  isValidServiceApiKeyFormat 
} from './service-keys';
import { getDefaultLogger } from '../logger';

const logger = getDefaultLogger();

/**
 * Extract API key from request headers or query parameters
 */
export function extractApiKey(req: AuthenticatedRequest): string | null {
  // Check headers (in order of preference)
  const apiKey = req.headers['x-api-key'] || 
                 req.headers['x-stainless-key'] || 
                 req.query.api_key;
  
  if (typeof apiKey === 'string') {
    // Handle Bearer token format
    if (apiKey.startsWith('Bearer ') && apiKey.substring(7).startsWith('sk-')) {
      return apiKey.substring(7);
    }
    return apiKey;
  }
  
  // Check Authorization header for Bearer tokens
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && authHeader.substring(7).startsWith('sk-')) {
    return authHeader.substring(7);
  }
  
  return null;
}

/**
 * Validate if an API key belongs to a service key
 */
export function validateServiceKey(
  apiKey: ValidatedServiceApiKey,
  endpoint: string
): ServiceKeyValidationResult {
  // Check if the API key email is a service key
  if (!isServiceKeyEmail(apiKey.email)) {
    return {
      isValid: false,
      error: 'API key is not a service key',
      isAuthorized: false,
    };
  }
  
  // Find the service key type
  const serviceKeyType = findServiceKeyByEmail(apiKey.email);
  if (!serviceKeyType) {
    return {
      isValid: false,
      error: 'Unknown service key type',
      isAuthorized: false,
    };
  }
  
  // Check if service key is authorized for this endpoint
  const isAuthorized = isServiceKeyAuthorizedForEndpoint(serviceKeyType, endpoint);
  if (!isAuthorized) {
    return {
      isValid: true,
      serviceKey: apiKey,
      error: 'Service key not authorized for this endpoint',
      isAuthorized: false,
    };
  }
  
  // Validate permissions
  const hasValidPermissions = validateServiceKeyPermissions(serviceKeyType, endpoint);
  if (!hasValidPermissions) {
    return {
      isValid: true,
      serviceKey: apiKey,
      error: 'Service key lacks required permissions',
      isAuthorized: false,
    };
  }
  
  return {
    isValid: true,
    serviceKey: apiKey,
    isAuthorized: true,
  };
}

/**
 * Validate API key format and basic structure
 */
export function validateApiKeyFormat(apiKey: string): boolean {
  return isValidServiceApiKeyFormat(apiKey);
}

/**
 * Check if request is accessing a service key protected endpoint
 */
export function isServiceKeyProtectedEndpoint(endpoint: string): boolean {
  // This will be used to determine if we need to validate service keys
  // Currently, only /api/admin/api-config allows service key access
  return endpoint === '/api/admin/api-config' || endpoint.startsWith('/api/admin/api-config');
}

/**
 * Validate request context for service authentication
 */
export function validateRequestContext(req: AuthenticatedRequest): {
  hasApiKey: boolean;
  apiKey: string | null;
  endpoint: string;
  method: string;
} {
  // For Express router, we need to reconstruct the full path
  // req.originalUrl gives us the full URL including query params
  // req.baseUrl gives us the router mount point
  // req.path gives us the path relative to the router
  const endpoint = req.originalUrl?.split('?')[0] || req.baseUrl + req.path || req.path || req.url;
  
  return {
    hasApiKey: !!extractApiKey(req),
    apiKey: extractApiKey(req),
    endpoint,
    method: req.method,
  };
}

/**
 * Create standardized error response for authentication failures
 */
export function createAuthErrorResponse(
  error: string,
  statusCode: number = 403
): { status: number; error: string; message: string } {
  const errorMessages: Record<string, string> = {
    'standalone_required': 'This endpoint is only accessible in standalone mode',
    'service_key_required': 'This endpoint requires a valid service API key',
    'invalid_service_key': 'Invalid or unauthorized service API key',
    'missing_api_key': 'API key is required for this endpoint',
    'insufficient_permissions': 'Service key lacks required permissions for this endpoint',
  };
  
  return {
    status: statusCode,
    error: error,
    message: errorMessages[error] || 'Authentication failed',
  };
}

/**
 * Log authentication events for audit purposes
 */
export function logAuthEvent(
  event: 'success' | 'failure',
  details: {
    endpoint: string;
    authType: 'standalone' | 'service-key' | 'none';
    serviceKeyEmail?: string;
    error?: string;
    clientIp?: string;
    userAgent?: string;
  }
): void {
  const logData = {
    timestamp: new Date().toISOString(),
    event,
    ...details,
  };
  
  if (event === 'failure') {
    logger.warn('ServiceAuth', 'Service Auth Failure:', logData);
  } else {
    logger.debug('ServiceAuth', 'Service Auth Success:', logData);
  }
}
