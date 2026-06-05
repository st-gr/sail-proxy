/**
 * Service Key Authentication Integration Test
 * 
 * Tests the authentication flow where admin service uses service keys
 * to access gateway /api/admin/api-config/* endpoints.
 */

import request from 'supertest';
import express from 'express';
import { SERVICE_KEYS, createServiceKeyData } from '../../../../libs/service-auth';
import { gatewayStandaloneOrServiceKeyAuth } from '../../src/middlewares/gatewayServiceAuth';
import { isStandaloneMode } from '../../src/config/unifiedAuthConfig';

// Mock the unified auth config
jest.mock('../../src/config/unifiedAuthConfig', () => ({
  isStandaloneMode: jest.fn(),
}));

// Mock the unified validation service with a default response
jest.mock('../../src/services/unifiedApiKeyValidationService', () => ({
  unifiedApiKeyValidationService: {
    validateApiKey: jest.fn()
  }
}));

describe('Service Key Authentication Integration', () => {
  let app: express.Application;
  const mockServiceKey = 'sk-' + 'a'.repeat(48); // Mock service key format
  
  // Default mock validation result
  const mockValidationResult = {
    valid: true,
    authType: 'api_key',
    data: {
      keyId: 'test-service-key-id',
      name: 'Admin Service to Gateway',
      email: SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL,
      permissions: ['config:read', 'config:write'],
      rateLimits: {
        requestsPerMinute: 1000,
        requestsPerHour: 10000,
        requestsPerDay: 100000
      }
    },
    token: 'mock-validation-token',
    auditInfo: {
      requestId: 'test-request-id',
      timestamp: new Date().toISOString(),
      source: 'unified_validation',
      cached: false,
      responseTime: 50
    }
  };
  
  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    // Mock config endpoints with service key authentication
    app.use('/api/admin/api-config', gatewayStandaloneOrServiceKeyAuth);
    
    // Mock config endpoints
    app.get('/api/admin/api-config', (req, res) => {
      res.json({
        id: 'config-1',
        name: 'Default Configuration',
        environment: 'test',
        configData: JSON.stringify({ providers: ['openai', 'anthropic'] }),
        lastModified: new Date().toISOString()
      });
    });
    
    app.put('/api/admin/api-config', (req, res) => {
      res.json({
        success: true,
        message: 'Configuration updated successfully',
        configId: 'config-1'
      });
    });
    
    app.patch('/api/admin/api-config', (req, res) => {
      res.json({
        success: true,
        message: 'Configuration patched successfully',
        changedFields: Object.keys(req.body)
      });
    });
    
    app.get('/api/admin/api-config/rate-limits', (req, res) => {
      res.json({
        global: { requestsPerMinute: 1000 },
        perKey: { requestsPerMinute: 100 }
      });
    });
    
    // Reset mocks
    (isStandaloneMode as jest.Mock).mockReset();
    
    // Set up default mock for validation service
    const { unifiedApiKeyValidationService } = require('../../src/services/unifiedApiKeyValidationService');
    unifiedApiKeyValidationService.validateApiKey.mockReset();
    unifiedApiKeyValidationService.validateApiKey.mockResolvedValue(mockValidationResult);
  });

  describe('Non-Standalone Mode with Service Key', () => {
    beforeEach(() => {
      (isStandaloneMode as jest.Mock).mockReturnValue(false);
    });

    test('should allow GET /api/admin/api-config with valid service key', async () => {
      const response = await request(app)
        .get('/api/admin/api-config')
        .set('X-API-Key', mockServiceKey)
        .set('User-Agent', 'Admin-Service/1.0.0')
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('name');
      expect(response.body).toHaveProperty('configData');
    });

    test('should allow PUT /api/admin/api-config with valid service key', async () => {
      const configData = {
        providers: ['openai', 'anthropic', 'azure'],
        timeouts: { default: 30000 }
      };

      const response = await request(app)
        .put('/api/admin/api-config')
        .set('X-API-Key', mockServiceKey)
        .set('User-Agent', 'Admin-Service/1.0.0')
        .send(configData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body).toHaveProperty('message');
    });

    test('should allow PATCH /api/admin/api-config with valid service key', async () => {
      const patchData = {
        timeouts: { openai: 15000 }
      };

      const response = await request(app)
        .patch('/api/admin/api-config')
        .set('X-API-Key', mockServiceKey)
        .set('User-Agent', 'Admin-Service/1.0.0')
        .send(patchData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.changedFields).toContain('timeouts');
    });

    test('should allow GET /api/admin/api-config/rate-limits with valid service key', async () => {
      const response = await request(app)
        .get('/api/admin/api-config/rate-limits')
        .set('X-API-Key', mockServiceKey)
        .set('User-Agent', 'Admin-Service/1.0.0')
        .expect(200);

      expect(response.body).toHaveProperty('global');
      expect(response.body).toHaveProperty('perKey');
    });

    test('should reject requests without API key', async () => {
      const response = await request(app)
        .get('/api/admin/api-config')
        .set('User-Agent', 'Admin-Service/1.0.0')
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('service_key_required');
    });

    test('should reject requests with invalid service key', async () => {
      // Mock validation failure
      const { unifiedApiKeyValidationService } = require('../../src/services/unifiedApiKeyValidationService');
      unifiedApiKeyValidationService.validateApiKey.mockResolvedValueOnce({
        valid: false,
        authType: 'api_key',
        auditInfo: {
          requestId: 'test-request-id',
          timestamp: new Date().toISOString(),
          source: 'unified_validation',
          cached: false,
          responseTime: 25
        }
      });

      const response = await request(app)
        .get('/api/admin/api-config')
        .set('X-API-Key', 'sk-invalid-key-12345')
        .set('User-Agent', 'Admin-Service/1.0.0')
        .expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('invalid_service_key');
    });

    test('should reject non-service API keys', async () => {
      // Mock validation with regular API key (not service key)
      const { unifiedApiKeyValidationService } = require('../../src/services/unifiedApiKeyValidationService');
      unifiedApiKeyValidationService.validateApiKey.mockResolvedValueOnce({
        valid: true,
        authType: 'api_key',
        data: {
          keyId: 'regular-api-key-id',
          name: 'Regular User API Key',
          email: 'user@example.com', // Not a service key email
          permissions: ['models:read'],
          rateLimits: {
            requestsPerMinute: 60,
            requestsPerHour: 1000,
            requestsPerDay: 10000
          }
        }
      });

      const response = await request(app)
        .get('/api/admin/api-config')
        .set('X-API-Key', 'sk-regular-user-key-123')
        .set('User-Agent', 'Regular-Client/1.0.0')
        .expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('invalid_service_key');
    });
  });

  describe('Standalone Mode', () => {
    beforeEach(() => {
      (isStandaloneMode as jest.Mock).mockReturnValue(true);
    });

    test('should allow access without API key in standalone mode', async () => {
      const response = await request(app)
        .get('/api/admin/api-config')
        .set('User-Agent', 'Admin-Service/1.0.0')
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('configData');
    });

    test('should allow access with API key in standalone mode', async () => {
      const response = await request(app)
        .get('/api/admin/api-config')
        .set('X-API-Key', mockServiceKey)
        .set('User-Agent', 'Admin-Service/1.0.0')
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('configData');
    });
  });

  describe('Service Key Validation Context', () => {
    beforeEach(() => {
      (isStandaloneMode as jest.Mock).mockReturnValue(false);
    });

    test('should pass correct validation context to unified service', async () => {
      const { unifiedApiKeyValidationService } = require('../../src/services/unifiedApiKeyValidationService');
      
      await request(app)
        .post('/api/admin/api-config')
        .set('X-API-Key', mockServiceKey)
        .set('User-Agent', 'Admin-Service/1.0.0')
        .set('X-Forwarded-For', '192.168.1.100')
        .send({ test: 'data' });

      // Verify the validation service was called with correct context
      expect(unifiedApiKeyValidationService.validateApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: mockServiceKey,
          clientIp: expect.any(String),
          method: 'POST',
          endpoint: '/api/admin/api-config',
          userAgent: 'Admin-Service/1.0.0'
        })
      );
    });
  });

  describe('Service Key Constants Integration', () => {
    test('should use correct service key email from shared constants', () => {
      expect(SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL).toBe('admin2gateway.service.key');
      expect(SERVICE_KEYS.ADMIN_TO_GATEWAY.NAME).toBe('Admin Service to Gateway');
      expect(SERVICE_KEYS.ADMIN_TO_GATEWAY.ENDPOINTS).toContain('/api/admin/api-config/*');
      expect(SERVICE_KEYS.ADMIN_TO_GATEWAY.PERMISSIONS).toContain('config:write');
    });

    test('should create proper service key data structure', () => {
      const serviceKeyData = createServiceKeyData('ADMIN_TO_GATEWAY');
      
      expect(serviceKeyData).toMatchObject({
        name: 'Admin Service to Gateway',
        email: 'admin2gateway.service.key',
        isActive: true,
        canBeDeleted: false,
        createdBy: 'system',
        description: 'Service-to-service API key for admin service to access gateway endpoints'
      });
      
      expect(serviceKeyData.key).toMatch(/^sk-[a-f0-9]{48}$/);
      expect(serviceKeyData.ID).toBeDefined();
      expect(serviceKeyData.expiresAt.getFullYear()).toBe(2099);
    });
  });

  describe('Error Response Format', () => {
    beforeEach(() => {
      (isStandaloneMode as jest.Mock).mockReturnValue(false);
    });

    test('should return proper error format for missing API key', async () => {
      const response = await request(app)
        .get('/api/admin/api-config')
        .expect(401);

      expect(response.body).toEqual({
        error: 'service_key_required',
        message: 'This endpoint requires a valid service API key'
      });
    });

    test('should return proper error format for invalid service key', async () => {
      // Mock validation failure
      const { unifiedApiKeyValidationService } = require('../../src/services/unifiedApiKeyValidationService');
      unifiedApiKeyValidationService.validateApiKey.mockResolvedValueOnce({
        valid: false
      });

      const response = await request(app)
        .get('/api/admin/api-config')
        .set('X-API-Key', 'invalid-key')
        .expect(403);

      expect(response.body).toEqual({
        error: 'invalid_service_key',
        message: expect.stringContaining('Invalid or unauthorized service API key')
      });
    });
  });
});