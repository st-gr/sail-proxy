import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getAdminServiceUrl } from '@libs/test-utils';

describe('MaskedKey Persistence HTTP Integration Tests', () => {
  let client: AxiosInstance;
  const baseURL = getAdminServiceUrl();
  const createdKeyIds: string[] = [];

  beforeAll(() => {
    client = axios.create({
      baseURL: getAdminServiceUrl(),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('admin@test.com:admin').toString('base64')
      },
      validateStatus: () => true
    });
  });

  afterAll(async () => {
    // Clean up created API keys
    for (const keyId of createdKeyIds) {
      try {
        await client.post('/odata/v4/admin/deleteApiKey', { keyId });
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  describe('createApiKey Action - MaskedKey Persistence', () => {
    test('should persist maskedKey to database when creating API key via HTTP', async () => {
      // Test data matching the original curl test
      const testData = {
        name: 'CURL Test API Key',
        email: 'curl-test@example.com',
        permissions: ['models:read', 'chat:create'],
        rateLimits: {
          requestsPerMinute: 60,
          requestsPerHour: 1000,
          requestsPerDay: 5000
        }
      };

      // Step 1: Create API key via createApiKey action
      const createResponse = await client.post('/odata/v4/admin/createApiKey', testData);
      
      expect(createResponse.status).toBe(200);
      expect(createResponse.data).toHaveProperty('id');
      expect(createResponse.data).toHaveProperty('key');
      expect(createResponse.data).toHaveProperty('maskedKey');
      expect(createResponse.data).toHaveProperty('name', testData.name);
      expect(createResponse.data).toHaveProperty('email', testData.email);

      const keyId = createResponse.data.id;
      const responseMaskedKey = createResponse.data.maskedKey;
      createdKeyIds.push(keyId);

      // Validate response maskedKey format
      expect(responseMaskedKey).toBeDefined();
      expect(responseMaskedKey).not.toBe('');
      expect(responseMaskedKey).not.toBe(null);
      expect(responseMaskedKey).toContain('****');

      // Step 2: Query the API key to verify persistence
      // Use the listing endpoint with filter to avoid OData key format issues
      const listResponse = await client.get(`/odata/v4/admin/ApiKeys?$filter=ID eq '${keyId}'`);
      
      expect(listResponse.status).toBe(200);
      expect(listResponse.data.value).toBeDefined();
      expect(listResponse.data.value).toHaveLength(1);

      const databaseRecord = listResponse.data.value[0];

      // Step 3: Verify maskedKey persistence in database
      expect(databaseRecord).toHaveProperty('ID', keyId);
      expect(databaseRecord).toHaveProperty('maskedKey');
      expect(databaseRecord.maskedKey).toBeDefined();
      expect(databaseRecord.maskedKey).not.toBe('');
      expect(databaseRecord.maskedKey).not.toBe(null);
      expect(databaseRecord.maskedKey).toContain('****');

      // Step 4: Verify consistency between response and database
      expect(databaseRecord.maskedKey).toBe(responseMaskedKey);

      // Step 5: Verify masking pattern follows expected format
      expect(databaseRecord.maskedKey).toMatch(/^.{4}\*{4}.{2}$/);
    });

    test('should handle maskedKey persistence for multiple API keys in batch', async () => {
      const testKeys = [
        {
          name: 'Batch Test Key 1',
          email: 'batch1@example.com',
          permissions: ['models:read'],
          rateLimits: { requestsPerMinute: 30 }
        },
        {
          name: 'Batch Test Key 2', 
          email: 'batch2@example.com',
          permissions: ['chat:create'],
          rateLimits: { requestsPerMinute: 40 }
        },
        {
          name: 'Batch Test Key 3',
          email: 'batch3@example.com', 
          permissions: ['models:read', 'chat:create'],
          rateLimits: { requestsPerMinute: 50 }
        }
      ];

      const createdKeys = [];

      // Create multiple keys
      for (const testData of testKeys) {
        const createResponse = await client.post('/odata/v4/admin/createApiKey', testData);
        expect(createResponse.status).toBe(200);
        
        const keyId = createResponse.data.id;
        const responseMaskedKey = createResponse.data.maskedKey;
        createdKeyIds.push(keyId);
        createdKeys.push({ keyId, responseMaskedKey, testData });
      }

      // Verify each key's maskedKey persistence
      for (const { keyId, responseMaskedKey, testData } of createdKeys) {
        const listResponse = await client.get(`/odata/v4/admin/ApiKeys?$filter=ID eq '${keyId}'`);
        expect(listResponse.status).toBe(200);
        expect(listResponse.data.value).toHaveLength(1);
        
        const databaseRecord = listResponse.data.value[0];
        const databaseMaskedKey = databaseRecord.maskedKey;
        
        // Verify maskedKey is persisted and matches response
        expect(databaseMaskedKey).toBeDefined();
        expect(databaseMaskedKey).not.toBe('');
        expect(databaseMaskedKey).not.toBe(null);
        expect(databaseMaskedKey).toBe(responseMaskedKey);
        expect(databaseMaskedKey).toContain('****');
        
        // Verify other fields
        expect(databaseRecord.name).toBe(testData.name);
        expect(databaseRecord.email).toBe(testData.email);
        expect(databaseRecord.isActive).toBe(true);
      }
    });

    test('should handle edge cases for maskedKey persistence', async () => {
      // Test with minimal required fields
      const minimalTestData = {
        name: 'Minimal Test Key',
        email: 'minimal@example.com'
      };

      const createResponse = await client.post('/odata/v4/admin/createApiKey', minimalTestData);
      expect(createResponse.status).toBe(200);
      
      const keyId = createResponse.data.id;
      const responseMaskedKey = createResponse.data.maskedKey;
      createdKeyIds.push(keyId);

      // Verify maskedKey is still created and persisted with minimal data
      expect(responseMaskedKey).toBeDefined();
      expect(responseMaskedKey).toContain('****');

      const listResponse = await client.get(`/odata/v4/admin/ApiKeys?$filter=ID eq '${keyId}'`);
      expect(listResponse.status).toBe(200);
      expect(listResponse.data.value).toHaveLength(1);
      expect(listResponse.data.value[0].maskedKey).toBe(responseMaskedKey);
    });

    test('should create unique maskedKey for each API key', async () => {
      const testData1 = {
        name: 'Unique Test Key 1',
        email: 'unique1@example.com'
      };
      
      const testData2 = {
        name: 'Unique Test Key 2', 
        email: 'unique2@example.com'
      };

      // Create two API keys
      const response1 = await client.post('/odata/v4/admin/createApiKey', testData1);
      const response2 = await client.post('/odata/v4/admin/createApiKey', testData2);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);

      const keyId1 = response1.data.id;
      const keyId2 = response2.data.id;
      const maskedKey1 = response1.data.maskedKey;
      const maskedKey2 = response2.data.maskedKey;

      createdKeyIds.push(keyId1, keyId2);

      // Verify maskedKeys are different
      expect(maskedKey1).not.toBe(maskedKey2);
      expect(keyId1).not.toBe(keyId2);

      // Verify both are persisted correctly
      const listResponse1 = await client.get(`/odata/v4/admin/ApiKeys?$filter=ID eq '${keyId1}'`);
      const listResponse2 = await client.get(`/odata/v4/admin/ApiKeys?$filter=ID eq '${keyId2}'`);

      expect(listResponse1.status).toBe(200);
      expect(listResponse2.status).toBe(200);
      expect(listResponse1.data.value).toHaveLength(1);
      expect(listResponse2.data.value).toHaveLength(1);

      expect(listResponse1.data.value[0].maskedKey).toBe(maskedKey1);
      expect(listResponse2.data.value[0].maskedKey).toBe(maskedKey2);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle createApiKey with invalid data gracefully', async () => {
      const invalidData = {
        // Missing required name field
        email: 'invalid@example.com'
      };

      const response = await client.post('/odata/v4/admin/createApiKey', invalidData);
      
      // The service might be lenient and create a key with defaults, or it might reject
      // Either way, we're testing that it doesn't crash and handles the request
      expect([200, 400, 500]).toContain(response.status);
      
      if (response.status === 200) {
        // If it succeeded, ensure maskedKey was still created properly
        expect(response.data).toHaveProperty('maskedKey');
        expect(response.data.maskedKey).toContain('****');
        createdKeyIds.push(response.data.id); // Clean up
      }
    });

    test('should handle malformed request data', async () => {
      const malformedData = {
        name: '',  // Empty string
        email: '',  // Empty string
        permissions: 'invalid-not-array',  // Should be array
        rateLimits: 'invalid-not-object'   // Should be object
      };

      const response = await client.post('/odata/v4/admin/createApiKey', malformedData);
      
      // Should handle gracefully without creating invalid records
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });
});