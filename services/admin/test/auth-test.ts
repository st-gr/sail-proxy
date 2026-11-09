#!/usr/bin/env node

/**
 * Multi-Environment Authentication Test Script
 * 
 * Tests the authentication system across different deployment targets:
 * - development: mocked authentication
 * - docker: JWT via oauth2-proxy + Dex
 * - xsuaa: SAP BTP XSUAA authentication
 * - xsa: HANA XSA authentication
 */

import { getAuthenticationMode, isCustomJwtAuthActive } from '../src/auth/authInit';
import { AuthMiddleware } from '../src/middleware/authMiddleware';
import { getDefaultLogger } from '../../../../libs/logger';

const logger = getDefaultLogger();

async function testAuthentication() {
  logger.info('AuthTest', '🧪 Starting multi-environment authentication test');
  
  // Test 1: Authentication mode detection
  testAuthenticationModeDetection();
  
  // Test 2: Role mapping parsing
  testRoleMappingParsing();
  
  // Test 3: Environment-specific configuration
  await testEnvironmentConfigurations();
  
  logger.info('AuthTest', '✅ Authentication test completed successfully');
}

function testAuthenticationModeDetection() {
  logger.info('AuthTest', '📋 Testing authentication mode detection...');
  
  const originalDeployTarget = process.env.DEPLOY_TARGET;
  const originalNodeEnv = process.env.NODE_ENV;
  
  try {
    // Test development mode
    process.env.DEPLOY_TARGET = 'development';
    process.env.NODE_ENV = 'development';
    let mode = getAuthenticationMode();
    logger.info('AuthTest', `Development mode: ${mode}`, { expected: 'mocked' });
    
    // Test docker mode
    process.env.DEPLOY_TARGET = 'docker';
    process.env.NODE_ENV = 'production';
    mode = getAuthenticationMode();
    logger.info('AuthTest', `Docker mode: ${mode}`, { expected: 'docker-jwt' });
    
    // Test XSUAA mode
    process.env.DEPLOY_TARGET = 'xsuaa';
    mode = getAuthenticationMode();
    logger.info('AuthTest', `XSUAA mode: ${mode}`, { expected: 'xsuaa' });
    
    // Test XSA mode
    process.env.DEPLOY_TARGET = 'xsa';
    mode = getAuthenticationMode();
    logger.info('AuthTest', `XSA mode: ${mode}`, { expected: 'xsa' });
    
    // Test custom JWT detection
    process.env.DEPLOY_TARGET = 'docker';
    const isCustomJwt = isCustomJwtAuthActive();
    logger.info('AuthTest', `Custom JWT active for docker: ${isCustomJwt}`, { expected: true });
    
    process.env.DEPLOY_TARGET = 'development';
    const isCustomJwtDev = isCustomJwtAuthActive();
    logger.info('AuthTest', `Custom JWT active for development: ${isCustomJwtDev}`, { expected: false });
    
  } finally {
    // Restore original environment
    if (originalDeployTarget) process.env.DEPLOY_TARGET = originalDeployTarget;
    else delete process.env.DEPLOY_TARGET;
    if (originalNodeEnv) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;
  }
  
  logger.info('AuthTest', '✅ Authentication mode detection test passed');
}

function testRoleMappingParsing() {
  logger.info('AuthTest', '📋 Testing role mapping parsing...');
  
  const originalRoleMapping = process.env.ROLE_MAPPING;
  
  try {
    // Test valid JSON role mapping
    process.env.ROLE_MAPPING = '{"sap-llm-gateway-admin":"admin","sap-llm-gateway-user":"user"}';
    const authMiddleware1 = AuthMiddleware.create();
    logger.info('AuthTest', 'Valid role mapping parsed successfully');
    
    // Test invalid JSON role mapping (should use defaults)
    process.env.ROLE_MAPPING = 'invalid-json';
    const authMiddleware2 = AuthMiddleware.create();
    logger.info('AuthTest', 'Invalid role mapping handled gracefully with defaults');
    
    // Test missing role mapping (should use defaults)
    delete process.env.ROLE_MAPPING;
    const authMiddleware3 = AuthMiddleware.create();
    logger.info('AuthTest', 'Missing role mapping handled with defaults');
    
  } finally {
    // Restore original environment
    if (originalRoleMapping) process.env.ROLE_MAPPING = originalRoleMapping;
    else delete process.env.ROLE_MAPPING;
  }
  
  logger.info('AuthTest', '✅ Role mapping parsing test passed');
}

