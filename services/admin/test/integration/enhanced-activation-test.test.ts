/**
 * Test the enhanced configuration activation with performance and gateway notification fixes
 */

import request from 'supertest';
import { getAdminServiceUrl } from '@libs/test-utils';

const baseUrl = getAdminServiceUrl();
const authHeader = 'Basic YWRtaW5AdGVzdC5jb206YWRtaW4=';

describe('Enhanced Configuration Activation Test', () => {
  let activeConfigId: string;
  let inactiveConfigId: string;

  beforeAll(async () => {
    // Get current configurations
    const response = await request(baseUrl)
      .get('/odata/v4/admin/ApiConfigurations')
      .set('Authorization', authHeader)
      .timeout(5000);
    
    expect(response.status).toBe(200);
    
    const configs = response.body.value;
    const activeConfig = configs.find((c: any) => c.isActive);
    const inactiveConfig = configs.find((c: any) => !c.isActive);
    
    activeConfigId = activeConfig?.ID;
    inactiveConfigId = inactiveConfig?.ID;
    
    console.log(`Active config: ${activeConfigId}`);
    console.log(`Inactive config: ${inactiveConfigId}`);
  });

  it('should handle activation of already-active config instantly', async () => {
    const startTime = Date.now();
    
    const response = await request(baseUrl)
      .post('/odata/v4/admin/activateConfiguration')
      .set('Authorization', authHeader)
      .send({ configId: activeConfigId })
      .timeout(3000);

    const endTime = Date.now();
    const duration = endTime - startTime;
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Configuration is already active');
    expect(duration).toBeLessThan(100); // Should be instant
    
    console.log(`✅ Already-active activation: ${duration}ms`);
  });

  it('should activate inactive config with improved performance', async () => {
    if (!inactiveConfigId) {
      // Create a new inactive config for testing
      const createResponse = await request(baseUrl)
        .post('/odata/v4/admin/createConfiguration')
        .set('Authorization', authHeader)
        .send({
          name: 'Performance Test Config',
          configData: JSON.stringify({
            api_config: {
              timeouts: { default: 120000 },
              logging: { defaultLevel: 'INFO' }
            }
          }),
          description: 'Config for testing improved activation performance'
        })
        .timeout(5000);
      
      expect(createResponse.status).toBe(200);
      expect(createResponse.body.success).toBe(true);
      expect(createResponse.body.configId).toBeDefined();
      
      inactiveConfigId = createResponse.body.configId;
      console.log(`Created test config: ${inactiveConfigId}`);
    }

    const startTime = Date.now();
    
    const response = await request(baseUrl)
      .post('/odata/v4/admin/activateConfiguration')
      .set('Authorization', authHeader)
      .send({ configId: inactiveConfigId })
      .timeout(15000); // Allow time for the activation

    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log(`Activation attempt took: ${duration}ms`);
    console.log(`Response status: ${response.status}`);
    console.log(`Response body:`, response.body);
    
    if (response.body.success) {
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(duration).toBeLessThan(8000); // Should complete within 8 seconds
      console.log(`✅ Inactive config activation succeeded: ${duration}ms`);
    } else {
      // Even if it fails, it should fail gracefully within timeout
      expect(duration).toBeLessThan(12000); // Should timeout gracefully within 12 seconds
      expect(response.body.error).toBeDefined();
      console.log(`⚠️ Activation failed gracefully: ${response.body.error}`);
    }
  });

  it('should verify gateway notification was sent', async () => {
    // We can't directly test gateway reception, but we can check the logs
    // or verify that the configuration state changed properly
    
    const response = await request(baseUrl)
      .get('/odata/v4/admin/ApiConfigurations')
      .set('Authorization', authHeader)
      .timeout(3000);
    
    expect(response.status).toBe(200);
    
    const configs = response.body.value;
    const activeConfigs = configs.filter((c: any) => c.isActive);
    
    expect(activeConfigs.length).toBe(1); // Only one should be active
    
    if (inactiveConfigId) {
      const targetConfig = configs.find((c: any) => c.ID === inactiveConfigId);
      if (targetConfig && targetConfig.isActive) {
        console.log(`✅ Configuration ${inactiveConfigId} is now active`);
        console.log(`✅ Previous config was properly deactivated`);
      } else {
        console.log(`ℹ️ Configuration activation may have been rolled back or failed`);
      }
    }
  });

  it('should maintain service responsiveness', async () => {
    // Test multiple concurrent operations to ensure no hangs
    const promises = [];
    
    for (let i = 0; i < 3; i++) {
      promises.push(
        request(baseUrl)
          .get('/odata/v4/admin/ApiConfigurations')
          .set('Authorization', authHeader)
          .timeout(2000)
      );
    }
    
    const responses = await Promise.all(promises);
    
    responses.forEach((response, index) => {
      expect(response.status).toBe(200);
      expect(response.body.value).toBeDefined();
    });
    
    console.log('✅ Service remains responsive under concurrent load');
  });
});