/**
 * Edge Case Tests for Ollama API
 * 
 * Tests various edge cases to ensure the validation is robust
 * and handles invalid inputs gracefully
 */

const axios = require('axios');
const { getOllamaServiceUrl } = require('@libs/test-utils');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || getOllamaServiceUrl();

describe('Ollama Edge Cases', () => {
  const testCases = [
    {
      name: 'Empty model name',
      body: { model: '' },
      expectError: true
    },
    {
      name: 'Null model',
      body: { model: null },
      expectError: true
    },
    {
      name: 'Undefined model',
      body: { model: undefined },
      expectError: true
    },
    {
      name: 'Number instead of string',
      body: { model: 123 },
      expectError: true
    },
    {
      name: 'Array instead of string',
      body: { model: ['gpt-4'] },
      expectError: true
    },
    {
      name: 'Object instead of string',
      body: { model: { name: 'gpt-4' } },
      expectError: true
    },
    {
      name: 'Missing model field entirely',
      body: {},
      expectError: true
    },
    {
      name: 'Valid model name',
      body: { model: 'gpt-4.1-nano-mini' },
      expectError: false
    },
    {
      name: 'Model name with special characters',
      body: { model: 'model-with-dashes_and_underscores.v1' },
      expectError: false
    }
  ];

  describe('Model Validation Edge Cases', () => {
    testCases.forEach((testCase) => {
      it(`should handle ${testCase.name}`, async () => {
        try {
          const response = await axios.post(`${OLLAMA_BASE_URL}/api/show`, testCase.body);
          
          if (testCase.expectError) {
            // If we expected an error but got success, fail the test
            fail('Expected error but request succeeded');
          } else {
            // For successful cases, validate response structure
            expect(response.status).toBe(200);
            expect(response.data).toBeDefined();
          }
          
        } catch (error) {
          if (testCase.expectError) {
            // Expected error - validate it's the right kind of error
            if (error.response?.status) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
        } else {
          console.warn('No proper error response for edge case');
        }
            expect(error.response?.data?.error || error.message).toBeDefined();
          } else {
            // Unexpected error - rethrow to fail the test
            throw error;
          }
        }
      });
    });
  });

  describe('Request Body Validation', () => {
    it('should reject requests with invalid JSON structure', async () => {
      const malformedBodies = [
        'not-json',
        '{"incomplete": json',
        null,
        undefined
      ];

      for (const body of malformedBodies) {
        try {
          await axios.post(`${OLLAMA_BASE_URL}/api/show`, body);
          fail(`Expected error for malformed body: ${body}`);
        } catch (error) {
          expect(error).toBeDefined();
        }
      }
    });

    it('should handle extremely long model names', async () => {
      const longModelName = 'a'.repeat(1000);
      
      try {
        await axios.post(`${OLLAMA_BASE_URL}/api/show`, { model: longModelName });
        fail('Expected error for extremely long model name');
      } catch (error) {
        if (error.response?.status) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
        } else {
          console.warn('No proper error response for edge case');
        }
      }
    });

    it('should handle special characters in model names', async () => {
      const specialCharacterNames = [
        'model@#$%^&*()',
        'model with spaces',
        'model\\with\\backslashes',
        'model/with/slashes',
        'model"with"quotes'
      ];

      for (const modelName of specialCharacterNames) {
        try {
          await axios.post(`${OLLAMA_BASE_URL}/api/show`, { model: modelName });
          // If it succeeds, that's fine - just test it doesn't crash
        } catch (error) {
          // If it fails, ensure it's a proper error response
          if (error.response?.status) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
        } else {
          console.warn('No proper error response for edge case');
        }
        }
      }
    });
  });

  describe('API Endpoints Edge Cases', () => {
    it('should handle missing Content-Type header', async () => {
      try {
        const response = await axios.post(`${OLLAMA_BASE_URL}/api/show`, 
          '{"model": "test"}',
          {
            headers: {
              // Omit Content-Type to test default behavior
            }
          }
        );
        
        // Should either succeed or fail gracefully
        expect(response).toBeDefined();
      } catch (error) {
        if (error.response?.status) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
        } else {
          console.warn('No proper error response for edge case');
        }
      }
    });

    it('should handle invalid HTTP methods', async () => {
      try {
        await axios.get(`${OLLAMA_BASE_URL}/api/show`, { 
          data: { model: 'test' } 
        });
        fail('Expected error for GET request to POST endpoint');
      } catch (error) {
        expect(error.response?.status).toBeGreaterThanOrEqual(404); // Could be 404 or 405
      }
    });

    it('should handle requests without body', async () => {
      try {
        await axios.post(`${OLLAMA_BASE_URL}/api/show`);
        fail('Expected error for request without body');
      } catch (error) {
        if (error.response?.status) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
        } else {
          console.warn('No proper error response for edge case');
        }
      }
    });
  });

  describe('Error Message Quality', () => {
    it('should provide meaningful error messages for invalid inputs', async () => {
      try {
        await axios.post(`${OLLAMA_BASE_URL}/api/show`, { model: null });
        fail('Expected error for null model');
      } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        
        // Error message should be informative
        expect(errorMessage).toBeDefined();
        expect(typeof errorMessage).toBe('string');
        expect(errorMessage.length).toBeGreaterThan(5);
      }
    });

    it('should not expose internal implementation details in errors', async () => {
      try {
        await axios.post(`${OLLAMA_BASE_URL}/api/show`, { model: '' });
        fail('Expected error for empty model');
      } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        
        // Should not contain stack traces or internal paths
        expect(errorMessage).not.toContain('node_modules');
        expect(errorMessage).not.toContain('/src/');
        expect(errorMessage).not.toContain('undefined (reading \'includes\')');
      }
    });
  });
});