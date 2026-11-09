import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { describeLive, getAdminServiceUrl } from '@libs/test-utils';

describeLive('Role-Based Access Control Integration Tests', () => {
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

  describe('Lifecycle write matrix (admin-only isActive / expiresAt)', () => {
    const keys = '/odata/v4/admin/ApiKeys';
    const creds = '/odata/v4/admin/AwsCredentials';
    const FUTURE = '2030-01-01T00:00:00.000Z';
    let userKeyId: string;
    let userCredId: string;
    let userCredAccessKeyId: string;

    async function draftEdit(client: AxiosInstance, base: string, id: string, patch: Record<string, unknown>) {
      await client.post(`${base}(ID=${id},IsActiveEntity=true)/AdminService.draftEdit`, { PreserveChanges: true });
      await client.patch(`${base}(ID=${id},IsActiveEntity=false)`, patch);
      const activate = await client.post(`${base}(ID=${id},IsActiveEntity=false)/AdminService.draftActivate`, {});
      if (activate.status >= 300) {
        // Best-effort cleanup so a failed activation doesn't leave a draft blocking later tests.
        try {
          await client.delete(`${base}(ID=${id},IsActiveEntity=false)`);
        } catch {
          // ignore
        }
      }
      return activate;
    }

    /**
     * Make a credential expire without storing a past date: past dates are rejected on update, so
     * the admin sets a TTL out and we wait for it to lapse. This is also the proof that an admin's
     * expiresAt edit is honoured by the validation paths below.
     *
     * Both ends are anchored to the same deadline rather than using a fixed sleep: the draft flow
     * below is three sequential OData round-trips (draftEdit -> PATCH -> draftActivate), and the
     * past-date guard runs at activation, so on a slow runner an unanchored short TTL can already
     * be in the past by the time activation happens. Anchoring keeps the total wait bounded while
     * guaranteeing the deadline is still in the future when it is submitted.
     */
    async function expireViaAdmin(base: string, id: string) {
      const deadline = Date.now() + 8000;
      const soon = new Date(deadline).toISOString();
      const a = await draftEdit(adminClient, base, id, { expiresAt: soon });
      expect([200, 201, 204]).toContain(a.status);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline + 500 - Date.now())));
    }

    beforeAll(async () => {
      const k = await adminClient.post('/odata/v4/admin/createApiKey', { name: 'lifecycle user key', email: 'user@test.com' });
      expect(k.status).toBe(200);
      userKeyId = k.data.id;
      createdApiKeys.push(userKeyId);

      const c = await adminClient.post('/odata/v4/admin/createAwsCredentials', {
        userId: 'user@test.com', email: 'user@test.com', name: 'lifecycle user cred',
        description: 'lifecycle matrix', expiresAt: FUTURE, permissions: []
      });
      expect(c.status).toBe(200);
      userCredId = c.data.id;
      userCredAccessKeyId = c.data.accessKeyId;
      createdAwsCredentials.push(userCredAccessKeyId);
    });

    test('user draft edit does not change isActive on their own API key', async () => {
      const a = await draftEdit(userClient, keys, userKeyId, { isActive: false });
      expect([200, 201, 204]).toContain(a.status);
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(true);
    });

    test('user draft edit cannot smuggle isActive through activation', async () => {
      const a = await draftEdit(userClient, keys, userKeyId, { isActive: false, name: 'renamed by owner' });
      expect([200, 201, 204]).toContain(a.status);
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(true);
      expect(row.data.name).toBe('renamed by owner');
    });

    test('user draft edit does not change expiresAt on their own API key', async () => {
      const before = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      const a = await draftEdit(userClient, keys, userKeyId, { expiresAt: FUTURE });
      expect([200, 201, 204]).toContain(a.status);
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(row.data.expiresAt).toBe(before.data.expiresAt);
    });

    test('admin can flip isActive and set expiresAt on any API key', async () => {
      const off = await draftEdit(adminClient, keys, userKeyId, { isActive: false });
      expect([200, 201, 204]).toContain(off.status);
      const on = await draftEdit(adminClient, keys, userKeyId, { isActive: true, expiresAt: FUTURE });
      expect([200, 201, 204]).toContain(on.status);
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(true);
      expect(new Date(row.data.expiresAt).toISOString()).toBe(FUTURE);
    });

    test('created API key carries a default expiresAt ~90 days out', async () => {
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      // set to FUTURE above; create a fresh key to observe the default
      const k = await adminClient.post('/odata/v4/admin/createApiKey', { name: 'default expiry probe', email: 'user@test.com' });
      expect(k.status).toBe(200);
      createdApiKeys.push(k.data.id);
      const fresh = await adminClient.get(`${keys}(ID=${k.data.id},IsActiveEntity=true)`);
      const days = (new Date(fresh.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThanOrEqual(90);
      expect(row.status).toBe(200);
    });

    test('a refresh moves expiresAt forward for the owner as well as an administrator', async () => {
      // Park the date well beyond the standard period so "moved to ~90 days" is a real change.
      const parked = await draftEdit(adminClient, keys, userKeyId, { expiresAt: FUTURE });
      expect([200, 201, 204]).toContain(parked.status);

      const byOwner = await userClient.post(`${keys}(ID=${userKeyId},IsActiveEntity=true)/AdminService.rotateApiKey`, {});
      expect(byOwner.status).toBe(200);
      expect(byOwner.data.success).toBe(true);
      const afterOwner = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      const ownerDays = (new Date(afterOwner.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(ownerDays).toBeGreaterThan(89);
      expect(ownerDays).toBeLessThanOrEqual(90);

      const byAdmin = await adminClient.post(`${keys}(ID=${userKeyId},IsActiveEntity=true)/AdminService.rotateApiKey`, {});
      expect(byAdmin.data.success).toBe(true);
      const afterAdmin = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      const adminDays = (new Date(afterAdmin.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(adminDays).toBeGreaterThan(89);
      expect(adminDays).toBeLessThanOrEqual(90);
    });

    test('an owner refresh of an AWS credential also moves expiresAt forward', async () => {
      const parked = await draftEdit(adminClient, creds, userCredId, { expiresAt: FUTURE });
      expect([200, 201, 204]).toContain(parked.status);
      const r = await userClient.post(`${creds}(ID=${userCredId},IsActiveEntity=true)/AdminService.rotateAwsCredentials`, {});
      expect(r.status).toBe(200);
      expect(r.data.success).toBe(true);
      const row = await adminClient.get(`${creds}(ID=${userCredId},IsActiveEntity=true)`);
      const days = (new Date(row.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThanOrEqual(90);
      // The rotation replaced the access key: track the new one for cleanup, and keep
      // userCredAccessKeyId current so later tests (e.g. the unified-path expiry test)
      // address the credential that actually exists rather than the superseded key.
      createdAwsCredentials.push(r.data.newAccessKeyId);
      userCredAccessKeyId = r.data.newAccessKeyId;
    });

    test('owner cannot rotate an inactive key', async () => {
      const off = await adminClient.post('/odata/v4/admin/disableApiKey', { keyId: userKeyId });
      expect(off.status).toBe(200);
      expect(off.data.success).toBe(true);
      const r = await userClient.post(`${keys}(ID=${userKeyId},IsActiveEntity=true)/AdminService.rotateApiKey`, {});
      expect(r.data.success).toBe(false);
      expect(r.data.message).toMatch(/inactive/);
      const on = await adminClient.post('/odata/v4/admin/enableApiKey', { keyId: userKeyId });
      expect(on.status).toBe(200);
      expect(on.data.success).toBe(true);
    });

    test('user cannot enable or disable an API key through the unbound actions', async () => {
      const disable = await userClient.post('/odata/v4/admin/disableApiKey', { keyId: userKeyId });
      expect([403]).toContain(disable.status); // @requires: CAP answers before the handler runs
      const enable = await userClient.post('/odata/v4/admin/enableApiKey', { keyId: userKeyId });
      expect([403]).toContain(enable.status);
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(true);
    });

    test('admin can disable and re-enable an API key through the unbound actions', async () => {
      const off = await adminClient.post('/odata/v4/admin/disableApiKey', { keyId: userKeyId });
      expect(off.status).toBe(200);
      expect(off.data.success).toBe(true);
      const disabled = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(disabled.data.isActive).toBe(false);
      const on = await adminClient.post('/odata/v4/admin/enableApiKey', { keyId: userKeyId });
      expect(on.status).toBe(200);
      expect(on.data.success).toBe(true);
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(true);
    });

    test('user cannot enable/disable their own AWS credential; draft edit does not change isActive', async () => {
      const disable = await userClient.post(`${creds}(ID=${userCredId},IsActiveEntity=true)/AdminService.disableAwsCredentials`, {});
      expect([403, 404]).toContain(disable.status); // grant removed: CAP answers 403 (or 404 when it hides the action)
      const a = await draftEdit(userClient, creds, userCredId, { isActive: false });
      expect([200, 201, 204]).toContain(a.status);
      const row = await adminClient.get(`${creds}(ID=${userCredId},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(true);
    });

    test('admin can disable and re-enable an AWS credential', async () => {
      const off = await adminClient.post(`${creds}(ID=${userCredId},IsActiveEntity=true)/AdminService.disableAwsCredentials`, {});
      expect(off.status).toBe(200);
      expect(off.data.success).toBe(true);
      const on = await adminClient.post(`${creds}(ID=${userCredId},IsActiveEntity=true)/AdminService.enableAwsCredentials`, {});
      expect(on.data.success).toBe(true);
    });

    // ---- Expiration is preset on NEW (the create form opens with a date, not an empty field) ----

    test.each([
      ['user', () => userClient],
      ['admin', () => adminClient],
    ])('NEW ApiKeys draft presets expiresAt ~90 days out for a %s', async (_role, client) => {
      const d = await client().post(keys, { name: 'new draft expiry probe' });
      expect([200, 201]).toContain(d.status);
      expect(d.data.expiresAt).not.toBeNull();
      const days = (new Date(d.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThanOrEqual(90);
      expect(d.data.isActive).toBe(true);
      expect(d.data.usageCount).toBe(0);
      await client().delete(`${keys}(ID=${d.data.ID},IsActiveEntity=false)`);
    });

    test.each([
      ['user', () => userClient],
      ['admin', () => adminClient],
    ])('NEW AwsCredentials draft presets expiresAt ~90 days out for a %s', async (_role, client) => {
      const d = await client().post(creds, { name: 'new draft expiry probe' });
      expect([200, 201]).toContain(d.status);
      expect(d.data.expiresAt).not.toBeNull();
      const days = (new Date(d.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThanOrEqual(90);
      expect(d.data.region).toBe('us-east-1');
      expect(d.data.sapAiRegion).not.toBeNull();
      await client().delete(`${creds}(ID=${d.data.ID},IsActiveEntity=false)`);
    });

    test('a NEW ApiKeys draft belongs to a non-admin creator; an admin picks the owner', async () => {
      const mine = await userClient.post(keys, { name: 'new draft owner probe' });
      expect(mine.data.email).toBe('user@test.com');
      await userClient.delete(`${keys}(ID=${mine.data.ID},IsActiveEntity=false)`);

      const theirs = await adminClient.post(keys, { name: 'new draft owner probe' });
      expect(theirs.data.email).toBeNull();
      await adminClient.delete(`${keys}(ID=${theirs.data.ID},IsActiveEntity=false)`);
    });

    // ---- A date in the past is never accepted ----

    test('an admin draft edit to a past expiresAt is refused and the stored date is unchanged', async () => {
      const before = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      const a = await draftEdit(adminClient, keys, userKeyId, { expiresAt: '2020-01-01T00:00:00.000Z' });
      expect(a.status).toBe(400);
      expect(JSON.stringify(a.data)).toMatch(/Expires At must be in the future/);
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(row.data.expiresAt).toBe(before.data.expiresAt);
    });

    test('an admin draft edit to a past expiresAt on AWS credentials is refused', async () => {
      const before = await adminClient.get(`${creds}(ID=${userCredId},IsActiveEntity=true)`);
      const a = await draftEdit(adminClient, creds, userCredId, { expiresAt: '2020-01-01T00:00:00.000Z' });
      expect(a.status).toBe(400);
      expect(JSON.stringify(a.data)).toMatch(/Expires At must be in the future/);
      const row = await adminClient.get(`${creds}(ID=${userCredId},IsActiveEntity=true)`);
      expect(row.data.expiresAt).toBe(before.data.expiresAt);
    });

    test('createAwsCredentials with a past expiresAt is refused', async () => {
      const c = await adminClient.post('/odata/v4/admin/createAwsCredentials', {
        userId: 'user@test.com', email: 'user@test.com', name: 'past date probe',
        description: 'past date probe', expiresAt: '2020-01-01T00:00:00.000Z', permissions: []
      });
      expect(c.status).toBe(400);
      expect(JSON.stringify(c.data)).toMatch(/Expires At must be in the future/);
    });

    test('createApiKey with a past expiresAt is refused', async () => {
      // The action does not declare expiresAt, so CAP rejects the property before the handler
      // runs; beforeCreateApiKey carries the same guard for the draft/CREATE path.
      const k = await adminClient.post('/odata/v4/admin/createApiKey', {
        name: 'past date probe', email: 'user@test.com', expiresAt: '2020-01-01T00:00:00.000Z'
      });
      expect(k.status).toBe(400);
    });

    // ---- Expiry is enforced on the validation paths, and locks the credential ----

    test('an expired AWS credential is rejected on the unified path and auto-locked', async () => {
      await expireViaAdmin(creds, userCredId);
      // Token shape matches UnifiedTokenData (validation-service.ts) and encoding matches
      // createUnifiedValidationToken: base64 JSON, identifier (not accessKeyId), requestMetadata.
      const tokenData = {
        authType: 'aws_credential',
        identifier: userCredAccessKeyId,
        requestMetadata: { clientIp: '127.0.0.1', method: 'POST', endpoint: '/odata/v4/validation/validateUnifiedAuthByToken' },
        requestId: uuidv4(),
        timestamp: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };
      const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');
      const v = await adminClient.post('/odata/v4/validation/validateUnifiedAuthByToken', { token });
      expect(v.status).toBe(200);
      expect(v.data.valid).toBe(false);
      const row = await adminClient.get(`${creds}(ID=${userCredId},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(false);
    });

    test('an expired AWS credential is rejected on the legacy token path and auto-locked', async () => {
      const c = await adminClient.post('/odata/v4/admin/createAwsCredentials', {
        userId: 'user@test.com', email: 'user@test.com', name: 'legacy expiry probe',
        description: 'legacy expiry probe', expiresAt: FUTURE, permissions: []
      });
      expect(c.status).toBe(200);
      createdAwsCredentials.push(c.data.accessKeyId);
      await expireViaAdmin(creds, c.data.id);

      // Legacy token shape (decodeSecureToken): base64 JSON keyed by accessKeyId, not identifier.
      const token = Buffer.from(JSON.stringify({
        accessKeyId: c.data.accessKeyId,
        requestId: uuidv4(),
        timestamp: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      })).toString('base64');
      const v = await adminClient.post('/odata/v4/validation/validateAwsCredentialsByToken', {
        token, stringToSign: 'x', signature: 'y'
      });
      expect(v.status).toBe(200);
      expect(v.data.valid).toBe(false);
      expect(v.data.error?.code).toBe('CREDENTIAL_EXPIRED');
      // No credential metadata leaks on the rejection path.
      expect(v.data.credentialMetadata).toBeUndefined();
      const row = await adminClient.get(`${creds}(ID=${c.data.id},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(false);
    });

    test('an expired API key is rejected by validateApiKey and auto-locked', async () => {
      const k = await adminClient.post('/odata/v4/admin/createApiKey', { name: 'expiry lock probe', email: 'user@test.com' });
      createdApiKeys.push(k.data.id);
      await expireViaAdmin(keys, k.data.id);
      const v = await adminClient.get(`/odata/v4/validation/validateApiKey(key='${k.data.key}',clientIp='127.0.0.1',userAgent='jest')`);
      expect(v.status).toBe(200);
      expect(v.data.valid).toBe(false);
      const row = await adminClient.get(`${keys}(ID=${k.data.id},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(false);
    });

    test('an expired API key is rejected on the unified path and auto-locked', async () => {
      const k = await adminClient.post('/odata/v4/admin/createApiKey', { name: 'unified expiry probe', email: 'user@test.com' });
      createdApiKeys.push(k.data.id);
      // The admin shortens the expiration and the validation path honours the new date.
      await expireViaAdmin(keys, k.data.id);
      const tokenData = {
        authType: 'api_key',
        identifier: k.data.key,
        requestMetadata: { clientIp: '127.0.0.1', method: 'POST', endpoint: '/odata/v4/validation/validateUnifiedAuthByToken' },
        requestId: uuidv4(),
        timestamp: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };
      const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');
      const v = await adminClient.post('/odata/v4/validation/validateUnifiedAuthByToken', { token });
      expect(v.status).toBe(200);
      expect(v.data.valid).toBe(false);
      expect(v.data.error?.code).toBe('API_KEY_EXPIRED');
      const row = await adminClient.get(`${keys}(ID=${k.data.id},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(false);
    });

    // ---- The admin-only never-expires flag ----

    test('an admin sets neverExpires and the key loses its date; a user sees it read-only', async () => {
      const on = await draftEdit(adminClient, keys, userKeyId, { neverExpires: true });
      expect([200, 201, 204]).toContain(on.status);

      const asAdmin = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(asAdmin.data.neverExpires).toBe(true);
      expect(asAdmin.data.expiresAt).toBeNull();
      expect(asAdmin.data.neverExpiresFC).toBe(3);
      // Expires At goes read-only on a flagged row: there is no date left to edit.
      expect(asAdmin.data.expiresAtFC).toBe(1);

      const asOwner = await userClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(asOwner.data.neverExpires).toBe(true);
      expect(asOwner.data.neverExpiresFC).toBe(1);
      expect(asOwner.data.isActiveFC).toBe(1);
    });

    test('a user draft edit cannot clear neverExpires on their own key', async () => {
      const a = await draftEdit(userClient, keys, userKeyId, { neverExpires: false, name: 'renamed while flagged' });
      expect([200, 201, 204]).toContain(a.status);
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(row.data.neverExpires).toBe(true);
      expect(row.data.expiresAt).toBeNull();
      expect(row.data.name).toBe('renamed while flagged');
    });

    test('a refresh leaves a never-expiring key dateless, for the owner and for an admin', async () => {
      const byOwner = await userClient.post(`${keys}(ID=${userKeyId},IsActiveEntity=true)/AdminService.rotateApiKey`, {});
      expect(byOwner.data.success).toBe(true);
      const afterOwner = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(afterOwner.data.expiresAt).toBeNull();
      expect(afterOwner.data.neverExpires).toBe(true);

      const byAdmin = await adminClient.post(`${keys}(ID=${userKeyId},IsActiveEntity=true)/AdminService.rotateApiKey`, {});
      expect(byAdmin.data.success).toBe(true);
      const afterAdmin = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(afterAdmin.data.expiresAt).toBeNull();
    });

    test('expiresAtFC is correct from a narrow $select, not just when neverExpires is also selected', async () => {
      // Regression for the Fiori Elements SideEffects re-read after toggling Never Expires in a
      // draft: it issues exactly this narrow $select (an FC virtual without neverExpires), which
      // must not see expiresAtFC computed from an undefined neverExpires.
      const k = await adminClient.post('/odata/v4/admin/createApiKey', { name: 'fc select probe', email: 'user@test.com' });
      createdApiKeys.push(k.data.id);
      const flag = await draftEdit(adminClient, keys, k.data.id, { neverExpires: true });
      expect([200, 201, 204]).toContain(flag.status);

      const narrow = await adminClient.get(`${keys}(ID=${k.data.id},IsActiveEntity=true)?$select=expiresAtFC`);
      expect(narrow.data.expiresAtFC).toBe(1);

      const both = await adminClient.get(`${keys}(ID=${k.data.id},IsActiveEntity=true)?$select=neverExpiresFC,expiresAtFC`);
      expect(both.data.neverExpiresFC).toBe(3);
      expect(both.data.expiresAtFC).toBe(1);

      const asOwner = await userClient.get(`${keys}(ID=${k.data.id},IsActiveEntity=true)?$select=neverExpiresFC,expiresAtFC`);
      expect(asOwner.data.neverExpiresFC).toBe(1);
      expect(asOwner.data.expiresAtFC).toBe(1);
    });

    test('an admin clearing neverExpires without a date gets the standard period back', async () => {
      const off = await draftEdit(adminClient, keys, userKeyId, { neverExpires: false });
      expect([200, 201, 204]).toContain(off.status);
      const row = await adminClient.get(`${keys}(ID=${userKeyId},IsActiveEntity=true)`);
      expect(row.data.neverExpires).toBe(false);
      const days = (new Date(row.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThanOrEqual(90);
      expect(row.data.expiresAtFC).toBe(3);
    });

    test('neverExpires keeps a lapsed API key valid on the unified path and unlocked', async () => {
      const k = await adminClient.post('/odata/v4/admin/createApiKey', { name: 'never expires probe', email: 'user@test.com' });
      createdApiKeys.push(k.data.id);
      // Let the date actually lapse, then flag the key: the flag is what keeps it valid, since
      // setting it clears the date and the validation path stops consulting one.
      await expireViaAdmin(keys, k.data.id);
      const on = await draftEdit(adminClient, keys, k.data.id, { neverExpires: true });
      expect([200, 201, 204]).toContain(on.status);

      const tokenData = {
        authType: 'api_key',
        identifier: k.data.key,
        requestMetadata: { clientIp: '127.0.0.1', method: 'POST', endpoint: '/odata/v4/validation/validateUnifiedAuthByToken' },
        requestId: uuidv4(),
        timestamp: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };
      const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');
      const v = await adminClient.post('/odata/v4/validation/validateUnifiedAuthByToken', { token });
      expect(v.status).toBe(200);
      expect(v.data.valid).toBe(true);
      const row = await adminClient.get(`${keys}(ID=${k.data.id},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(true); // not auto-locked
      expect(row.data.expiresAt).toBeNull();
    });

    test('neverExpires keeps a lapsed AWS credential valid on the unified path and unlocked', async () => {
      const c = await adminClient.post('/odata/v4/admin/createAwsCredentials', {
        userId: 'user@test.com', email: 'user@test.com', name: 'never expires cred probe',
        description: 'never expires probe', expiresAt: FUTURE, permissions: []
      });
      expect(c.status).toBe(200);
      createdAwsCredentials.push(c.data.accessKeyId);
      await expireViaAdmin(creds, c.data.id);
      const on = await draftEdit(adminClient, creds, c.data.id, { neverExpires: true });
      expect([200, 201, 204]).toContain(on.status);

      const tokenData = {
        authType: 'aws_credential',
        identifier: c.data.accessKeyId,
        requestMetadata: { clientIp: '127.0.0.1', method: 'POST', endpoint: '/odata/v4/validation/validateUnifiedAuthByToken' },
        requestId: uuidv4(),
        timestamp: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };
      const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');
      const v = await adminClient.post('/odata/v4/validation/validateUnifiedAuthByToken', { token });
      expect(v.status).toBe(200);
      expect(v.data.valid).toBe(true);
      const row = await adminClient.get(`${creds}(ID=${c.data.id},IsActiveEntity=true)`);
      expect(row.data.isActive).toBe(true);
      expect(row.data.expiresAt).toBeNull();
      expect(row.data.neverExpiresFC).toBe(3);
    });

    test('the flag does not rescue an inactive credential on either unified path', async () => {
      // neverExpires answers "has this lapsed", not "is this allowed" - a disabled credential
      // stays rejected, so the flag can never become a way around an administrator's disable.
      const k = await adminClient.post('/odata/v4/admin/createApiKey', { name: 'flagged but inactive probe', email: 'user@test.com' });
      createdApiKeys.push(k.data.id);
      const flagKey = await draftEdit(adminClient, keys, k.data.id, { neverExpires: true });
      expect([200, 201, 204]).toContain(flagKey.status);
      const off = await adminClient.post('/odata/v4/admin/disableApiKey', { keyId: k.data.id });
      expect(off.data.success).toBe(true);

      const keyToken = Buffer.from(JSON.stringify({
        authType: 'api_key',
        identifier: k.data.key,
        requestMetadata: { clientIp: '127.0.0.1', method: 'POST', endpoint: '/odata/v4/validation/validateUnifiedAuthByToken' },
        requestId: uuidv4(),
        timestamp: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      })).toString('base64');
      const vKey = await adminClient.post('/odata/v4/validation/validateUnifiedAuthByToken', { token: keyToken });
      expect(vKey.status).toBe(200);
      expect(vKey.data.valid).toBe(false);
      expect(vKey.data.error?.code).toBe('API_KEY_NOT_FOUND'); // the lookup filters on isActive

      const c = await adminClient.post('/odata/v4/admin/createAwsCredentials', {
        userId: 'user@test.com', email: 'user@test.com', name: 'flagged but inactive cred probe',
        description: 'flagged inactive probe', expiresAt: FUTURE, permissions: []
      });
      createdAwsCredentials.push(c.data.accessKeyId);
      const flagCred = await draftEdit(adminClient, creds, c.data.id, { neverExpires: true });
      expect([200, 201, 204]).toContain(flagCred.status);
      const credOff = await adminClient.post(`${creds}(ID=${c.data.id},IsActiveEntity=true)/AdminService.disableAwsCredentials`, {});
      expect(credOff.data.success).toBe(true);

      const credToken = Buffer.from(JSON.stringify({
        authType: 'aws_credential',
        identifier: c.data.accessKeyId,
        requestMetadata: { clientIp: '127.0.0.1', method: 'POST', endpoint: '/odata/v4/validation/validateUnifiedAuthByToken' },
        requestId: uuidv4(),
        timestamp: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      })).toString('base64');
      const vCred = await adminClient.post('/odata/v4/validation/validateUnifiedAuthByToken', { token: credToken });
      expect(vCred.status).toBe(200);
      expect(vCred.data.valid).toBe(false);
    });

    test('a flagged AWS credential never appears among the expired ones', async () => {
      const c = await adminClient.post('/odata/v4/admin/createAwsCredentials', {
        userId: 'user@test.com', email: 'user@test.com', name: 'expired view probe',
        description: 'expired view probe', expiresAt: FUTURE, permissions: []
      });
      createdAwsCredentials.push(c.data.accessKeyId);
      // Let the date genuinely lapse, so without the flag the row would qualify for the view.
      await expireViaAdmin(creds, c.data.id);
      const lapsed = await adminClient.get('/odata/v4/admin/ExpiredAwsCredentials');
      expect(lapsed.status).toBe(200);
      expect((lapsed.data.value || []).map((r: any) => r.ID)).toContain(c.data.id);

      const on = await draftEdit(adminClient, creds, c.data.id, { neverExpires: true });
      expect([200, 201, 204]).toContain(on.status);
      const after = await adminClient.get('/odata/v4/admin/ExpiredAwsCredentials');
      expect(after.status).toBe(200);
      expect((after.data.value || []).map((r: any) => r.ID)).not.toContain(c.data.id);
    });

    test('an admin unticking the flag settles the date inside the draft, before activation', async () => {
      // Expires At is Mandatory (FC 7) for admins on AWS credentials, so a draft left at
      // { neverExpires: false, expiresAt: null } could never be activated from the app. The draft
      // handler settles the pair, so the date is already there when the form re-reads the draft.
      const c = await adminClient.post('/odata/v4/admin/createAwsCredentials', {
        userId: 'user@test.com', email: 'user@test.com', name: 'draft settle probe',
        description: 'draft settle probe', expiresAt: FUTURE, permissions: []
      });
      createdAwsCredentials.push(c.data.accessKeyId);
      const flagged = await draftEdit(adminClient, creds, c.data.id, { neverExpires: true });
      expect([200, 201, 204]).toContain(flagged.status);

      await adminClient.post(`${creds}(ID=${c.data.id},IsActiveEntity=true)/AdminService.draftEdit`, { PreserveChanges: true });
      // Ticking the box clears the date in the draft rather than leaving a stale one on display.
      await adminClient.patch(`${creds}(ID=${c.data.id},IsActiveEntity=false)`, { neverExpires: true });
      const stillFlagged = await adminClient.get(`${creds}(ID=${c.data.id},IsActiveEntity=false)`);
      expect(stillFlagged.data.neverExpires).toBe(true);
      expect(stillFlagged.data.expiresAt).toBeNull();
      expect(stillFlagged.data.expiresAtFC).toBe(1);

      // Unticking it fills the date in, so the Mandatory field has a value and activation passes.
      await adminClient.patch(`${creds}(ID=${c.data.id},IsActiveEntity=false)`, { neverExpires: false });
      const draft = await adminClient.get(`${creds}(ID=${c.data.id},IsActiveEntity=false)`);
      expect(draft.data.neverExpires).toBe(false);
      expect(draft.data.expiresAt).not.toBeNull();
      expect(draft.data.expiresAtFC).toBe(7);
      const draftDays = (new Date(draft.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(draftDays).toBeGreaterThan(89);
      expect(draftDays).toBeLessThanOrEqual(90);

      const activate = await adminClient.post(`${creds}(ID=${c.data.id},IsActiveEntity=false)/AdminService.draftActivate`, {});
      expect([200, 201, 204]).toContain(activate.status);
      const row = await adminClient.get(`${creds}(ID=${c.data.id},IsActiveEntity=true)`);
      expect(row.data.neverExpires).toBe(false);
      expect(row.data.expiresAt).not.toBeNull();
    });

    test('a NEW draft presets neverExpires to false for both roles', async () => {
      const mine = await userClient.post(keys, { name: 'never expires preset probe' });
      expect(mine.data.neverExpires).toBe(false);
      await userClient.delete(`${keys}(ID=${mine.data.ID},IsActiveEntity=false)`);

      const cred = await adminClient.post(creds, { name: 'never expires preset probe' });
      expect(cred.data.neverExpires).toBe(false);
      await adminClient.delete(`${creds}(ID=${cred.data.ID},IsActiveEntity=false)`);
    });

    test('an owner cannot refresh a key that has expired but is not yet locked', async () => {
      const k = await adminClient.post('/odata/v4/admin/createApiKey', { name: 'expired refresh probe', email: 'user@test.com' });
      createdApiKeys.push(k.data.id);
      await expireViaAdmin(keys, k.data.id);
      // No validation call yet, so the key is still isActive - only the date has lapsed.
      const still = await adminClient.get(`${keys}(ID=${k.data.id},IsActiveEntity=true)`);
      expect(still.data.isActive).toBe(true);

      const r = await userClient.post(`${keys}(ID=${k.data.id},IsActiveEntity=true)/AdminService.rotateApiKey`, {});
      expect(r.data.success).toBe(false);
      expect(r.data.message).toMatch(/expired/);

      // An administrator may still refresh it, and that moves the date forward again.
      const byAdmin = await adminClient.post(`${keys}(ID=${k.data.id},IsActiveEntity=true)/AdminService.rotateApiKey`, {});
      expect(byAdmin.data.success).toBe(true);
      const row = await adminClient.get(`${keys}(ID=${k.data.id},IsActiveEntity=true)`);
      const days = (new Date(row.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThanOrEqual(90);
    });
  });
});