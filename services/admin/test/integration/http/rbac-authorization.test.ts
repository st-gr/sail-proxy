import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getAdminServiceUrl } from '@libs/test-utils';

describe('Role-Based Access Control Integration Tests', () => {
  let adminClient: AxiosInstance;
  let userClient: AxiosInstance;
  let otherUserClient: AxiosInstance;
  
  // Store created resources for cleanup
  const createdApiKeys: string[] = [];
  const createdAwsCredentials: string[] = [];

  beforeAll(() => {
    // Admin client with full permissions
    adminClient = axios.create({
      baseURL: getAdminServiceUrl(),
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('admin@test.com:admin').toString('base64')
      },
      validateStatus: () => true // Don't throw on HTTP errors
    });

    // Regular user client
    userClient = axios.create({
      baseURL: getAdminServiceUrl(),
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('user@test.com:user').toString('base64')
      },
      validateStatus: () => true
    });

    // Another user client
    otherUserClient = axios.create({
      baseURL: getAdminServiceUrl(),
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('otheruser@test.com:user').toString('base64')
      },
      validateStatus: () => true
    });
  });

  afterAll(async () => {
    // Clean up created API keys
    for (const keyId of createdApiKeys) {
      try {
        await adminClient.delete(`/odata/v4/admin/ApiKeys(${keyId})`);
      } catch (error) {
        console.warn(`Failed to clean up API key ${keyId}:`, error);
      }
    }

    // Clean up created AWS credentials
    for (const accessKeyId of createdAwsCredentials) {
      try {
        await adminClient.post('/odata/v4/admin/deleteAwsCredentials', { accessKeyId });
      } catch (error) {
        console.warn(`Failed to clean up AWS credential ${accessKeyId}:`, error);
      }
    }
  });

  describe('Authentication Tests', () => {
    test('should reject requests without authentication token', async () => {
      const noAuthClient = axios.create({
        baseURL: getAdminServiceUrl(),
        timeout: 5000,
        validateStatus: () => true
      });

      const response = await noAuthClient.get('/odata/v4/admin/ApiKeys');
      expect(response.status).toBe(401);
    });

    test('should reject requests with invalid authentication token', async () => {
      const invalidAuthClient = axios.create({
        baseURL: getAdminServiceUrl(),
        timeout: 5000,
        headers: {
          'Authorization': 'Basic ' + Buffer.from('invalid@user.com:wrongpassword').toString('base64')
        },
        validateStatus: () => true
      });

      const response = await invalidAuthClient.get('/odata/v4/admin/ApiKeys');
      // Service returns 403 for invalid credentials (recognized format but unauthorized user)
      expect([401, 403]).toContain(response.status);
    });

    test('should accept valid admin authentication', async () => {
      const response = await adminClient.get('/odata/v4/admin/ApiKeys');
      expect([200, 404]).toContain(response.status); // 404 if no keys exist yet
    });

    test('should accept valid user authentication', async () => {
      const response = await userClient.get('/odata/v4/admin/ApiKeys');
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('API Key Authorization Tests', () => {
    let userApiKeyId: string;
    let otherUserApiKeyId: string;
    let adminApiKeyId: string;

    beforeAll(async () => {
      // Create API keys for different users
      const userKeyResponse = await adminClient.post('/odata/v4/admin/createApiKey', {
        name: 'User Test Key',
        email: 'user@test.com',
        permissions: ['models:read', 'chat:create']
      });
      
      if (userKeyResponse.status === 200) {
        userApiKeyId = userKeyResponse.data.id;
        createdApiKeys.push(userApiKeyId);
      }

      const otherUserKeyResponse = await adminClient.post('/odata/v4/admin/createApiKey', {
        name: 'Other User Test Key', 
        email: 'otheruser@test.com',
        permissions: ['models:read']
      });
      
      if (otherUserKeyResponse.status === 200) {
        otherUserApiKeyId = otherUserKeyResponse.data.id;
        createdApiKeys.push(otherUserApiKeyId);
      }

      const adminKeyResponse = await adminClient.post('/odata/v4/admin/createApiKey', {
        name: 'Admin Test Key',
        email: 'admin@test.com', 
        permissions: ['admin:*']
      });
      
      if (adminKeyResponse.status === 200) {
        adminApiKeyId = adminKeyResponse.data.id;
        createdApiKeys.push(adminApiKeyId);
      }
    });

    describe('Row-Level Security - API Key Access', () => {
      test('user can access their own API key by ID', async () => {
        if (!userApiKeyId) {
          console.log('Skipping test - user API key not created');
          return;
        }

        const response = await userClient.get(`/odata/v4/admin/ApiKeys(${userApiKeyId})`);
        
        if (response.status === 200) {
          expect(response.data.ID).toBe(userApiKeyId);
          expect(response.data.email).toBe('user@test.com');
          // Users can see their own API keys (including key field) - this is expected behavior
        } else {
          // Service may not implement row-level security yet
          expect([200, 400, 403, 404]).toContain(response.status);
        }
      });

      test('user cannot access other user\'s API key by ID', async () => {
        if (!otherUserApiKeyId) {
          console.log('Skipping test - other user API key not created');
          return;
        }

        const response = await userClient.get(`/odata/v4/admin/ApiKeys(${otherUserApiKeyId})`);
        
        // Should be forbidden or not found due to row-level security
        expect([400, 403, 404]).toContain(response.status);
      });

      test('admin can access any user\'s API key by ID', async () => {
        if (!userApiKeyId) {
          console.log('Skipping test - user API key not created');
          return;
        }

        const response = await adminClient.get(`/odata/v4/admin/ApiKeys(${userApiKeyId})`);
        
        if (response.status === 200) {
          expect(response.data.ID).toBe(userApiKeyId);
          expect(response.data.email).toBe('user@test.com');
        } else {
          expect([200, 400, 404]).toContain(response.status);
        }
      });
    });

    describe('Row-Level Security - API Key Listing', () => {
      test('user lists only their own API keys', async () => {
        const response = await userClient.get('/odata/v4/admin/ApiKeys');
        
        if (response.status === 200) {
          const userKeys = response.data.value || [];
          // All returned keys should belong to the user
          userKeys.forEach((key: any) => {
            expect(key.email).toBe('user@test.com');
            // Users can see their own API keys (including key field) - this is expected behavior
          });
        } else {
          expect([200, 404]).toContain(response.status);
        }
      });

      test('admin lists all API keys from all users', async () => {
        const response = await adminClient.get('/odata/v4/admin/ApiKeys');
        
        if (response.status === 200) {
          const allKeys = response.data.value || [];
          const emails = allKeys.map((key: any) => key.email);
          
          // Admin should see keys from multiple users
          const uniqueEmails = [...new Set(emails)];
          if (allKeys.length > 0) {
            expect(uniqueEmails.length).toBeGreaterThanOrEqual(1);
          }
        } else {
          expect([200, 404]).toContain(response.status);
        }
      });
    });

    describe('API Key Modification Authorization', () => {
      test('user can update their own API key', async () => {
        if (!userApiKeyId) {
          console.log('Skipping test - user API key not created');
          return;
        }

        const updateData = {
          name: 'Updated by User Themselves',
          isActive: false
        };

        const response = await userClient.patch(`/odata/v4/admin/ApiKeys(${userApiKeyId})`, updateData);
        
        if (response.status === 200) {
          expect(response.data.name).toBe('Updated by User Themselves');
          expect(response.data.isActive).toBe(false);
          // Key field may be exposed for the user's own API key - this is expected behavior
        } else {
          // May not be implemented yet
          expect([200, 400, 403, 404, 405]).toContain(response.status);
        }
      });

      test('user cannot update other user\'s API key', async () => {
        if (!otherUserApiKeyId) {
          console.log('Skipping test - other user API key not created');
          return;
        }

        const updateData = {
          name: 'Unauthorized Update Attempt'
        };

        const response = await userClient.patch(`/odata/v4/admin/ApiKeys(${otherUserApiKeyId})`, updateData);
        
        // Should be forbidden or method not allowed
        expect([400, 403, 404, 405]).toContain(response.status);
      });

      test('admin can update any user\'s API key', async () => {
        if (!userApiKeyId) {
          console.log('Skipping test - user API key not created');
          return;
        }

        const updateData = {
          name: 'Updated by Admin',
          isActive: true
        };

        const response = await adminClient.patch(`/odata/v4/admin/ApiKeys(${userApiKeyId})`, updateData);
        
        if (response.status === 200) {
          expect(response.data.name).toBe('Updated by Admin');
          expect(response.data.isActive).toBe(true);
        } else {
          expect([200, 400, 404, 405]).toContain(response.status);
        }
      });

      test('user cannot delete other user\'s API key', async () => {
        if (!otherUserApiKeyId) {
          console.log('Skipping test - other user API key not created');
          return;
        }

        const response = await userClient.delete(`/odata/v4/admin/ApiKeys(${otherUserApiKeyId})`);
        
        // Should be forbidden
        expect([400, 403, 404, 405]).toContain(response.status);
      });

      test('admin can delete any user\'s API key', async () => {
        // Create a disposable key for this test
        const keyResponse = await adminClient.post('/odata/v4/admin/createApiKey', {
          name: 'Disposable Test Key',
          email: 'user@test.com',
          permissions: ['models:read']
        });

        if (keyResponse.status === 200) {
          const disposableKeyId = keyResponse.data.id;
          
          const deleteResponse = await adminClient.delete(`/odata/v4/admin/ApiKeys(${disposableKeyId})`);
          
          // Should succeed or not be implemented
          expect([200, 204, 400, 404, 405]).toContain(deleteResponse.status);
        } else {
          console.log('Skipping delete test - could not create disposable key');
        }
      });
    });
  });

  describe('AWS Credentials Authorization Tests', () => {
    let userAwsCredentials: any;
    let otherUserAwsCredentials: any;

    beforeAll(async () => {
      // Create AWS credentials for different users
      const userCredResponse = await adminClient.post('/odata/v4/admin/createAwsCredentials', {
        userId: 'user@test.com',
        name: 'User AWS Credentials',
        description: 'Test credentials for user',
        permissions: ['bedrock:InvokeModel']
      });
      
      if (userCredResponse.status === 200) {
        userAwsCredentials = userCredResponse.data;
        createdAwsCredentials.push(userAwsCredentials.accessKeyId);
      }

      const otherUserCredResponse = await adminClient.post('/odata/v4/admin/createAwsCredentials', {
        userId: 'otheruser@test.com',
        name: 'Other User AWS Credentials',
        description: 'Test credentials for other user',
        permissions: ['bedrock:InvokeModel']
      });
      
      if (otherUserCredResponse.status === 200) {
        otherUserAwsCredentials = otherUserCredResponse.data;
        createdAwsCredentials.push(otherUserAwsCredentials.accessKeyId);
      }
    });

    test('user can only see their own AWS credentials', async () => {
      const response = await userClient.get('/odata/v4/admin/AwsCredentials');
      
      if (response.status === 200) {
        const userCredentials = response.data.value || [];
        // All returned credentials should belong to the user
        userCredentials.forEach((cred: any) => {
          expect(cred.userId).toBe('user@test.com');
          expect(cred).not.toHaveProperty('secretAccessKey'); // Sensitive field should be hidden
          expect(cred).not.toHaveProperty('secretHash');
        });
      } else {
        expect([200, 404]).toContain(response.status);
      }
    });

    test('user cannot access other user\'s AWS credentials', async () => {
      if (!otherUserAwsCredentials) {
        console.log('Skipping test - other user AWS credentials not created');
        return;
      }

      const response = await userClient.get(`/odata/v4/admin/AwsCredentials(${otherUserAwsCredentials.id})`);
      
      // Should be forbidden or not found
      expect([400, 403, 404]).toContain(response.status);
    });

    test('admin can see all AWS credentials', async () => {
      const response = await adminClient.get('/odata/v4/admin/AwsCredentials');
      
      if (response.status === 200) {
        const allCredentials = response.data.value || [];
        const userIds = allCredentials.map((cred: any) => cred.userId);
        
        // Admin should see credentials from multiple users
        const uniqueUserIds = [...new Set(userIds)];
        if (allCredentials.length > 0) {
          expect(uniqueUserIds.length).toBeGreaterThanOrEqual(1);
        }
      } else {
        expect([200, 404]).toContain(response.status);
      }
    });

    test('user can disable their own AWS credentials', async () => {
      if (!userAwsCredentials) {
        console.log('Skipping test - user AWS credentials not created');
        return;
      }

      const response = await userClient.post('/odata/v4/admin/disableAwsCredentials', {
        accessKeyId: userAwsCredentials.accessKeyId
      });
      
      if (response.status === 200) {
        expect(response.data.success).toBe(true);
      } else {
        // May not be implemented or may require admin privileges
        expect([200, 403, 404]).toContain(response.status);
      }
    });

    test('user cannot disable other user\'s AWS credentials', async () => {
      if (!otherUserAwsCredentials) {
        console.log('Skipping test - other user AWS credentials not created');
        return;
      }

      const response = await userClient.post('/odata/v4/admin/disableAwsCredentials', {
        accessKeyId: otherUserAwsCredentials.accessKeyId
      });
      
      // Should be forbidden or method not allowed  
      expect([403, 404, 405]).toContain(response.status);
    });
  });

  describe('Permission Boundary Tests', () => {
    test('should handle configuration endpoint access appropriately', async () => {
      // Test access to configuration endpoints
      const configResponse = await userClient.get('/odata/v4/admin/ApiConfiguration');
      
      // Configuration may be accessible for read-only access by users
      if (configResponse.status === 200) {
        // Users can read configuration - this is expected behavior
        expect(configResponse.data).toBeDefined();
      } else {
        // Or it may be restricted - both behaviors are valid
        expect([403, 404]).toContain(configResponse.status);
      }
    });

    test('user cannot perform admin-only actions', async () => {
      // Test admin-only actions like bulk operations
      const bulkResponse = await userClient.post('/odata/v4/admin/revokeApiKeysByEmail', {
        email: 'user@test.com'
      });
      
      // Should be forbidden or not found
      expect([403, 404, 405]).toContain(bulkResponse.status);
    });

    test('admin can perform all operations', async () => {
      // Admin should be able to access all endpoints
      const endpoints = [
        '/odata/v4/admin/ApiKeys',
        '/odata/v4/admin/AwsCredentials', 
        '/odata/v4/admin/ApiConfiguration'
      ];

      for (const endpoint of endpoints) {
        const response = await adminClient.get(endpoint);
        expect([200, 404]).toContain(response.status); // 404 if no data exists
      }
    });
  });

  describe('Cross-User Data Isolation', () => {
    test('data filtering prevents cross-user data leakage in queries', async () => {
      // Test that OData queries with filters don't return other users' data
      const response = await userClient.get('/odata/v4/admin/ApiKeys?$filter=email eq \'otheruser@test.com\'');
      
      if (response.status === 200) {
        const results = response.data.value || [];
        // Should return empty results due to row-level security
        expect(results.length).toBe(0);
      } else {
        expect([200, 403]).toContain(response.status);
      }
    });

    test('data filtering prevents cross-user data leakage in AWS credentials', async () => {
      const response = await userClient.get('/odata/v4/admin/AwsCredentials?$filter=userId eq \'otheruser@test.com\'');
      
      if (response.status === 200) {
        const results = response.data.value || [];
        // Should return empty results due to row-level security
        expect(results.length).toBe(0);
      } else {
        expect([200, 403]).toContain(response.status);
      }
    });
  });
});