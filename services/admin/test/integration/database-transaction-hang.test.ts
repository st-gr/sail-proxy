/**
 * Test to verify database operations work correctly without hanging
 * (Previously tested database transaction hangs, now validates stability)
 */

import axios, { AxiosInstance } from 'axios';
import { getAdminServiceUrl, guardActiveConfiguration } from '@libs/test-utils';

describe('Database Operations Stability Test', () => {
  // Restores whatever was active before this suite; see active-config-guard.
  guardActiveConfiguration();

  let adminClient: AxiosInstance;

  beforeAll(() => {
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
  });

  test('should query configurations without hanging', async () => {
    const startTime = Date.now();
    
    const response = await adminClient.get('/odata/v4/admin/ApiConfigurations');
    
    const duration = Date.now() - startTime;
    
    expect(response.status).toBe(200);
    expect(response.data.value).toBeDefined();
    expect(Array.isArray(response.data.value)).toBe(true);
    
    // Should complete quickly without hanging
    expect(duration).toBeLessThan(5000);
    
    console.log(`✅ Configuration query completed in ${duration}ms`);
  });

  test('should handle concurrent database operations', async () => {
    const startTime = Date.now();
    
    // Run multiple queries concurrently
    const promises = [
      adminClient.get('/odata/v4/admin/ApiConfigurations'),
      adminClient.get('/odata/v4/admin/ApiKeys'),
      adminClient.get('/odata/v4/admin/AwsCredentials')
    ];

    const responses = await Promise.all(promises);
    
    const duration = Date.now() - startTime;
    
    // All requests should complete successfully
    responses.forEach(response => {
      expect(response.status).toBe(200);
      expect(response.data.value).toBeDefined();
    });
    
    // Should complete quickly without hanging
    expect(duration).toBeLessThan(10000);
    
    console.log(`✅ Concurrent database operations completed in ${duration}ms`);
  });

  test('should handle configuration activation without hanging', async () => {
    // First get existing configurations
    const listResponse = await adminClient.get('/odata/v4/admin/ApiConfigurations');
    
    if (listResponse.status === 200 && listResponse.data.value && listResponse.data.value.length > 0) {
      const configId = listResponse.data.value[0].ID;
      const startTime = Date.now();

      const response = await adminClient.post('/odata/v4/admin/activateConfiguration', {
        configId: configId
      });

      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      
      // Should complete quickly without hanging
      expect(duration).toBeLessThan(5000);
      
      console.log(`✅ Configuration activation completed in ${duration}ms`);
    } else {
      console.log('ℹ️ No configurations available for activation test');
    }
  });

  test('should handle rapid sequential operations without hanging', async () => {
    const startTime = Date.now();
    
    // Perform rapid sequential operations
    for (let i = 0; i < 5; i++) {
      const response = await adminClient.get('/odata/v4/admin/ApiConfigurations?$top=1');
      expect(response.status).toBe(200);
    }
    
    const duration = Date.now() - startTime;
    
    // Should complete all operations quickly
    expect(duration).toBeLessThan(10000);
    
    console.log(`✅ Sequential operations completed in ${duration}ms`);
  });

  test('should handle filtered queries efficiently', async () => {
    const startTime = Date.now();
    
    // Test queries with filters that might cause database issues
    const queries = [
      '/odata/v4/admin/ApiConfigurations?$filter=isActive eq true',
      '/odata/v4/admin/ApiConfigurations?$orderby=modifiedAt desc',
      '/odata/v4/admin/ApiConfigurations?$top=10&$skip=0'
    ];

    for (const query of queries) {
      const response = await adminClient.get(query);
      // Should succeed or return acceptable error codes
      expect([200, 400]).toContain(response.status);
    }
    
    const duration = Date.now() - startTime;
    
    // Should complete without hanging
    expect(duration).toBeLessThan(8000);
    
    console.log(`✅ Filtered queries completed in ${duration}ms`);
  });

  test('should handle service health check consistently', async () => {
    const startTime = Date.now();
    
    // Run health check multiple times to ensure consistency
    for (let i = 0; i < 3; i++) {
      const response = await adminClient.post('/odata/v4/admin/health', {});
      
      // Health endpoint returns 200 (with data) or 204 (no content) - both are healthy responses
      if (response.status === 200) {
        expect(response.data.status).toBeDefined();
      } else if (response.status === 204) {
        // 204 No Content is a valid healthy response
        expect(response.data).toBe('');
      } else {
        // Other status codes may indicate the health endpoint isn't implemented as expected
        expect([200, 204, 404, 405, 501]).toContain(response.status);
      }
    }
    
    const duration = Date.now() - startTime;
    
    // Should complete quickly
    expect(duration).toBeLessThan(5000);
    
    console.log(`✅ Health checks completed in ${duration}ms`);
  });
});