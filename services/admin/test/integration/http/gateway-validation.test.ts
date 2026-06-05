import axios from 'axios';
import { getAdminServiceUrl } from '@libs/test-utils';

describe('Gateway Validation Functions Integration Tests', () => {
  const baseURL = `${getAdminServiceUrl()}/odata/v4/admin`;
  const client = axios.create({
    baseURL,
    auth: {
      username: 'admin@test.com',
      password: 'admin'
    }
  });

  let testApiKey: string;
  let testApiKeyId: string;
  let testAwsAccessKeyId: string;
  let testAwsCredentialId: string;

  beforeAll(async () => {
    // Create test API key
    const apiKeyResponse = await client.post('/createApiKey', {
      name: 'Gateway Validation Test API Key',
      email: 'gateway-test@example.com',
      permissions: ['read', 'write']
    });
    
    expect(apiKeyResponse.status).toBe(200);
    testApiKey = apiKeyResponse.data.key;
    testApiKeyId = apiKeyResponse.data.id;

    // Create test AWS credentials
    const awsResponse = await client.post('/createAwsCredentials', {
      name: 'Gateway Validation Test AWS Creds',
      permissions: ['bedrock:InvokeModel']
    });
    
    expect(awsResponse.status).toBe(200);
    testAwsAccessKeyId = awsResponse.data.accessKeyId;
    testAwsCredentialId = awsResponse.data.id;
  });

  afterAll(async () => {
    // Clean up test data
    try {
      if (testApiKeyId) {
        await client.post('/deleteApiKey', { keyId: testApiKeyId });
      }
      if (testAwsAccessKeyId) {
        await client.post('/deleteAwsCredentials', { accessKeyId: testAwsAccessKeyId });
      }
    } catch (error) {
      console.warn('Cleanup error:', error);
    }
  });

  describe('getApiKeyByKey', () => {
    test('should find existing API key', async () => {
      const response = await client.get(`/getApiKeyByKey(key='${testApiKey}')`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('found');
      expect(response.data.found).toBe(true);
      expect(response.data).toHaveProperty('keyInfo');
      
      const keyInfo = response.data.keyInfo;
      expect(keyInfo).toMatchObject({
        id: testApiKeyId,
        name: 'Gateway Validation Test API Key',
        email: 'gateway-test@example.com',
        isActive: true,
        permissions: expect.arrayContaining(['read', 'write'])
      });
      expect(keyInfo).toHaveProperty('lastUsed');
    });

    test('should return not found for non-existent API key', async () => {
      const response = await client.get(`/getApiKeyByKey(key='sk-nonexistent123456789')`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('found');
      expect(response.data.found).toBe(false);
      expect(response.data).not.toHaveProperty('keyInfo');
    });

    test('should return not found for empty key', async () => {
      const response = await client.get(`/getApiKeyByKey(key='')`);

      expect(response.status).toBe(200);
      expect(response.data.found).toBe(false);
    });
  });

  describe('getAwsCredentialByAccessKeyId', () => {
    test('should find existing AWS credential', async () => {
      const response = await client.get(`/getAwsCredentialByAccessKeyId(accessKeyId='${testAwsAccessKeyId}')`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('found');
      expect(response.data.found).toBe(true);
      expect(response.data).toHaveProperty('credentialInfo');
      
      const credentialInfo = response.data.credentialInfo;
      expect(credentialInfo).toMatchObject({
        id: testAwsCredentialId,
        userId: 'admin@test.com',
        name: 'Gateway Validation Test AWS Creds',
        isActive: true,
        region: 'us-east-1',
        permissions: expect.arrayContaining(['bedrock:InvokeModel'])
      });
      expect(credentialInfo).toHaveProperty('expiresAt');
      expect(credentialInfo).toHaveProperty('lastUsed');
    });

    test('should return not found for non-existent AWS credential', async () => {
      const response = await client.get(`/getAwsCredentialByAccessKeyId(accessKeyId='AKIA0000000000000000')`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('found');
      expect(response.data.found).toBe(false);
      expect(response.data).not.toHaveProperty('credentialInfo');
    });

    test('should return not found for empty accessKeyId', async () => {
      const response = await client.get(`/getAwsCredentialByAccessKeyId(accessKeyId='')`);

      expect(response.status).toBe(200);
      expect(response.data.found).toBe(false);
    });
  });
});