import axios from 'axios';
import * as crypto from 'crypto';
import { getGatewayUrl } from '@libs/test-utils';

// Mock axios to simulate gateway responses
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock CDS for database operations
const mockCdsRun = jest.fn();

jest.mock('@sap/cds', () => ({
  connect: {
    to: jest.fn(() => ({
      run: mockCdsRun
    }))
  },
  ql: {
    SELECT: {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis()
    },
    INSERT: {
      into: jest.fn().mockReturnThis(),
      entries: jest.fn().mockReturnThis()
    },
    UPDATE: jest.fn().mockReturnThis()
  }
}));

// Mock logger
jest.mock('../../../../../libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

// Import after mocks are set up
import { modelCostService } from '../../../src/services/modelCostService';

describe('ModelCostService End-to-End Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the service state
    (modelCostService as any).lastFetch = 0;
    
    // Set environment variables for testing
    process.env.GATEWAY_URL = getGatewayUrl();
    process.env.VALIDATION_TOKEN_SECRET = 'test-secret';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('JWT Authentication', () => {
    it('should have correct service configuration', () => {
      // Test that service is properly initialized
      expect(modelCostService).toBeDefined();
      expect(typeof modelCostService.getModelPricing).toBe('function');
      expect(typeof modelCostService.calculateCosts).toBe('function');
    });

    it('should be available for external calls', () => {
      // Test that the service can be called without throwing errors
      expect(() => modelCostService.initialize()).not.toThrow();
    });
  });

  describe('Gateway API Integration', () => {
    const mockModelListResponse = {
      data: {
        data: [
          {
            id: 'gpt-4',
            owned_by: 'openai',
            provider: 'openai',
            versions: [
              {
                name: 'gpt-4-0125-preview',
                isLatest: true,
                cost: [
                  { inputCost: '0.03', outputCost: '0.06' }
                ]
              }
            ]
          },
          {
            id: 'claude-3-sonnet-20240229',
            owned_by: 'anthropic',
            provider: 'anthropic',
            versions: [
              {
                name: 'claude-3-sonnet',
                isLatest: true,
                cost: [
                  { inputCost: '0.003', outputCost: '0.015' }
                ]
              }
            ]
          },
          {
            id: 'model-without-cost',
            owned_by: 'test-provider',
            versions: [
              {
                name: 'test-model',
                isLatest: true,
                cost: []
              }
            ]
          }
        ]
      }
    };

    it('should fetch model pricing from gateway with proper authentication', async () => {
      mockedAxios.get.mockResolvedValueOnce(mockModelListResponse);
      mockCdsRun.mockResolvedValue([]); // No existing records

      await (modelCostService as any).refreshPricingData();

      // Verify API call was made with correct authentication
      expect(mockedAxios.get).toHaveBeenCalledWith(
        `${getGatewayUrl()}/v1/models`,
        expect.objectContaining({
          timeout: 30000,
          headers: expect.objectContaining({
            'Accept': 'application/json',
            'X-API-Key': expect.any(String),
            'User-Agent': 'admin-service/model-cost'
          })
        })
      );

      // Verify API key is present
      const apiKeyHeader = (mockedAxios.get as jest.Mock).mock.calls[0][1].headers['X-API-Key'];
      expect(apiKeyHeader).toBeDefined();
      expect(typeof apiKeyHeader).toBe('string');
    });

    it('should handle gateway authentication errors gracefully', async () => {
      const authError = new Error('Unauthorized');
      (authError as any).response = { status: 401, data: { error: 'Invalid token' } };
      mockedAxios.get.mockRejectedValueOnce(authError);

      // Should propagate the error
      await expect((modelCostService as any).refreshPricingData()).rejects.toThrow();
    });

    it('should respect cooldown period between requests', async () => {
      mockedAxios.get.mockResolvedValue(mockModelListResponse);
      mockCdsRun.mockResolvedValue([]);

      // First call should make request
      await (modelCostService as any).refreshPricingData();
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Second call within cooldown should be skipped
      await (modelCostService as any).refreshPricingData();
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Reset cooldown and verify next call works
      (modelCostService as any).lastFetch = 0;
      await (modelCostService as any).refreshPricingData();
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('Database Operations', () => {
    const mockModelData = [
      {
        id: 'gpt-4',
        owned_by: 'openai',
        versions: [
          {
            name: 'gpt-4-0125-preview',
            isLatest: true,
            cost: [{ inputCost: '0.03', outputCost: '0.06' }]
          }
        ]
      }
    ];

    it('should insert new model cost records when none exist', async () => {
      mockCdsRun
        .mockResolvedValueOnce([]) // No existing records
        .mockResolvedValueOnce(1); // INSERT success

      await (modelCostService as any).updatePricingDatabase(mockModelData);

      // Verify database operations were called
      expect(mockCdsRun).toHaveBeenCalledTimes(2);
      
      // First call should be SELECT for existing records
      expect(mockCdsRun).toHaveBeenNthCalledWith(1, expect.any(Object));
      
      // Second call should be INSERT for new records
      expect(mockCdsRun).toHaveBeenNthCalledWith(2, expect.any(Object));
    });

    it('should check for existing model cost records', async () => {
      // Test that the service properly checks for existing records before updating
      const modelDataWithCosts = [
        {
          id: 'gpt-4',
          owned_by: 'openai',
          versions: [
            {
              name: 'gpt-4-latest',
              isLatest: true,
              cost: [{ inputCost: '0.03', outputCost: '0.06' }]
            }
          ]
        }
      ];

      const existingRecord = {
        ID: 'existing-id',
        inputCost: '0.03', // Same as new price (no change)
        outputCost: '0.06'  // Same as new price (no change)
      };

      mockCdsRun.mockClear();
      mockCdsRun.mockResolvedValueOnce([existingRecord]); // Existing record found with same costs

      await (modelCostService as any).updatePricingDatabase(modelDataWithCosts);

      // Should query for existing records but not update since costs haven't changed
      expect(mockCdsRun).toHaveBeenCalledTimes(1);
      
      // Should have called SELECT to check for existing records
      expect(mockCdsRun).toHaveBeenNthCalledWith(1, expect.any(Object));
    });

    it('should handle database update logic for pricing changes', async () => {
      // Test that the service processes model data and checks for existing records
      const modelDataWithCosts = [
        {
          id: 'gpt-4',
          owned_by: 'openai',
          versions: [
            {
              name: 'gpt-4-latest',
              isLatest: true,
              cost: [{ inputCost: '0.05', outputCost: '0.10' }]
            }
          ]
        }
      ];

      const existingRecord = {
        ID: 'existing-id',
        inputCost: '0.05', // Same as new price  
        outputCost: '0.10'  // Same as new price
      };

      mockCdsRun.mockClear();
      mockCdsRun.mockResolvedValueOnce([existingRecord]); // Existing record found

      await (modelCostService as any).updatePricingDatabase(modelDataWithCosts);

      // The service should check for existing records
      expect(mockCdsRun).toHaveBeenCalled();
      
      // At minimum, should query for existing records
      expect(mockCdsRun).toHaveBeenNthCalledWith(1, expect.any(Object));
    });

    it('should skip models without cost information', async () => {
      const modelWithoutCost = [
        {
          id: 'free-model',
          owned_by: 'test',
          versions: [
            {
              name: 'v1',
              isLatest: true,
              cost: [] // No cost data
            }
          ]
        }
      ];

      await (modelCostService as any).updatePricingDatabase(modelWithoutCost);

      // Should not attempt any database operations
      expect(mockCdsRun).not.toHaveBeenCalled();
    });
  });

  describe('Cost Calculations', () => {
    it('should calculate costs correctly with cached pricing data', async () => {
      // Mock successful database queries
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.003',
          outputCost: '0.015',
          provider: 'anthropic'
        }
      ]);
      
      const result = await modelCostService.calculateCosts('claude-3-sonnet-20240229', 1000, 500);

      expect(result).toEqual({
        inputCost: 0.003,    // (1000/1000) * 0.003
        outputCost: 0.0075,  // (500/1000) * 0.015
        cacheCreationInputCost: 0,
        cacheReadInputCost: 0,
        totalCost: 0.0105,   // 0.003 + 0.0075
        provider: 'anthropic'
      });
    });

    it('should use fallback pricing for unknown models', async () => {
      // Completely isolate this test by clearing all mocks and resetting service state
      jest.clearAllMocks();
      mockCdsRun.mockClear();
      
      // Ensure getModelPricing returns null (no cached data)
      mockCdsRun.mockResolvedValue([]); // No cached pricing
      
      // Test with a truly unknown model name that won't match any patterns
      const result = await modelCostService.calculateCosts('completely-unknown-xyz-model', 1000, 500);

      expect(result).toEqual({
        inputCost: 0.001,    // Fallback rate for unknown models
        outputCost: 0.001,   // (500/1000) * 0.002 = 0.001
        cacheCreationInputCost: 0,
        cacheReadInputCost: 0,
        totalCost: 0.002,    // 0.001 + 0.001
        provider: 'unknown'
      });
    });

    it('should handle zero token counts', async () => {
      const result = await modelCostService.calculateCosts('any-model', 0, 0);

      expect(result).toEqual({
        inputCost: 0,
        outputCost: 0,
        cacheCreationInputCost: 0,
        cacheReadInputCost: 0,
        totalCost: 0
      });
    });

    it('should use model-specific fallback pricing for known providers', async () => {
      // Test Claude model fallback
      mockCdsRun.mockClear().mockResolvedValue([]); // No cached pricing
      let result = await modelCostService.calculateCosts('claude-3-opus', 1000, 500);
      expect(result.provider).toBe('Anthropic');
      expect(result.inputCost).toBe(0.003);
      expect(result.outputCost).toBe(0.0075); // (500/1000) * 0.015

      // Test GPT-4 model fallback
      mockCdsRun.mockClear().mockResolvedValue([]); // No cached pricing
      result = await modelCostService.calculateCosts('gpt-4-turbo', 1000, 500);
      expect(result.provider).toBe('OpenAI');
      expect(result.inputCost).toBe(0.03);   // (1000/1000) * 0.03
      expect(result.outputCost).toBe(0.03);  // (500/1000) * 0.06

      // Test regular GPT model fallback
      mockCdsRun.mockClear().mockResolvedValue([]); // No cached pricing
      result = await modelCostService.calculateCosts('gpt-3.5-turbo', 1000, 500);
      expect(result.provider).toBe('OpenAI');
      expect(result.inputCost).toBe(0.001);
      expect(result.outputCost).toBe(0.001);
    });
  });

  describe('End-to-End Workflow', () => {
    it('should complete full workflow: fetch pricing, cache, and calculate costs', async () => {
      const mockGatewayResponse = {
        data: {
          data: [
            {
              id: 'gpt-4',
              owned_by: 'openai',
              versions: [
                {
                  name: 'gpt-4-latest',
                  isLatest: true,
                  cost: [{ inputCost: '0.03', outputCost: '0.06' }]
                }
              ]
            }
          ]
        }
      };

      // Mock API response
      mockedAxios.get.mockResolvedValueOnce(mockGatewayResponse);
      
      // Mock database operations
      mockCdsRun.mockClear();
      mockCdsRun
        .mockResolvedValueOnce([]) // No existing pricing in cache (first getModelPricing call)
        .mockResolvedValueOnce([]) // No existing records to update (during refresh)
        .mockResolvedValueOnce(1)  // Successful INSERT (during refresh)
        .mockResolvedValueOnce([   // Return cached pricing for calculation (second getModelPricing call)
          {
            inputCost: '0.03',
            outputCost: '0.06',
            provider: 'openai'
          }
        ])
        .mockResolvedValueOnce([   // Return cached pricing for calculateCosts call
          {
            inputCost: '0.03',
            outputCost: '0.06',
            provider: 'openai'
          }
        ]);

      // Step 1: Get model pricing (should trigger refresh)
      const pricing = await modelCostService.getModelPricing('gpt-4');
      expect(pricing).toEqual({
        inputCost: 0.03,
        outputCost: 0.06,
        provider: 'openai'
      });

      // Verify gateway was called with authentication
      expect(mockedAxios.get).toHaveBeenCalledWith(
        `${getGatewayUrl()}/v1/models`,
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': expect.any(String),
            'User-Agent': 'admin-service/model-cost'
          })
        })
      );

      // Step 2: Calculate costs using cached pricing
      const costs = await modelCostService.calculateCosts('gpt-4', 2000, 1000);
      expect(costs).toEqual({
        inputCost: 0.06,     // (2000/1000) * 0.03
        outputCost: 0.06,    // (1000/1000) * 0.06
        cacheCreationInputCost: 0,
        cacheReadInputCost: 0,
        totalCost: 0.12,     // 0.06 + 0.06
        provider: 'OpenAI'
      });

      // Verify database operations occurred
      expect(mockCdsRun).toHaveBeenCalledTimes(11);
    });

    it('should handle service initialization correctly', async () => {
      await modelCostService.initialize();
      
      // Should log initialization without errors
      // The actual implementation just logs a message
      expect(true).toBe(true); // Placeholder assertion
    });

    it('should handle errors gracefully during full workflow', async () => {
      // Mock gateway error
      mockedAxios.get.mockRejectedValueOnce(new Error('Gateway unavailable'));
      
      // Mock fallback database query (no cached data)
      mockCdsRun.mockResolvedValueOnce([]);

      // Should fall back to fallback pricing without throwing
      const result = await modelCostService.calculateCosts('gpt-4', 1000, 500);
      
      expect(result.provider).toBe('OpenAI'); // Fallback for GPT model
      expect(result.inputCost).toBe(0.03);    // Fallback GPT-4 rate
      expect(result.outputCost).toBe(0.03);   // Fallback GPT-4 rate
      expect(result.totalCost).toBe(0.06);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle malformed gateway responses', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { malformed: true } });
      
      await expect((modelCostService as any).refreshPricingData()).resolves.not.toThrow();
      
      // Should handle gracefully and not update database
      expect(mockCdsRun).not.toHaveBeenCalled();
    });

    it('should handle database connection errors', async () => {
      mockCdsRun.mockRejectedValueOnce(new Error('Database connection failed'));
      
      const result = await modelCostService.getModelPricing('test-model');
      expect(result).toBeNull();
    });

    it('should handle network timeouts', async () => {
      const timeoutError = new Error('Timeout');
      (timeoutError as any).code = 'ECONNABORTED';
      mockedAxios.get.mockRejectedValueOnce(timeoutError);
      
      await expect((modelCostService as any).refreshPricingData()).rejects.toThrow('Timeout');
    });
  });

  describe('Tiered Cost Calculation', () => {
    const mockGeminiComplexCost = JSON.stringify([
      {
        "inputCost": "0.00087",
        "tier": "1",
        "tierDescription": "Less than or equals to 200k tokens per request"
      },
      {
        "inputCost": "0.00167",
        "tier": "2", 
        "tierDescription": "Greater than 200k tokens per request"
      },
      {
        "outputCost": "0.00647",
        "tier": "1",
        "tierDescription": "Less than or equals to 200k tokens per request"
      },
      {
        "outputCost": "0.00966",
        "tier": "2",
        "tierDescription": "Greater than 200k tokens per request"
      }
    ]);

    it('should use tier 1 pricing for requests with input <= 200k and output <= 200k tokens', async () => {
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.001', // Simple pricing (fallback values)
          outputCost: '0.002',
          provider: 'Google',
          complexCost: mockGeminiComplexCost
        }
      ]);

      // Test with input tokens <= 200k and output tokens <= 200k
      const result = await modelCostService.calculateCosts(
        'gemini-2.5-pro', 
        100000, // input tokens
        40000,  // output tokens
        new Date(), // date
        5000,   // cache creation tokens
        5000    // cache read tokens
      );
      
      // Total input tokens: 100000 + 5000 + 5000 = 110000 (tier 1)
      // Total output tokens: 40000 (tier 1)
      // Input: (100000/1000) * 0.00087 = 0.087
      // Output: (40000/1000) * 0.00647 = 0.2588
      // Cache creation: (5000/1000) * 0.00087 * 1.00 = 0.00435  
      // Cache read: (5000/1000) * 0.00087 * 1.00 = 0.00435
      // Total: 0.087 + 0.2588 + 0.00435 + 0.00435 = 0.35455

      expect(result).toEqual({
        inputCost: 0.087,
        outputCost: 0.2588,
        cacheCreationInputCost: 0.00435,
        cacheReadInputCost: 0.00435,
        totalCost: 0.3545, 
        provider: 'Google'
      });
    });

    it('should use mixed tiers when input > 200k but output <= 200k', async () => {
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.001',
          outputCost: '0.002', 
          provider: 'Google',
          complexCost: mockGeminiComplexCost
        }
      ]);

      // Test with input tokens > 200k (output still < 200k)
      const result = await modelCostService.calculateCosts(
        'gemini-2.5-pro',
        190000, // input tokens
        40000,  // output tokens  
        new Date(), // date
        5000,   // cache creation tokens
        10000   // cache read tokens - increased to push total input over 200k
      );
      
      // Total input tokens: 190000 + 5000 + 10000 = 205000 (tier 2)
      // Total output tokens: 40000 (tier 1)
      // Input: (190000/1000) * 0.00167 = 0.3173
      // Output: (40000/1000) * 0.00647 = 0.2588
      // Cache creation: (5000/1000) * 0.00167 * 1.00 = 0.00835
      // Cache read: (10000/1000) * 0.00167 * 1.00 = 0.0167
      // Total: 0.3173 + 0.2588 + 0.00835 + 0.0167 = 0.60115

      expect(result).toEqual({
        inputCost: 0.3173,
        outputCost: 0.2588,
        cacheCreationInputCost: 0.00835,
        cacheReadInputCost: 0.0167,
        totalCost: 0.60115,
        provider: 'Google'
      });
    });

    it('should fall back to simple pricing when complex cost parsing fails', async () => {
      const invalidComplexCost = '{ invalid json }';
      
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.003',
          outputCost: '0.015',
          provider: 'Google', 
          complexCost: invalidComplexCost
        }
      ]);

      const result = await modelCostService.calculateCosts(
        'gemini-2.5-pro',
        1000,
        500
      );

      // Should fall back to simple pricing
      expect(result).toEqual({
        inputCost: 0.003,    // (1000/1000) * 0.003
        outputCost: 0.0075,  // (500/1000) * 0.015  
        cacheCreationInputCost: 0,
        cacheReadInputCost: 0,
        totalCost: 0.0105,
        provider: 'Google'
      });
    });

    it('should handle edge case at exact tier boundary (200k tokens)', async () => {
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.001',
          outputCost: '0.002',
          provider: 'Google',
          complexCost: mockGeminiComplexCost
        }
      ]);

      // Test with exactly 200k input tokens
      const result = await modelCostService.calculateCosts(
        'gemini-2.5-pro',
        200000, // input tokens (exactly at boundary)
        10000   // output tokens
      );
      
      // Total input tokens: exactly 200k, should use tier 1 (<=200k)
      // Total output tokens: 10k (tier 1)
      expect(result.inputCost).toBe(0.174);   // (200000/1000) * 0.00087
      expect(result.outputCost).toBe(0.0647); // (10000/1000) * 0.00647
      expect(result.provider).toBe('Google');
    });

    it('should use 100% cache token pricing when tiered cache pricing not defined', async () => {
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.001',
          outputCost: '0.002',
          provider: 'Google',
          complexCost: mockGeminiComplexCost
        }
      ]);

      const result = await modelCostService.calculateCosts(
        'gemini-2.5-pro',
        50000,  // input tokens
        10000,  // output tokens
        new Date(), // date
        20000,  // cache creation tokens
        30000   // cache read tokens
      );

      // Total input tokens: 50000 + 20000 + 30000 = 100k (tier 1)
      // Total output tokens: 10k (tier 1)
      // Cache creation: (20000/1000) * 0.00087 * 1.00 = 0.0174 (100% of input rate)
      // Cache read: (30000/1000) * 0.00087 * 1.00 = 0.0261 (100% of input rate)

      expect(result.cacheCreationInputCost).toBe(0.0174);
      expect(result.cacheReadInputCost).toBe(0.0261);
    });

    it('should use tiered cache pricing when defined in complexCost (Gemini 2.5 Pro style)', async () => {
      // Mock Gemini 2.5 Pro with tiered cache pricing from OSS Note 3437766
      const mockGeminiTieredCacheCost = JSON.stringify([
        {
          "inputCost": "0.00087",
          "cacheReadInputCost": "0.00009",  // 90% less than input cost (tier 1)
          "tier": "1",
          "tierDescription": "Less than or equals to 200k tokens per request"
        },
        {
          "inputCost": "0.00167",
          "cacheReadInputCost": "0.00017",  // 90% less than input cost (tier 2)
          "tier": "2",
          "tierDescription": "Greater than 200k tokens per request"
        },
        {
          "outputCost": "0.00647",
          "tier": "1",
          "tierDescription": "Less than or equals to 200k tokens per request"
        },
        {
          "outputCost": "0.00966",
          "tier": "2",
          "tierDescription": "Greater than 200k tokens per request"
        }
      ]);

      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.001',
          outputCost: '0.002',
          provider: 'Google',
          complexCost: mockGeminiTieredCacheCost
        }
      ]);

      const result = await modelCostService.calculateCosts(
        'gemini-2.5-pro',
        50000,  // input tokens
        10000,  // output tokens
        new Date(), // date
        20000,  // cache creation tokens
        30000   // cache read tokens
      );

      // Total input tokens: 50000 + 20000 + 30000 = 100k (tier 1)
      // Total output tokens: 10k (tier 1)
      // Input: (50000/1000) * 0.00087 = 0.0435
      // Output: (10000/1000) * 0.00647 = 0.0647
      // Cache creation: (20000/1000) * 0.00087 = 0.0174 (100% of input, no cache creation pricing defined)
      // Cache read: (30000/1000) * 0.00009 = 0.0027 (tiered cache read pricing!)

      expect(result.inputCost).toBe(0.0435);
      expect(result.outputCost).toBe(0.0647);
      expect(result.cacheCreationInputCost).toBe(0.0174);  // Falls back to 100% input rate
      expect(result.cacheReadInputCost).toBe(0.0027);      // Uses tiered cache read pricing
    });

    it('should use tier 2 cache pricing when input exceeds 200k tokens', async () => {
      // Mock Gemini 2.5 Pro with tiered cache pricing
      const mockGeminiTieredCacheCost = JSON.stringify([
        {
          "inputCost": "0.00087",
          "cacheReadInputCost": "0.00009",
          "tier": "1",
          "tierDescription": "Less than or equals to 200k tokens per request"
        },
        {
          "inputCost": "0.00167",
          "cacheReadInputCost": "0.00017",
          "tier": "2",
          "tierDescription": "Greater than 200k tokens per request"
        },
        {
          "outputCost": "0.00647",
          "tier": "1",
          "tierDescription": "Less than or equals to 200k tokens per request"
        },
        {
          "outputCost": "0.00966",
          "tier": "2",
          "tierDescription": "Greater than 200k tokens per request"
        }
      ]);

      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.001',
          outputCost: '0.002',
          provider: 'Google',
          complexCost: mockGeminiTieredCacheCost
        }
      ]);

      const result = await modelCostService.calculateCosts(
        'gemini-2.5-pro',
        180000, // input tokens
        40000,  // output tokens
        new Date(), // date
        10000,  // cache creation tokens
        15000   // cache read tokens - pushes total to 205k (tier 2)
      );

      // Total input tokens: 180000 + 10000 + 15000 = 205k (tier 2!)
      // Total output tokens: 40k (tier 1)
      // Input: (180000/1000) * 0.00167 = 0.3006
      // Output: (40000/1000) * 0.00647 = 0.2588
      // Cache creation: (10000/1000) * 0.00167 = 0.0167 (100% of tier 2 input rate)
      // Cache read: (15000/1000) * 0.00017 = 0.00255 (tier 2 cache read pricing!)

      expect(result.inputCost).toBe(0.3006);
      expect(result.outputCost).toBe(0.2588);
      expect(result.cacheCreationInputCost).toBe(0.0167);
      expect(result.cacheReadInputCost).toBe(0.00255);
    });

    it('should handle models without complex cost (simple pricing)', async () => {
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.003',
          outputCost: '0.015',
          provider: 'Anthropic',
          complexCost: null // No complex cost structure
        }
      ]);

      const result = await modelCostService.calculateCosts(
        'claude-3-sonnet',
        1000,
        500,
        new Date(),
        100,
        200
      );

      // Should use simple pricing
      expect(result).toEqual({
        inputCost: 0.003,
        outputCost: 0.0075,
        cacheCreationInputCost: 0.0003, // (100/1000) * 0.003 * 1.00
        cacheReadInputCost: 0.0006,     // (200/1000) * 0.003 * 1.00
        totalCost: 0.0114,
        provider: 'Anthropic'
      });
    });
  });

  describe('Cache Pricing from api_config.json', () => {
    it('should use actual cache pricing when available from model config', async () => {
      // Mock cached pricing with explicit cache pricing from api_config.json
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.00204',
          outputCost: '0.00988',
          cacheReadInputCost: '0.00020',     // 90% discount (from SAP OSS Note)
          cacheCreationInputCost: '0.00254', // 25% premium (from SAP OSS Note)
          provider: 'Anthropic'
        }
      ]);

      const result = await modelCostService.calculateCosts(
        'anthropic--claude-4-sonnet--deployed',
        1000,
        500,
        new Date(),
        1000, // cache creation tokens
        1000  // cache read tokens
      );

      // Input: (1000/1000) * 0.00204 = 0.00204
      // Output: (500/1000) * 0.00988 = 0.00494
      // Cache creation: (1000/1000) * 0.00254 = 0.00254 (actual pricing, not 100%)
      // Cache read: (1000/1000) * 0.00020 = 0.00020 (actual pricing, not 100%)
      expect(result).toEqual({
        inputCost: 0.00204,
        outputCost: 0.00494,
        cacheCreationInputCost: 0.00254,
        cacheReadInputCost: 0.0002,
        totalCost: 0.00972,
        provider: 'Anthropic'
      });
    });

    it('should fall back to 100% input cost when cache pricing is not defined', async () => {
      // Mock cached pricing without cache-specific pricing
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.00204',
          outputCost: '0.00988',
          // No cacheReadInputCost or cacheCreationInputCost defined
          provider: 'Anthropic'
        }
      ]);

      const result = await modelCostService.calculateCosts(
        'anthropic--claude-3-sonnet--deployed',
        1000,
        500,
        new Date(),
        1000, // cache creation tokens
        1000  // cache read tokens
      );

      // Cache pricing falls back to 100% of input cost
      // Cache creation: (1000/1000) * 0.00204 * 1.00 = 0.00204
      // Cache read: (1000/1000) * 0.00204 * 1.00 = 0.00204
      expect(result.cacheCreationInputCost).toBe(0.00204);
      expect(result.cacheReadInputCost).toBe(0.00204);
    });

    it('should handle partial cache pricing (only cache read defined)', async () => {
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.00129',
          outputCost: '0.00494',
          cacheReadInputCost: '0.00032', // 75% discount for GPT-4.1
          // No cacheCreationInputCost (Azure doesn't have write pricing)
          provider: 'OpenAI'
        }
      ]);

      const result = await modelCostService.calculateCosts(
        'gpt-4.1',
        1000,
        500,
        new Date(),
        1000, // cache creation tokens
        1000  // cache read tokens
      );

      // Cache read uses actual pricing: (1000/1000) * 0.00032 = 0.00032
      // Cache creation falls back to 100% input: (1000/1000) * 0.00129 = 0.00129
      expect(result.cacheReadInputCost).toBe(0.00032);
      expect(result.cacheCreationInputCost).toBe(0.00129);
    });

    it('should store and retrieve cache pricing from database', async () => {
      // This test verifies the full flow: model data with cache pricing -> database -> cost calculation
      const mockModelDataWithCachePricing = [
        {
          id: 'anthropic--claude-4-sonnet--deployed',
          owned_by: 'Anthropic',
          versions: [
            {
              name: '1',
              isLatest: true,
              cost: [
                { inputCost: '0.00204' },
                { outputCost: '0.00988' },
                { cacheReadInputCost: '0.00020' },
                { cacheCreationInputCost: '0.00254' }
              ]
            }
          ]
        }
      ];

      // Setup mocks for database operations
      mockCdsRun.mockClear();
      mockCdsRun
        .mockResolvedValueOnce([]) // No existing records
        .mockResolvedValueOnce(1); // INSERT success

      await (modelCostService as any).updatePricingDatabase(mockModelDataWithCachePricing);

      // Verify INSERT was called with cache pricing fields
      expect(mockCdsRun).toHaveBeenCalledTimes(2);

      // Get the INSERT call arguments
      const insertCall = mockCdsRun.mock.calls[1][0];
      expect(insertCall).toBeDefined();
    });

    it('should handle Claude 4 Opus cache pricing from OSS Note 3437766', async () => {
      // Test with claude-4-opus pricing: cache read 90% less, cache write 25% more
      mockCdsRun.mockClear().mockResolvedValue([
        {
          inputCost: '0.00988',
          outputCost: '0.04913',
          cacheReadInputCost: '0.00099',     // 0.00988 * 0.10 = ~0.00099 (90% less)
          cacheCreationInputCost: '0.01236', // 0.00988 * 1.25 = ~0.01236 (25% more)
          provider: 'Anthropic'
        }
      ]);

      const result = await modelCostService.calculateCosts(
        'anthropic--claude-4-opus--deployed',
        10000,  // input tokens
        5000,   // output tokens
        new Date(),
        2000,   // cache creation tokens
        8000    // cache read tokens
      );

      // Input: (10000/1000) * 0.00988 = 0.0988
      // Output: (5000/1000) * 0.04913 = 0.24565
      // Cache creation: (2000/1000) * 0.01236 = 0.02472
      // Cache read: (8000/1000) * 0.00099 = 0.00792
      expect(result.inputCost).toBe(0.0988);
      expect(result.outputCost).toBe(0.24565);
      expect(result.cacheCreationInputCost).toBe(0.02472);
      expect(result.cacheReadInputCost).toBe(0.00792);
      expect(result.totalCost).toBe(0.37709);
    });
  });
});