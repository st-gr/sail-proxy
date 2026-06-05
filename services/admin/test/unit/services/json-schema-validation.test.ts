// Import the service directly and create a mock CDS service
const configurationServiceFactory = require('../../../src/srv/config-service');

describe('Configuration Service - JSON Schema Validation', () => {
  let configService: any;

  beforeEach(() => {
    // Create a mock CDS service object
    const mockCdsService = {
      on: jest.fn(),
      after: jest.fn()
    };
    
    // The config-service module exports a function that returns the service instance
    configService = configurationServiceFactory(mockCdsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validateConfiguration', () => {
    it('should reject configuration with invalid JSON schema - missing api_config', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            wrong_property: {}
          })
        }
      };

      const result = await configService.validateConfiguration(req);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((error: string) => error.includes('api_config'))).toBe(true);
    });

    it('should reject configuration with invalid timeout type', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            api_config: {
              timeouts: {
                default: "not_a_number",
                streaming: 600000
              }
            }
          })
        }
      };

      const result = await configService.validateConfiguration(req);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((error: string) => error.includes('Schema validation error'))).toBe(true);
    });

    it('should reject configuration with invalid logging level', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            api_config: {
              logging: {
                defaultLevel: "INVALID_LEVEL"
              }
            }
          })
        }
      };

      const result = await configService.validateConfiguration(req);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((error: string) => error.includes('Schema validation error'))).toBe(true);
    });

    it('should reject configuration with incomplete hook definition', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            api_config: {
              hookDefinitions: {
                testHook: {
                  type: "header"
                  // Missing required 'name' property for header type
                }
              }
            }
          })
        }
      };

      const result = await configService.validateConfiguration(req);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((error: string) => error.includes('Schema validation error'))).toBe(true);
    });

    it('should reject configuration with incomplete OpenRouter pricing', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            api_config: {
              openrouter: {
                default_pricing: {
                  completion: "0.001"
                  // Missing required 'image' and 'prompt' properties
                }
              }
            }
          })
        }
      };

      const result = await configService.validateConfiguration(req);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((error: string) => error.includes('Schema validation error'))).toBe(true);
    });

    it('should accept valid configuration and pass schema validation', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            api_config: {
              timeouts: {
                default: 600000,
                streaming: 600000
              },
              logging: {
                defaultLevel: "INFO",
                log_folder_path: "./logs",
                payload_logging_enabled: false,
                components: {
                  ConfigService: "DEBUG"
                }
              },
              anthropic: {
                substitute_models: [
                  {
                    from: "claude-3-5-haiku-20241022",
                    to: "anthropic--claude-3-haiku--deployed",
                    description: "Test substitution"
                  }
                ]
              },
              rate_limit_handling: {
                enabled: true,
                default_delay_seconds: 1,
                backoff_multiplier: 2,
                max_delay_seconds: 60
              }
            }
          })
        }
      };

      const result = await configService.validateConfiguration(req);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBe(0);
      expect(result.warnings).toBeDefined();
    });

    it('should provide detailed error messages for multiple schema violations', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            api_config: {
              timeouts: {
                default: "invalid",
                streaming: -1
              },
              logging: {
                defaultLevel: "INVALID"
              },
              hookDefinitions: {
                badHook: {
                  type: "header"
                  // Missing name
                }
              }
            }
          })
        }
      };

      const result = await configService.validateConfiguration(req);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(2); // Multiple errors
      
      // Check that all errors are schema validation errors
      result.errors.forEach((error: string) => {
        expect(error).toContain('Schema validation error');
      });
    });
  });
});