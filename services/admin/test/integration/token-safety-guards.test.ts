/**
 * Safety Guard Tests
 * 
 * Ensures existing functionality continues to work after unified token implementation
 * Quick smoke tests to prevent regression
 */

import axios, { AxiosInstance } from 'axios';
import { getAdminServiceUrl } from '@libs/test-utils';

const ADMIN_SERVICE_URL = getAdminServiceUrl();
const ADMIN_AUTH = 'Basic ' + Buffer.from('admin@test.com:admin').toString('base64');

describe('Token Safety Guards', () => {
  let client: AxiosInstance;

  beforeAll(() => {
    client = axios.create({
      baseURL: ADMIN_SERVICE_URL,
      headers: { 'Authorization': ADMIN_AUTH },
      timeout: 10000,
      validateStatus: () => true
    });
  });

  describe('Basic Service Health', () => {
    it('should have working health endpoint', async () => {
      const health = await client.get('/odata/v4/validation/health()');
      
      expect(health.status).toBe(200);
      expect(health.data.status).toBe('healthy');
    });

    it('should have accessible cache stats endpoint', async () => {
      const cache = await client.get('/odata/v4/validation/getCacheStats()');
      
      expect(cache.status).toBe(200);
    });

    it('should have accessible admin service', async () => {
      const adminService = await client.get('/');
      
      expect(adminService.status).toBe(200);
    });
  });

  describe('Backward Compatibility', () => {
    it('should support original token creation', async () => {
      const oldToken = await client.post('/odata/v4/validation/createValidationToken', {
        accessKeyId: 'AKIA123TEST',
        signature: 'test-signature',
        clientIp: '127.0.0.1',
        method: 'POST',
        endpoint: '/test'
      });
      
      expect(oldToken.status).toBe(200);
      expect(oldToken.data.token).toBeDefined();
    });
  });
});