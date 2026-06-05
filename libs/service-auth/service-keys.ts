/**
 * Service Key Constants and Utilities
 * 
 * Centralized definitions for service-to-service authentication keys,
 * endpoint access rules, and utility functions for service key management.
 */

import * as crypto from 'crypto';
import { ServiceKeyConfig, ServiceKeyRegistry, ServiceKeyData, EndpointAuthRule, AuthMode } from './types';

/**
 * Registry of all service keys in the system
 * 
 * Each service key defines authentication and authorization rules
 * for service-to-service communication.
 */
export const SERVICE_KEYS: ServiceKeyRegistry = {
  ADMIN_TO_GATEWAY: {
    EMAIL: 'admin2gateway.service.key',
    NAME: 'Admin Service to Gateway',
    DESCRIPTION: 'Service-to-service API key for admin service to access gateway endpoints',
    ENDPOINTS: ['/v1/models', '/api/admin/api-config/*'] as const,
    PERMISSIONS: ['models:read', 'config:write', 'config:read'] as const,
  },
} as const;

/**
 * Endpoint authentication rules
 * 
 * Defines which authentication modes are required for specific endpoints.
 */
export const ENDPOINT_AUTH_RULES: Record<string, EndpointAuthRule> = {
  '/api/admin/api-keys': {
    mode: 'STANDALONE_ONLY',
  },
  '/aws/api-keys': {
    mode: 'STANDALONE_ONLY',
  },
  '/api/admin/api-config': {
    mode: 'STANDALONE_OR_SERVICE_KEY',
    serviceKey: 'ADMIN_TO_GATEWAY',
    permissions: ['config:write', 'config:read'],
  },
} as const;

/**
 * Get service key configuration by key type
 */
export function getServiceKeyConfig(keyType: keyof ServiceKeyRegistry): ServiceKeyConfig {
  return SERVICE_KEYS[keyType];
}

/**
 * Get all service key emails for validation
 */
export function getAllServiceKeyEmails(): string[] {
  return Object.values(SERVICE_KEYS).map(config => config.EMAIL);
}

/**
 * Find service key type by email
 */
export function findServiceKeyByEmail(email: string): keyof ServiceKeyRegistry | null {
  for (const [keyType, config] of Object.entries(SERVICE_KEYS)) {
    if (config.EMAIL === email) {
      return keyType as keyof ServiceKeyRegistry;
    }
  }
  return null;
}

/**
 * Check if an email belongs to a service key
 */
export function isServiceKeyEmail(email: string): boolean {
  return findServiceKeyByEmail(email) !== null;
}

/**
 * Check if a service key is authorized for a specific endpoint
 */
export function isServiceKeyAuthorizedForEndpoint(
  serviceKeyType: keyof ServiceKeyRegistry,
  endpoint: string
): boolean {
  const config = SERVICE_KEYS[serviceKeyType];
  return config.ENDPOINTS.some(allowedEndpoint => {
    // Exact match
    if (allowedEndpoint === endpoint) return true;
    
    // Wildcard matching (e.g., '/api/admin/api-config/*' matches '/api/admin/api-config/rate-limits')
    if (allowedEndpoint.endsWith('/*')) {
      const basePath = allowedEndpoint.slice(0, -2);
      return endpoint.startsWith(basePath) && (endpoint === basePath || endpoint.startsWith(basePath + '/'));
    }
    
    return false;
  });
}

/**
 * Get authentication rule for an endpoint
 */
export function getEndpointAuthRule(endpoint: string): EndpointAuthRule | null {
  // Direct match first
  if (ENDPOINT_AUTH_RULES[endpoint]) {
    return ENDPOINT_AUTH_RULES[endpoint];
  }
  
  // Check for wildcard matches
  for (const [ruleEndpoint, rule] of Object.entries(ENDPOINT_AUTH_RULES)) {
    if (ruleEndpoint.endsWith('/*')) {
      const basePath = ruleEndpoint.slice(0, -2);
      if (endpoint.startsWith(basePath + '/')) {
        return rule;
      }
    }
  }
  
  return null;
}

/**
 * Create service key data structure for database operations
 */
export function createServiceKeyData(
  serviceKeyType: keyof ServiceKeyRegistry,
  apiKey?: string
): ServiceKeyData {
  const config = SERVICE_KEYS[serviceKeyType];
  const now = new Date();
  
  return {
    ID: crypto.randomUUID(),
    name: config.NAME,
    email: config.EMAIL,
    key: apiKey || generateServiceApiKey(),
    isActive: true,
    canBeDeleted: false, // Prevent accidental deletion of service keys
    usageCount: 0,
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date('2099-12-31'), // Far future expiry for service keys
    description: config.DESCRIPTION,
  };
}

/**
 * Generate a new service API key
 * 
 * Format: sk-{48 hex characters} (same as admin service pattern)
 */
export function generateServiceApiKey(): string {
  return `sk-${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Validate service API key format
 */
export function isValidServiceApiKeyFormat(key: string): boolean {
  return /^sk-[a-f0-9]{48}$/.test(key);
}

/**
 * Check if endpoint requires standalone mode only
 */
export function requiresStandaloneOnly(endpoint: string): boolean {
  const rule = getEndpointAuthRule(endpoint);
  return rule?.mode === 'STANDALONE_ONLY';
}

/**
 * Check if endpoint allows service key authentication
 */
export function allowsServiceKeyAuth(endpoint: string): boolean {
  const rule = getEndpointAuthRule(endpoint);
  return rule?.mode === 'SERVICE_KEY_ONLY' || rule?.mode === 'STANDALONE_OR_SERVICE_KEY';
}

/**
 * Get required service key type for an endpoint
 */
export function getRequiredServiceKeyType(endpoint: string): keyof ServiceKeyRegistry | null {
  const rule = getEndpointAuthRule(endpoint);
  return rule?.serviceKey || null;
}

/**
 * Validate service key permissions for endpoint
 */
export function validateServiceKeyPermissions(
  serviceKeyType: keyof ServiceKeyRegistry,
  endpoint: string,
  requiredPermissions?: string[]
): boolean {
  const config = SERVICE_KEYS[serviceKeyType];
  const rule = getEndpointAuthRule(endpoint);
  
  // Check endpoint authorization first
  if (!isServiceKeyAuthorizedForEndpoint(serviceKeyType, endpoint)) {
    return false;
  }
  
  // Check required permissions from endpoint rule
  if (rule?.permissions) {
    for (const permission of rule.permissions) {
      if (!config.PERMISSIONS.includes(permission as any)) {
        return false;
      }
    }
  }
  
  // Check additional required permissions
  if (requiredPermissions) {
    for (const permission of requiredPermissions) {
      if (!config.PERMISSIONS.includes(permission as any)) {
        return false;
      }
    }
  }
  
  return true;
}