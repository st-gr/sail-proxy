/**
 * Test the exact configuration activation request to isolate the hang
 */

import request from 'supertest';
import { getAdminServiceUrl } from '@libs/test-utils';

const baseUrl = getAdminServiceUrl();
const authHeader = 'Basic YWRtaW5AdGVzdC5jb206YWRtaW4=';
const cookieHeader = 'cap.sid=s%3ArTusDxXGRlT2RfgHfXH2LS2URXco2lEb.4W%2B9QhW%2FkpP8roWPVLX3IQImtSBfJ%2Fc1sIQlYzU9aEw';

describe('Activation Request Isolation Test', () => {
  let configId: string;

  beforeAll(async () => {
    // Get the config ID to test with
    const response = await request(baseUrl)
      .get('/odata/v4/admin/ApiConfigurations')
      .set('Authorization', authHeader)
      .set('Cookie', cookieHeader)
      .timeout(5000);
    
    expect(response.status).toBe(200);
    configId = response.body.value[0].ID;
    console.log(`Testing with config ID: ${configId}`);
  });

  it('should verify the service is responsive before activation', async () => {
    const response = await request(baseUrl)
      .get('/odata/v4/admin/ApiConfigurations')
      .set('Authorization', authHeader)
      .set('Cookie', cookieHeader)
      .timeout(3000);
    
    expect(response.status).toBe(200);
    console.log('Service is responsive before activation');
  });

  it('should test activation with minimal timeout to see where it hangs', async () => {
    console.log('Starting activation test...');
    const startTime = Date.now();
    
    try {
      const response = await request(baseUrl)
        .post('/odata/v4/admin/activateConfiguration')
        .set('Authorization', authHeader)
        .set('Cookie', cookieHeader)
        .send({ configId })
        .timeout(2000); // Very short timeout to see if it starts processing
      
      const endTime = Date.now();
      console.log(`Activation completed in ${endTime - startTime}ms`);
      console.log('Response status:', response.status);
      console.log('Response body:', response.body);
      
    } catch (error: any) {
      const endTime = Date.now();
      console.log(`Activation failed after ${endTime - startTime}ms`);
      console.log('Error type:', error.constructor.name);
      console.log('Error message:', error.message);
      
      // We expect this to timeout, but let's see how long it takes
      expect(error.message).toMatch(/timeout|ECONNABORTED/i);
    }
  });

  it('should test if service becomes unresponsive after activation attempt', async () => {
    console.log('Testing service responsiveness after activation attempt...');
    
    try {
      const response = await request(baseUrl)
        .get('/odata/v4/admin/ApiConfigurations')
        .set('Authorization', authHeader)
        .set('Cookie', cookieHeader)
        .timeout(2000);
      
      console.log('Service is still responsive after activation');
      expect(response.status).toBe(200);
      
    } catch (error: any) {
      console.log('Service became unresponsive after activation attempt');
      console.log('Error:', error.message);
      expect(error.message).toMatch(/timeout|ECONNABORTED/i);
    }
  });

  it('should test validation action independently', async () => {
    // Test if the validation part works
    const testConfig = {
      api_config: {
        timeouts: { default: 60000, streaming: 60000 },
        logging: { defaultLevel: "INFO" }
      }
    };
    
    try {
      const response = await request(baseUrl)
        .post('/odata/v4/admin/validateConfiguration')
        .set('Authorization', authHeader)
        .set('Cookie', cookieHeader)
        .send({ configData: JSON.stringify(testConfig) })
        .timeout(3000);
      
      console.log('Validation works:', response.status, response.body);
      expect(response.status).toBe(200);
      
    } catch (error: any) {
      console.log('Validation also hangs:', error.message);
      expect(error.message).toMatch(/timeout|ECONNABORTED/i);
    }
  });
});