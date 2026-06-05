/**
 * Service Authentication Types
 * 
 * TypeScript interfaces and types for service-to-service authentication
 * including service keys, endpoint permissions, and middleware configuration.
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Service key configuration defining authentication and authorization rules
 */
export interface ServiceKeyConfig {
  /** Unique email identifier for the service key */
  EMAIL: string;
  /** Human-readable name for the service */
  NAME: string;
  /** Description of the service key's purpose */
  DESCRIPTION: string;
  /** List of endpoints this service key can access */
  ENDPOINTS: readonly string[];
  /** List of permissions/scopes for this service key */
  PERMISSIONS: readonly string[];
}

/**
 * Service key data structure for database operations
 */
export interface ServiceKeyData {
  ID?: string;
  name: string;
  email: string;
  key?: string;
  isActive: boolean;
  canBeDeleted: boolean;
  usageCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  description: string;
}

/**
 * Authentication mode for endpoint protection
 */
export type AuthMode = 
  | 'STANDALONE_ONLY'           // Only accessible in standalone mode
  | 'SERVICE_KEY_ONLY'          // Only accessible with valid service key
  | 'STANDALONE_OR_SERVICE_KEY' // Accessible in standalone mode OR with valid service key
  | 'ALWAYS_ALLOW';             // No restrictions (for testing/special cases)

/**
 * Endpoint authentication rule configuration
 */
export interface EndpointAuthRule {
  /** Authentication mode for this endpoint */
  mode: AuthMode;
  /** Required service key type (if applicable) */
  serviceKey?: keyof ServiceKeyRegistry;
  /** Additional permissions required */
  permissions?: string[];
}

/**
 * Registry of all service keys in the system
 */
export interface ServiceKeyRegistry {
  ADMIN_TO_GATEWAY: ServiceKeyConfig;
  // Future service keys can be added here
}

/**
 * Validated service API key result structure
 */
export interface ValidatedServiceApiKey {
  id: string;
  key: string;
  name: string;
  email: string;
  isActive: boolean;
  permissions?: string[];
  endpoints?: string[];
}

/**
 * Authentication context added to Express request
 */
export interface ServiceAuthContext {
  /** Type of authentication used */
  authType: 'standalone' | 'service-key' | 'none';
  /** Service key information (if applicable) */
  serviceKey?: ValidatedServiceApiKey;
  /** Whether request is in standalone mode */
  isStandalone: boolean;
  /** Validated permissions for this request */
  permissions: string[];
}

/**
 * Extended Express request with service authentication context
 */
export interface AuthenticatedRequest extends Request {
  serviceAuth?: ServiceAuthContext;
}

/**
 * Middleware function type for service authentication
 */
export type ServiceAuthMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => Promise<void | Response> | void;

/**
 * Configuration options for creating service authentication middleware
 */
export interface ServiceAuthOptions {
  /** Authentication mode */
  mode: AuthMode;
  /** Required service key types */
  allowedServiceKeys?: (keyof ServiceKeyRegistry)[];
  /** Required permissions */
  requiredPermissions?: string[];
  /** Custom error messages */
  errorMessages?: {
    standaloneRequired?: string;
    serviceKeyRequired?: string;
    invalidServiceKey?: string;
    insufficientPermissions?: string;
  };
}

/**
 * Service key validation result
 */
export interface ServiceKeyValidationResult {
  /** Whether the service key is valid */
  isValid: boolean;
  /** Validated service key data */
  serviceKey?: ValidatedServiceApiKey;
  /** Error message if validation failed */
  error?: string;
  /** Whether the service key is authorized for the requested endpoint */
  isAuthorized?: boolean;
}