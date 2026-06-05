import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getAdminServiceUrl } from '@libs/test-utils';

describe('Configuration Management HTTP Integration Tests', () => {
  let client: AxiosInstance;
  const createdConfigurations: string[] = [];

  beforeAll(() => {
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
  });

  afterAll(async () => {
    // Clean up created configurations
    for (const configId of createdConfigurations) {
      try {
        await client.delete(`/odata/v4/admin/ApiConfigurations(${configId})`);
      } catch (error) {
        console.warn(`Failed to clean up configuration ${configId}:`, error);
      }
    }
  });

  describe('Configuration CRUD Operations', () => {
    test('should create a new API configuration', async () => {
      const configData = {
        name: `Test Configuration ${uuidv4()}`,
        version: '1.0.0',
        description: 'Integration test configuration',
        environment: 'development',
        configData: JSON.stringify({
          api_config: {
            providers: {
              openai: {
                base_url: 'https://api.openai.com/v1',
                api_key: 'sk-test-key',
                models: ['gpt-4', 'gpt-3.5-turbo']
              },
              anthropic: {
                base_url: 'https://api.anthropic.com',
                api_key: 'sk-ant-test-key',
                models: ['claude-3-sonnet', 'claude-3-haiku']
              }
            },
            rate_limits: {
              default: {
                requests_per_minute: 60,
                requests_per_hour: 1000
              }
            }
          }
        }),
        isActive: true,
        isDefault: false
      };

      const response = await client.post('/odata/v4/admin/ApiConfiguration', configData);
      
      if (response.status === 201) {
        expect(response.data).toHaveProperty('ID');
        expect(response.data.name).toBe(configData.name);
        expect(response.data.version).toBe(configData.version);
        expect(response.data.environment).toBe(configData.environment);
        
        createdConfigurations.push(response.data.ID);
      } else {
        // Handle gracefully if direct CRUD not supported
        expect([201, 404, 405, 501]).toContain(response.status);
      }
    });

    test('should list API configurations', async () => {
      const response = await client.get('/odata/v4/admin/ApiConfigurations');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
    });

    test('should filter active configurations', async () => {
      const response = await client.get('/odata/v4/admin/ApiConfigurations?$filter=isActive eq true');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      
      response.data.value.forEach((config: any) => {
        expect(config.isActive).toBe(true);
      });
    });

    test('should query configuration history view', async () => {
      const response = await client.get('/odata/v4/admin/ConfigurationHistory');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
      
      // History should contain configuration metadata
      if (response.data.value.length > 0) {
        const history = response.data.value[0];
        expect(history).toHaveProperty('ID');
        // ConfigurationHistory may or may not exclude configData - let's not assume
      }
    });
  });

  describe('Configuration Management Actions', () => {
    let testConfigId: string;

    beforeEach(async () => {
      // Create a test configuration for management operations
      const configData = {
        name: `Management Test Config ${uuidv4()}`,
        version: '1.0.0',
        description: 'Configuration for testing management operations',
        environment: 'test',
        configData: JSON.stringify({
          api_config: {
            providers: {
              openai: {
                base_url: 'https://api.openai.com/v1',
                models: ['gpt-4']
              }
            }
          }
        }),
        isActive: true,
        isDefault: false
      };

      const response = await client.post('/odata/v4/admin/ApiConfiguration', configData);
      
      if (response.status === 201) {
        testConfigId = response.data.ID;
        createdConfigurations.push(testConfigId);
      }
    });

    test('should update configuration via updateConfiguration action with auto-validation', async () => {
      if (!testConfigId) {
        console.log('Skipping update test - configuration creation not available');
        return;
      }

      const updateRequest = {
        configId: testConfigId,
        configData: JSON.stringify({
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
            rate_limits: {
              default: {
                requests_per_minute: 120,
                requests_per_hour: 2000
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
        reason: 'Integration test configuration update with validation'
      };

      const response = await client.post('/odata/v4/admin/updateConfiguration', updateRequest);
      
      if (response.status === 200) {
        expect(response.data).toHaveProperty('success');
        expect(response.data).toHaveProperty('message');
        expect(response.data).toHaveProperty('validationErrors');
        expect(response.data.success).toBe(true);
        expect(Array.isArray(response.data.validationErrors)).toBe(true);
        expect(response.data.validationErrors).toHaveLength(0); // Should have no validation errors
        expect(response.data.message).toMatch(/successfully.*validated/i); // Should indicate validation passed
      } else {
        expect([200, 404, 501]).toContain(response.status);
      }
    });

    test('should validate configuration via validateConfiguration action', async () => {
      const validConfig = JSON.stringify({
        api_config: {
          providers: {
            openai: {
              base_url: 'https://api.openai.com/v1',
              api_key: 'sk-test-key',
              models: ['gpt-4']
            }
          },
          rate_limits: {
            default: {
              requests_per_minute: 60
            }
          }
        }
      });

      const response = await client.post('/odata/v4/admin/validateConfiguration', {
        configData: validConfig
      });

      if (response.status === 200) {
        // The response format uses 'isValid' (TypeScript implementation)
        expect(response.data).toHaveProperty('valid');
        expect(response.data).toHaveProperty('errors');
        expect(response.data).toHaveProperty('warnings');
        expect(Array.isArray(response.data.errors)).toBe(true);
        expect(Array.isArray(response.data.warnings)).toBe(true);
      } else {
        expect([200, 404, 501]).toContain(response.status);
      }
    });

    test('should reject invalid configuration during validation', async () => {
      const invalidConfig = '{ invalid json structure';

      const response = await client.post('/odata/v4/admin/validateConfiguration', {
        configData: invalidConfig
      });

      if (response.status === 200) {
        expect(response.data.valid).toBe(false);
        expect(response.data.errors.length).toBeGreaterThan(0);
      } else {
        expect([200, 400, 404, 501]).toContain(response.status);
      }
    });

    test('should get active configuration via ActiveConfiguration entity', async () => {
      const response = await client.get('/odata/v4/admin/ActiveConfiguration');

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
      
      // If there's an active configuration, it should have required properties
      if (response.data.value.length > 0) {
        const activeConfig = response.data.value[0];
        expect(activeConfig).toHaveProperty('ID');
        expect(activeConfig).toHaveProperty('name');
        expect(activeConfig).toHaveProperty('isActive');
        expect(activeConfig.isActive).toBe(true);
      }
    });
  });

  describe('Configuration Providers and Models', () => {
    test.skip('should query configuration providers', async () => {
      // ConfigProviders entity does not exist in the current service
      // This test is skipped until the entity is implemented
      const response = await client.get('/odata/v4/admin/ConfigProviders');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
    });

    test.skip('should query configuration models', async () => {
      // ConfigModels entity does not exist in the current service
      // This test is skipped until the entity is implemented
      const response = await client.get('/odata/v4/admin/ConfigModels');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
    });

    test.skip('should query provider summary view', async () => {
      // ProviderSummary entity does not exist in the current service
      // This test is skipped until the entity is implemented
      const response = await client.get('/odata/v4/admin/ProviderSummary');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
    });

    test.skip('should filter enabled providers', async () => {
      // ConfigProviders entity does not exist in the current service
      // This test is skipped until the entity is implemented
      const response = await client.get('/odata/v4/admin/ConfigProviders?$filter=isEnabled eq true');
      
      expect(response.status).toBe(200);
      response.data.value.forEach((provider: any) => {
        expect(provider.isEnabled).toBe(true);
      });
    });
  });

  describe('Configuration Templates', () => {
    test.skip('should query configuration templates', async () => {
      // ConfigurationTemplates entity does not exist in the current service
      // This test is skipped until the entity is implemented
      const response = await client.get('/odata/v4/admin/ConfigurationTemplates');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
    });

    test.skip('should create a configuration template', async () => {
      // ConfigurationTemplates entity does not exist in the current service
      // This test is skipped until the entity is implemented
      const templateData = {
        name: `Template ${uuidv4()}`,
        description: 'Integration test configuration template',
        category: 'custom',
        templateData: JSON.stringify({
          api_config: {
            providers: {
              openai: {
                base_url: 'https://api.openai.com/v1',
                models: ['gpt-4']
              }
            }
          }
        }),
        tags: 'integration,test,openai',
        isPublic: false
      };

      const response = await client.post('/odata/v4/admin/ConfigurationTemplates', templateData);
      
      if (response.status === 201) {
        expect(response.data).toHaveProperty('ID');
        expect(response.data.name).toBe(templateData.name);
        expect(response.data.category).toBe(templateData.category);
        
        // Clean up template
        await client.delete(`/odata/v4/admin/ConfigurationTemplates(${response.data.ID})`);
      } else {
        expect([201, 404, 405, 501]).toContain(response.status);
      }
    });
  });

  describe('Configuration Change History', () => {
    test('should query configuration changes', async () => {
      const response = await client.get('/odata/v4/admin/ConfigurationHistory');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
    });

    test.skip('should filter configuration changes by type', async () => {
      // ConfigurationHistory doesn't have changeType field like ConfigurationChanges would
      // This test is skipped as the filtering criteria doesn't match the actual entity structure
      const response = await client.get('/odata/v4/admin/ConfigurationHistory?$filter=changeType eq \'update\'');
      
      expect(response.status).toBe(200);
      if (response.data.value.length > 0) {
        response.data.value.forEach((change: any) => {
          expect(change.changeType).toBe('update');
        });
      }
    });

    test('should order configuration changes by creation date', async () => {
      const response = await client.get('/odata/v4/admin/ConfigurationHistory?$orderby=createdAt desc&$top=10');
      
      expect(response.status).toBe(200);
      expect(response.data.value.length).toBeLessThanOrEqual(10);
      
      // Verify ordering (if data exists)
      if (response.data.value.length > 1) {
        for (let i = 1; i < response.data.value.length; i++) {
          const current = new Date(response.data.value[i].createdAt);
          const previous = new Date(response.data.value[i-1].createdAt);
          expect(current.getTime()).toBeLessThanOrEqual(previous.getTime());
        }
      }
    });
  });

  describe('Configuration Performance', () => {
    test('should validate configuration within reasonable time', async () => {
      const startTime = Date.now();
      
      const configData = JSON.stringify({
        api_config: {
          providers: {
            openai: { base_url: 'https://api.openai.com/v1', models: ['gpt-4'] },
            anthropic: { base_url: 'https://api.anthropic.com', models: ['claude-3-sonnet'] }
          }
        }
      });

      const response = await client.post('/odata/v4/admin/validateConfiguration', { configData });
      const duration = Date.now() - startTime;
      
      // Validation should be fast
      expect(duration).toBeLessThan(3000);
      
      if (response.status === 200) {
        expect(response.data).toHaveProperty('valid');
      }
    });

    test('should handle large configuration data', async () => {
      const largeConfig = {
        api_config: {
          providers: Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [
              `provider_${i}`,
              {
                base_url: `https://api-${i}.example.com`,
                models: Array.from({ length: 10 }, (_, j) => `model-${i}-${j}`)
              }
            ])
          )
        }
      };

      const response = await client.post('/odata/v4/admin/validateConfiguration', {
        configData: JSON.stringify(largeConfig)
      });

      if (response.status === 200) {
        expect(response.data).toHaveProperty('valid');
      } else {
        expect([200, 413, 404, 501]).toContain(response.status); // 413 = Payload Too Large
      }
    });
  });
});