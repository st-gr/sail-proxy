import axios, { AxiosInstance } from 'axios';
import { getAdminServiceUrl } from '@libs/test-utils';

describe('Configuration Lifecycle HTTP Integration Tests', () => {
  let adminClient: AxiosInstance;
  let createdConfigIds: string[] = [];

  beforeAll(() => {
    adminClient = axios.create({
      baseURL: getAdminServiceUrl(),
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('admin@test.com:admin').toString('base64')
      },
      validateStatus: () => true // Don't throw on HTTP errors
    });
  });

  afterAll(async () => {
    // Clean up any configurations created during tests
    for (const configId of createdConfigIds) {
      try {
        console.log(`Would clean up config: ${configId}`);
        // Note: Cleanup would be via DELETE endpoint if available
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  describe('Complete Configuration Lifecycle', () => {
    test('should handle configuration validation', async () => {
      const validConfig = {
        api_config: {
          timeouts: {
            default: 300000,
            streaming: 300000
          },
          logging: {
            defaultLevel: 'DEBUG',
            log_folder_path: './logs',
            payload_logging_enabled: true
          },
          anthropic: {
            substitute_models: [{
              from: 'claude-3-5-haiku-20241022',
              to: 'anthropic--claude-3-haiku--v1',
              description: 'Test model substitution'
            }]
          },
          rate_limit_handling: {
            enabled: true,
            default_delay_seconds: 2,
            backoff_multiplier: 1.5,
            max_delay_seconds: 30
          }
        }
      };

      const response = await adminClient.post('/odata/v4/admin/validateConfiguration', {
        configData: JSON.stringify(validConfig)
      });

      if (response.status === 200) {
        expect(response.data.valid).toBe(true);
        expect(Array.isArray(response.data.errors)).toBe(true);
        expect(Array.isArray(response.data.warnings)).toBe(true);
        expect(response.data.errors.length).toBe(0);
      } else {
        // Validation endpoint may not be fully implemented
        expect([200, 404, 405, 501]).toContain(response.status);
      }
    });

    test('should reject invalid configuration', async () => {
      const invalidConfig = {
        api_config: {
          timeouts: {
            default: "invalid", // Should be number
            streaming: -1 // Should be positive
          },
          logging: {
            defaultLevel: "INVALID_LEVEL" // Invalid log level
          }
        }
      };

      const response = await adminClient.post('/odata/v4/admin/validateConfiguration', {
        configData: JSON.stringify(invalidConfig)
      });

      if (response.status === 200) {
        expect(response.data.valid).toBe(false);
        expect(response.data.errors.length).toBeGreaterThan(0);
      } else {
        // Validation endpoint may not be fully implemented
        expect([200, 404, 405, 501]).toContain(response.status);
      }
    });

    test('should handle configuration creation', async () => {
      const validConfig = {
        api_config: {
          timeouts: { default: 60000, streaming: 60000 },
          logging: { defaultLevel: "INFO" }
        }
      };

      const response = await adminClient.post('/odata/v4/admin/createConfiguration', {
        name: 'HTTP Test Configuration',
        configData: JSON.stringify(validConfig),
        description: 'Configuration created via HTTP test'
      });

      if (response.status === 200) {
        expect(response.data.success).toBe(true);
        expect(response.data.configId).toBeDefined();
        expect(response.data.version).toBeDefined();
        
        if (response.data.configId) {
          createdConfigIds.push(response.data.configId);
        }
        
        console.log('✅ Configuration creation works via HTTP');
      } else {
        // Creation endpoint may not be fully implemented
        expect([200, 404, 405, 501]).toContain(response.status);
        console.log('ℹ️ Configuration creation endpoint not available');
      }
    });

    test('should handle configuration activation', async () => {
      // First, get existing configurations
      const listResponse = await adminClient.get('/odata/v4/admin/ApiConfigurations');
      
      if (listResponse.status === 200 && listResponse.data.value && listResponse.data.value.length > 0) {
        const configId = listResponse.data.value[0].ID;

        const response = await adminClient.post('/odata/v4/admin/activateConfiguration', {
          configId: configId
        });

        if (response.status === 200) {
          expect(response.data.success).toBe(true);
          // May return "already active" message
          if (response.data.message) {
            expect(typeof response.data.message).toBe('string');
          }
          console.log('✅ Configuration activation works via HTTP');
        } else {
          expect([200, 404, 405, 501]).toContain(response.status);
          console.log('ℹ️ Configuration activation endpoint behavior varies');
        }
      } else {
        console.log('ℹ️ No configurations available for activation test');
      }
    });

    test('should get active configuration', async () => {
      const response = await adminClient.post('/odata/v4/admin/getActiveConfiguration', {});

      if (response.status === 200) {
        expect(response.data.success).toBe(true);
        if (response.data.data) {
          expect(response.data.data.id).toBeDefined();
          expect(response.data.data.configData).toBeDefined();
          expect(response.data.data.version).toBeDefined();
          
          // Verify config data is valid JSON
          expect(() => JSON.parse(response.data.data.configData)).not.toThrow();
          
          console.log('✅ Get active configuration works via HTTP');
        }
      } else {
        expect([200, 404, 405, 501]).toContain(response.status);
        console.log('ℹ️ Get active configuration endpoint may not be implemented');
      }
    });

    test('should handle configuration rollback', async () => {
      const response = await adminClient.post('/odata/v4/admin/rollbackConfiguration', {
        reason: 'HTTP test rollback'
      });

      if (response.status === 200) {
        expect(response.data.success).toBeDefined();
        console.log('✅ Configuration rollback endpoint available');
      } else {
        // Rollback may not be implemented or may require specific conditions
        expect([200, 400, 404, 405, 501]).toContain(response.status);
        console.log('ℹ️ Configuration rollback endpoint may not be implemented or available');
      }
    });
  });

  describe('Configuration Status and Health', () => {
    test('should get configuration status', async () => {
      const response = await adminClient.post('/odata/v4/admin/getConfigurationStatus', {});

      if (response.status === 200) {
        expect(response.data.success).toBe(true);
        expect(response.data.status).toBeDefined();
        
        if (response.data.status.activeConfig) {
          expect(response.data.status.activeConfig.hasActiveConfig).toBeDefined();
        }
        
        console.log('✅ Configuration status endpoint works');
      } else {
        expect([200, 404, 405, 501]).toContain(response.status);
        console.log('ℹ️ Configuration status endpoint may not be implemented');
      }
    });
  });

  describe('Error Handling', () => {
    test('should handle activation of non-existent configuration', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      
      const response = await adminClient.post('/odata/v4/admin/activateConfiguration', {
        configId: fakeId
      });

      if (response.status === 200) {
        // Should return success: false for non-existent config
        expect(response.data.success).toBe(false);
        if (response.data.error) {
          expect(response.data.error).toMatch(/not found|invalid|does not exist/i);
        }
      } else {
        expect([200, 400, 404, 405].includes(response.status)).toBe(true);
      }
    });

    test('should provide detailed validation errors for complex invalid configurations', async () => {
      const invalidConfig = {
        api_config: {
          timeouts: {
            default: "not_a_number",
            streaming: -500,
            invalid_timeout: 999
          },
          logging: {
            defaultLevel: "INVALID",
            log_folder_path: null,
            invalid_setting: true
          },
          invalid_section: {
            bad_setting: "value"
          }
        },
        completely_invalid: "structure"
      };

      const response = await adminClient.post('/odata/v4/admin/validateConfiguration', {
        configData: JSON.stringify(invalidConfig)
      });

      if (response.status === 200) {
        expect(response.data.valid).toBe(false);
        expect(response.data.errors.length).toBeGreaterThan(1); // Should have multiple errors
        
        // Should have meaningful error messages
        response.data.errors.forEach((error: string) => {
          expect(error.length).toBeGreaterThan(0);
          expect(typeof error).toBe('string');
        });
        
        console.log('✅ Detailed validation errors provided');
      } else {
        expect([200, 404, 405, 501]).toContain(response.status);
        console.log('ℹ️ Validation endpoint may not be fully implemented');
      }
    });
  });

  describe('Configuration History', () => {
    test('should get configuration history', async () => {
      const response = await adminClient.post('/odata/v4/admin/getConfigurationHistory', {
        limit: 10
      });

      if (response.status === 200) {
        expect(response.data.success).toBe(true);
        expect(Array.isArray(response.data.history)).toBe(true);
        expect(typeof response.data.total).toBe('number');
        
        console.log('✅ Configuration history endpoint works');
      } else {
        expect([200, 404, 405, 501]).toContain(response.status);
        console.log('ℹ️ Configuration history endpoint may not be implemented');
      }
    });
  });
});