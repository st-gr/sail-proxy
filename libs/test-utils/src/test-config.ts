/**
 * Test configuration utilities for service URL management
 * Provides centralized environment variable handling for integration tests
 */

export interface TestServiceUrls {
  gateway: string;
  admin: string;
  ollama: string;
}

/**
 * Gets the gateway service URL for testing
 * Defaults to localhost:3000 for local development, configurable via GATEWAY_URL env var
 */
export function getGatewayUrl(): string {
  return process.env.GATEWAY_URL || 'http://localhost:3000';
}

/**
 * Gets the admin service URL for testing
 * Defaults to localhost:4004 for local development, configurable via ADMIN_SERVICE_URL env var
 */
export function getAdminServiceUrl(): string {
  return process.env.ADMIN_SERVICE_URL || 'http://localhost:4004';
}

/**
 * Gets the Ollama service URL for testing
 * Defaults to localhost:11434 for local development, configurable via OLLAMA_SERVICE_URL env var
 */
export function getOllamaServiceUrl(): string {
  return process.env.OLLAMA_SERVICE_URL || 'http://localhost:11434';
}

/**
 * Gets all service URLs in a single object
 */
export function getTestServiceUrls(): TestServiceUrls {
  return {
    gateway: getGatewayUrl(),
    admin: getAdminServiceUrl(),
    ollama: getOllamaServiceUrl()
  };
}

/**
 * Docker deployment URLs for convenience
 * When running tests against Docker deployment, set these environment variables:
 * - GATEWAY_URL=http://localhost:8080/gateway
 * - ADMIN_SERVICE_URL=http://localhost:8080/admin
 */
export const DOCKER_URLS = {
  gateway: 'http://localhost:8080/gateway',
  admin: 'http://localhost:8080/admin',
  ollama: 'http://localhost:11434' // Ollama typically runs standalone
} as const;

/**
 * Local development URLs (defaults)
 */
export const LOCAL_URLS = {
  gateway: 'http://localhost:3000',
  admin: 'http://localhost:4004',
  ollama: 'http://localhost:11434'
} as const;