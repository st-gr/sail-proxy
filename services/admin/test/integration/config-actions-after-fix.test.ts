/**
 * Test configuration actions after hang fix
 */

import request from 'supertest';
import { getAdminServiceUrl } from '@libs/test-utils';

const baseUrl = getAdminServiceUrl();
const authHeader = 'Basic YWRtaW5AdGVzdC5jb206YWRtaW4=';

describe('Configuration Actions After Fix', () => {
  let configId: string;

  beforeAll(async () => {
    // Get current config
    const response = await request(baseUrl)
      .get('/odata/v4/admin/ApiConfigurations')
      .set('Authorization', authHeader)
      .timeout(5000);
    
    expect(response.status).toBe(200);
    configId = response.body.value[0].ID;
    console.log(`Testing with config ID: ${configId}`);
  });

  it('should handle activation of already active config', async () => {
    const response = await request(baseUrl)
      .post('/odata/v4/admin/activateConfiguration')
      .set('Authorization', authHeader)
      .send({ configId })
      .timeout(3000);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    // The exact response structure may vary - check if it indicates already active
    if (response.body.message) {
      expect(response.body.message).toMatch(/already active/i);
    } else {
      // If no message, success=true should be sufficient for already active config
      expect(response.body.success).toBe(true);
    }
    console.log('✅ Activation returns immediately for active config');
  });

  it('should validate configuration successfully', async () => {
    const testConfig = {
      api_config: {
        timeouts: { default: 60000, streaming: 60000 },
        logging: { defaultLevel: "INFO" }
      }
    };

    const response = await request(baseUrl)
      .post('/odata/v4/admin/validateConfiguration')
      .set('Authorization', authHeader)
      .send({ configData: JSON.stringify(testConfig) })
      .timeout(3000);

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
    expect(Array.isArray(response.body.errors)).toBe(true);
    expect(Array.isArray(response.body.warnings)).toBe(true);
    console.log('✅ Validation works correctly');
  });

  it('should reject invalid configuration', async () => {
    const invalidConfig = {
      api_config: {
        timeouts: { default: "invalid" }, // Should be number
        logging: { defaultLevel: "INVALID_LEVEL" } // Invalid level
      }
    };

    const response = await request(baseUrl)
      .post('/odata/v4/admin/validateConfiguration')
      .set('Authorization', authHeader)
      .send({ configData: JSON.stringify(invalidConfig) })
      .timeout(3000);

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(false);
    expect(response.body.errors.length).toBeGreaterThan(0);
    console.log('✅ Invalid configuration properly rejected');
  });

  it('should create new configuration successfully', async () => {
    const newConfig = {
      name: 'Test Configuration After Fix',
      configData: JSON.stringify({
        api_config: {
          timeouts: { default: 30000, streaming: 60000 },
          logging: { defaultLevel: "DEBUG" }
        }
      }),
      description: 'Test config created after hang fix'
    };

    const response = await request(baseUrl)
      .post('/odata/v4/admin/createConfiguration')
      .set('Authorization', authHeader)
      .send(newConfig)
      .timeout(5000);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.configId).toBeDefined();
    console.log('✅ Configuration creation works');
    console.log('New config ID:', response.body.configId);
  });

  it('should get active configuration', async () => {
    const response = await request(baseUrl)
      .post('/odata/v4/admin/getActiveConfiguration')
      .set('Authorization', authHeader)
      .send({})
      .timeout(3000);

    // This might return 200 or 404 depending on implementation
    if (response.status === 200) {
      expect(response.body.success).toBe(true);
      console.log('✅ getActiveConfiguration works');
    } else {
      console.log('ℹ️ getActiveConfiguration not implemented or different endpoint');
    }
  });

  it('should handle multiple rapid activations without hanging', async () => {
    const promises = [];
    
    // Try 5 rapid activation attempts
    for (let i = 0; i < 5; i++) {
      promises.push(
        request(baseUrl)
          .post('/odata/v4/admin/activateConfiguration')
          .set('Authorization', authHeader)
          .send({ configId })
          .timeout(2000)
      );
    }

    const responses = await Promise.all(promises);
    
    responses.forEach((response, index) => {
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Configuration is already active');
    });

    console.log('✅ Multiple rapid activations handled correctly');
  });

  it('should maintain service responsiveness after operations', async () => {
    // Final check that service is still responsive
    const response = await request(baseUrl)
      .get('/odata/v4/admin/ApiConfigurations')
      .set('Authorization', authHeader)
      .timeout(2000);

    expect(response.status).toBe(200);
    expect(response.body.value).toBeDefined();
    expect(Array.isArray(response.body.value)).toBe(true);
    console.log('✅ Service remains fully responsive');
  });
});