/**
 * Test to verify that configuration activation works correctly without hanging
 * (Previously this test reproduced a hanging bug, now it validates the fix)
 */

import request from 'supertest';
import express from 'express';
import { getAdminServiceUrl, guardActiveConfiguration } from '@libs/test-utils';

const baseUrl = getAdminServiceUrl();
const authHeader = 'Basic YWRtaW5AdGVzdC5jb206YWRtaW4=';
const cookieHeader = 'cap.sid=s%3ArTusDxXGRlT2RfgHfXH2LS2URXco2lEb.4W%2B9QhW%2FkpP8roWPVLX3IQImtSBfJ%2Fc1sIQlYzU9aEw';

describe('Configuration Activation Stability Test', () => {
  // Restores whatever was active before this suite; see active-config-guard.
  guardActiveConfiguration();

  let configId: string;

  beforeAll(async () => {
    // Get the existing configuration ID
    const response = await request(baseUrl)
      .get('/odata/v4/admin/ApiConfigurations')
      .set('Authorization', authHeader)
      .set('Cookie', cookieHeader)
      .timeout(5000);
    
    expect(response.status).toBe(200);
    expect(response.body.value).toBeDefined();
    expect(response.body.value.length).toBeGreaterThan(0);
    
    configId = response.body.value[0].ID;
    console.log(`Using config ID: ${configId}`);
  });

  it('should handle GET requests before activation attempt', async () => {
    const response = await request(baseUrl)
      .get('/odata/v4/admin/ApiConfigurations')
      .set('Authorization', authHeader)
      .set('Cookie', cookieHeader)
      .timeout(5000);
    
    expect(response.status).toBe(200);
    expect(response.body.value).toBeDefined();
  });

  it('should handle configuration activation without hanging', async () => {
    // Establish our own precondition: the shared test DB may have any config
    // active (other test files activate configs too), so activate this one
    // first — it either freshly activates or is already active; both succeed.
    const first = await request(baseUrl)
      .post('/odata/v4/admin/activateConfiguration')
      .set('Authorization', authHeader)
      .set('Cookie', cookieHeader)
      .send({ configId })
      .timeout(5000);

    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);

    // Re-activating the now-active config must report "already active"
    // and, per the original intent of this test, must not hang.
    const second = await request(baseUrl)
      .post('/odata/v4/admin/activateConfiguration')
      .set('Authorization', authHeader)
      .set('Cookie', cookieHeader)
      .send({ configId })
      .timeout(5000);

    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
    expect(second.body.message).toMatch(/already active/i);
  });

  it('should handle GET requests normally after activation', async () => {
    // After activation, GET requests should continue to work normally
    const response = await request(baseUrl)
      .get('/odata/v4/admin/ApiConfigurations')
      .set('Authorization', authHeader)
      .set('Cookie', cookieHeader)
      .timeout(3000);
    
    expect(response.status).toBe(200);
    expect(response.body.value).toBeDefined();
    expect(Array.isArray(response.body.value)).toBe(true);
  });

  it('should handle health checks normally after activation', async () => {
    // Health checks should continue to work normally
    const response = await request(baseUrl)
      .get('/odata/v4/validation/health()')
      .set('Authorization', authHeader)
      .set('Cookie', cookieHeader)
      .timeout(3000);
    
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
    expect(typeof response.body.uptime).toBe('number');
  });
});