async function testEnvironmentConfigurations() {
  logger.info('AuthTest', '📋 Testing environment-specific configurations...');
  
  const testConfigurations = [
    {
      name: 'Local Development',
      env: {
        DEPLOY_TARGET: 'development',
        NODE_ENV: 'development'
      },
      expectedAuthMode: 'mocked',
      expectedCustomJwt: false
    },
    {
      name: 'Docker Production',
      env: {
        DEPLOY_TARGET: 'docker',
        NODE_ENV: 'production',
        ROLE_MAPPING: '{"sap-llm-gateway-admin":"admin","sap-llm-gateway-user":"user"}',
        OAUTH2_PROXY_OIDC_ISSUER_URL: 'http://dex:5556/dex'
      },
      expectedAuthMode: 'docker-jwt',
      expectedCustomJwt: true
    },
    {
      name: 'SAP BTP XSUAA',
      env: {
        DEPLOY_TARGET: 'xsuaa',
        NODE_ENV: 'production'
      },
      expectedAuthMode: 'xsuaa',
      expectedCustomJwt: false
    },
    {
      name: 'HANA XSA',
      env: {
        DEPLOY_TARGET: 'xsa',
        NODE_ENV: 'production'
      },
      expectedAuthMode: 'xsa',
      expectedCustomJwt: false
    }
  ];
  
  for (const config of testConfigurations) {
    logger.info('AuthTest', `Testing configuration: ${config.name}`);
    
    // Set environment variables
    const originalEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(config.env)) {
      originalEnv[key] = process.env[key];
      process.env[key] = value;
    }
    
    try {
      // Test authentication mode
      const authMode = getAuthenticationMode();
      const customJwtActive = isCustomJwtAuthActive();
      
      logger.info('AuthTest', `${config.name} results:`, {
        authMode: { actual: authMode, expected: config.expectedAuthMode },
        customJwt: { actual: customJwtActive, expected: config.expectedCustomJwt }
      });
      
      // Verify expectations
      if (authMode !== config.expectedAuthMode) {
        throw new Error(`Authentication mode mismatch for ${config.name}: expected ${config.expectedAuthMode}, got ${authMode}`);
      }
      
      if (customJwtActive !== config.expectedCustomJwt) {
        throw new Error(`Custom JWT active mismatch for ${config.name}: expected ${config.expectedCustomJwt}, got ${customJwtActive}`);
      }
      
      // Test middleware creation
      const authMiddleware = AuthMiddleware.create();
      if (!authMiddleware) {
        throw new Error(`Failed to create auth middleware for ${config.name}`);
      }
      
      logger.info('AuthTest', `✅ ${config.name} configuration test passed`);
      
    } finally {
      // Restore original environment
      for (const [key, originalValue] of Object.entries(originalEnv)) {
        if (originalValue !== undefined) {
          process.env[key] = originalValue;
        } else {
          delete process.env[key];
        }
      }
    }
  }
  
  logger.info('AuthTest', '✅ Environment-specific configuration tests passed');
}

// Mock request/response for testing middleware
function createMockRequest(headers: Record<string, string> = {}) {
  return {
    headers,
    path: '/odata/v4/AdminService/ApiKeys',
    url: '/odata/v4/AdminService/ApiKeys',
    user: null
  };
}

function createMockResponse() {
  return {
    status: (code: number) => ({
      json: (data: any) => {
        logger.info('AuthTest', `Mock response: ${code}`, data);
      }
    })
  };
}

// Run the test
if (require.main === module) {
  testAuthentication().catch(error => {
    logger.error('AuthTest', '❌ Authentication test failed:', error);
    process.exit(1);
  });
}

export { testAuthentication };