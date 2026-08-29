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
              platform: {
                timeouts: {
                  default: "not_a_number",
                  streaming: 600000
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

    it('should reject configuration with invalid logging level', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            api_config: {
              platform: {
                logging: {
                  defaultLevel: "INVALID_LEVEL"
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

    it('should reject configuration with incomplete hook definition', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            api_config: {
              hooks: {
                definitions: {
                  testHook: {
                    type: "header"
                    // Missing required 'name' property for header type
                  }
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
              providers: {
                openrouter: {
                  default_pricing: {
                    completion: "0.001"
                    // Missing required 'image' and 'prompt' properties
                  }
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
              platform: {
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
                rate_limit_handling: {
                  enabled: true,
                  default_delay_seconds: 1,
                  backoff_multiplier: 2,
                  max_delay_seconds: 60
                }
              },
              providers: {
                anthropic: {
                  substitute_models: [
                    {
                      from: "claude-3-5-haiku-20241022",
                      to: "anthropic--claude-3-haiku--deployed",
                      description: "Test substitution"
                    }
                  ]
                }
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
              platform: {
                timeouts: {
                  default: "invalid",
                  streaming: -1
                },
                logging: {
                  defaultLevel: "INVALID"
                }
              },
              hooks: {
                definitions: {
                  badHook: {
                    type: "header"
                    // Missing name
                  }
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

    // The save path really does use `formatSchemaError`, and really does drop Ajv's umbrella
    // `propertyNames` error: one message, naming the key and the allowed set, pointed at the key
    // itself rather than at the provider - see `src/srv/schemaErrors.ts` for why.
    it('names the key and the allowed set for a setting under a provider that does not read it', async () => {
      const req = {
        data: {
          configData: JSON.stringify({
            api_config: {
              providers: {
                openai: { anthropic_bedrock_version: 'bedrock-2023-05-31' }
              }
            }
          })
        }
      };

      const result = await configService.validateConfiguration(req);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        "Schema validation error at '/api_config/providers/openai/anthropic_bedrock_version': " +
        'property "anthropic_bedrock_version" is not one of the settings this provider reads ' +
        '(allowed: emulate_streaming_for_models, substitute_models, unsupported_params, ' +
        'param_renames, supports_responses_api, supports_prompt_caching, ' +
        'openai_deployment_api_version)'
      ]);
    });
  });
});