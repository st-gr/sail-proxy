import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getAdminServiceUrl } from '@libs/test-utils';

describe('Configuration Auto-Validation Integration Tests', () => {
  let client: AxiosInstance;
  let testConfigId: string;

  beforeAll(async () => {
    client = axios.create({
      baseURL: getAdminServiceUrl(),
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('admin@test.com:admin').toString('base64')
      },
      validateStatus: () => true // Don't throw on HTTP errors
    });

    // Create a test configuration to work with
    const configData = {
      name: `Auto-Validation Test Config ${uuidv4()}`,
      version: '1.0.0',
      description: 'Configuration for testing auto-validation before save',
      environment: 'test',
      configData: JSON.stringify({
        api_config: {
          providers: {
            openai: {
              base_url: 'https://api.openai.com/v1',
              models: ['gpt-4']
            }
          },
          timeouts: {
            default: 60000,
            streaming: 60000
          },
          logging: {
            defaultLevel: 'INFO'
          }
        }
      }),
      isActive: true,
      isDefault: false
    };

    const response = await client.post('/odata/v4/admin/ApiConfiguration', configData);
    
    if (response.status === 201) {
      testConfigId = response.data.ID;
    } else {
      console.warn('Could not create test configuration for auto-validation tests');
    }
  });

  afterAll(async () => {
    // Clean up test configuration
    if (testConfigId) {
      try {
        await client.delete(`/odata/v4/admin/ApiConfiguration(${testConfigId})`);
      } catch (error) {
        console.warn(`Failed to clean up test configuration ${testConfigId}:`, error);
      }
    }
  });

  describe('Backend Auto-Validation Before Save', () => {
    test('should reject updateConfiguration with invalid JSON syntax', async () => {
      if (!testConfigId) {
        console.log('Skipping test - test configuration not available');
        return;
      }

      const updateRequest = {
        configId: testConfigId,
        configData: '{ invalid json syntax: missing quotes and commas',
        reason: 'Testing invalid JSON syntax rejection'
      };

      const response = await client.post('/odata/v4/admin/updateConfiguration', updateRequest);
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success');
      expect(response.data).toHaveProperty('validationErrors');
      expect(response.data).toHaveProperty('message');
      
      expect(response.data.success).toBe(false);
      expect(Array.isArray(response.data.validationErrors)).toBe(true);
      expect(response.data.validationErrors.length).toBeGreaterThan(0);
      expect(response.data.message).toMatch(/invalid json|json/i);
    });

    test('should reject updateConfiguration with missing api_config root', async () => {
      if (!testConfigId) {
        console.log('Skipping test - test configuration not available');
        return;
      }

      const updateRequest = {
        configId: testConfigId,
        configData: JSON.stringify({
          // Missing api_config root object
          providers: {
            openai: {
              base_url: 'https://api.openai.com/v1',
              models: ['gpt-4']
            }
          }
        }),
        reason: 'Testing missing api_config root rejection'
      };

      const response = await client.post('/odata/v4/admin/updateConfiguration', updateRequest);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(false);
      expect(response.data.validationErrors.length).toBeGreaterThan(0);
      expect(response.data.validationErrors[0]).toMatch(/api_config/i);
      expect(response.data.message).toMatch(/validation failed/i);
    });

    test('should accept valid configuration data and save successfully', async () => {
      if (!testConfigId) {
        console.log('Skipping test - test configuration not available');
        return;
      }

      const validConfig = {
        api_config: {
          providers: {
            openai: {
              base_url: 'https://api.openai.com/v1',
              models: ['gpt-4', 'gpt-3.5-turbo']
            },
            anthropic: {
              base_url: 'https://api.anthropic.com',
              models: ['claude-3-sonnet']
            }
          },
          timeouts: {
            default: 120000,
            streaming: 120000
          },
          logging: {
            defaultLevel: 'DEBUG',
            payload_logging_enabled: true
          },
          rate_limits: {
            default: {
              requests_per_minute: 100,
              requests_per_hour: 1500
            }
          }
        }
      };

      const updateRequest = {
        configId: testConfigId,
        configData: JSON.stringify(validConfig),
        reason: 'Testing valid configuration acceptance and auto-validation success'
      };

      const response = await client.post('/odata/v4/admin/updateConfiguration', updateRequest);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.validationErrors).toHaveLength(0);
      expect(response.data.message).toMatch(/successfully.*validated/i);
    });

    test('should validate before save even with minimal configuration', async () => {
      if (!testConfigId) {
        console.log('Skipping test - test configuration not available');
        return;
      }

      const minimalValidConfig = {
        api_config: {
          timeouts: {
            default: 60000,
            streaming: 60000
          },
          logging: {
            defaultLevel: 'INFO'
          }
        }
      };

      const updateRequest = {
        configId: testConfigId,
        configData: JSON.stringify(minimalValidConfig),
        reason: 'Testing minimal valid configuration'
      };

      const response = await client.post('/odata/v4/admin/updateConfiguration', updateRequest);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.validationErrors).toHaveLength(0);
      expect(response.data.message).toMatch(/successfully.*validated/i);
    });

    test('should prevent saving invalid configurations that would normally be caught by validate action', async () => {
      if (!testConfigId) {
        console.log('Skipping test - test configuration not available');
        return;
      }

      // First, verify that this config would fail explicit validation
      const invalidConfig = JSON.stringify({
        // Missing api_config - should fail validation
        invalid_structure: {
          some_field: 'some_value'
        }
      });

      const validationResponse = await client.post('/odata/v4/admin/validateConfiguration', {
        configData: invalidConfig
      });

      if (validationResponse.status === 200) {
        expect(validationResponse.data.valid).toBe(false);
      }

      // Now try to update with the same invalid config - should be blocked
      const updateRequest = {
        configId: testConfigId,
        configData: invalidConfig,
        reason: 'Testing that invalid configs cannot be saved via updateConfiguration'
      };

      const updateResponse = await client.post('/odata/v4/admin/updateConfiguration', updateRequest);
      
      expect(updateResponse.status).toBe(200);
      expect(updateResponse.data.success).toBe(false);
      expect(updateResponse.data.validationErrors.length).toBeGreaterThan(0);
      expect(updateResponse.data.message).toMatch(/validation failed/i);
    });

    test('should return detailed validation errors when configuration is invalid', async () => {
      if (!testConfigId) {
        console.log('Skipping test - test configuration not available');
        return;
      }

      const updateRequest = {
        configId: testConfigId,
        configData: JSON.stringify({
          // Missing required api_config root
          some_other_field: 'value'
        }),
        reason: 'Testing detailed validation error reporting'
      };

      const response = await client.post('/odata/v4/admin/updateConfiguration', updateRequest);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(false);
      expect(Array.isArray(response.data.validationErrors)).toBe(true);
      expect(response.data.validationErrors.length).toBeGreaterThan(0);
      
      // Should contain specific error about missing api_config
      const hasApiConfigError = response.data.validationErrors.some((error: string) => 
        error.toLowerCase().includes('api_config')
      );
      expect(hasApiConfigError).toBe(true);
      
      expect(response.data.message).toContain('Configuration validation failed');
    });
  });

  describe('Validation Performance and Integration', () => {
    test('should validate and save within reasonable time', async () => {
      if (!testConfigId) {
        console.log('Skipping test - test configuration not available');
        return;
      }

      const startTime = Date.now();
      
      const validConfig = {
        api_config: {
          providers: {
            openai: {
              base_url: 'https://api.openai.com/v1',
              models: ['gpt-4']
            }
          },
          timeouts: {
            default: 60000,
            streaming: 60000
          },
          logging: {
            defaultLevel: 'INFO'
          }
        }
      };

      const updateRequest = {
        configId: testConfigId,
        configData: JSON.stringify(validConfig),
        reason: 'Testing validation performance'
      };

      const response = await client.post('/odata/v4/admin/updateConfiguration', updateRequest);
      const duration = Date.now() - startTime;
      
      // Auto-validation + save should be fast (allowing for network latency)
      expect(duration).toBeLessThan(5000);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });

    test('should handle validation errors gracefully without hanging', async () => {
      if (!testConfigId) {
        console.log('Skipping test - test configuration not available');
        return;
      }

      const startTime = Date.now();
      
      const updateRequest = {
        configId: testConfigId,
        configData: '{ "malformed": json }', // Invalid JSON
        reason: 'Testing validation error handling performance'
      };

      const response = await client.post('/odata/v4/admin/updateConfiguration', updateRequest);
      const duration = Date.now() - startTime;
      
      // Even validation failures should be fast
      expect(duration).toBeLessThan(3000);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(false);
      expect(response.data.validationErrors.length).toBeGreaterThan(0);
    });
  });
});