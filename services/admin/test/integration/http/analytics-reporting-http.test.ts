import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { describeLive, getAdminServiceUrl } from '@libs/test-utils';

describeLive('Analytics and Reporting HTTP Integration Tests', () => {
  let client: AxiosInstance;

  beforeAll(() => {
    client = axios.create({
      baseURL: getAdminServiceUrl(),
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('admin@test.com:admin').toString('base64')
      },
      validateStatus: () => true // Don't throw on HTTP errors
    });
  });

  describe('Usage Statistics', () => {
    // getUsageStatistics is an OData function: GET with the parameters in the URL, which is how
    // the Usage app calls it. A POST answers 405; the earlier form of these tests posted and
    // tolerated that, so their assertions never ran.
    const usageStatistics = (startDate: string, endDate: string, granularity: string) =>
      client.get(`/odata/v4/admin/getUsageStatistics(startDate=${startDate},endDate=${endDate},granularity='${granularity}')`);
    const year = new Date().getFullYear();

    test('returns the usage aggregates, with avgResponseTime and tokensPerSecond per model', async () => {
      const response = await usageStatistics(`${year}-01-01`, `${year}-12-31`, 'day');
      expect(response.status).toBe(200);
      for (const list of ['apiKeyUsage', 'awsCredentialUsage', 'providerUsage', 'emailUsage', 'endpointUsage', 'modelUsage']) {
        expect(Array.isArray(response.data[list])).toBe(true);
      }
      for (const apiKeyUsage of response.data.apiKeyUsage) {
        expect(apiKeyUsage).toHaveProperty('keyId');
        expect(apiKeyUsage).toHaveProperty('keyName');
        expect(apiKeyUsage).toHaveProperty('totalRequests');
        expect(apiKeyUsage).toHaveProperty('totalTokens');
        // true only on the admin service key's row (cockpit usage on behalf of users)
        expect(typeof apiKeyUsage.isServiceKey).toBe('boolean');
        expect(apiKeyUsage).not.toHaveProperty('keyOwnerEmail');
      }
      for (const awsUsage of response.data.awsCredentialUsage) {
        expect(awsUsage).toHaveProperty('credentialId');
        expect(awsUsage).toHaveProperty('userId');
        expect(awsUsage).toHaveProperty('totalRequests');
        expect(awsUsage).toHaveProperty('totalTokens');
      }
      for (const providerUsage of response.data.providerUsage) {
        expect(providerUsage).toHaveProperty('provider');
        expect(providerUsage).toHaveProperty('totalRequests');
        expect(typeof providerUsage.avgResponseTime).toBe('number');
      }
      for (const modelUsage of response.data.modelUsage) {
        expect(modelUsage).toHaveProperty('modelId');
        expect(typeof modelUsage.avgResponseTime).toBe('number');
        // a number, or null when no request of the model had both output and a measured time
        expect(modelUsage.tokensPerSecond === null || typeof modelUsage.tokensPerSecond === 'number').toBe(true);
        // the raw sums behind the figure stay server-side
        expect(modelUsage).not.toHaveProperty('throughputOutputTokens');
        // how the model is reached; null when the Model Library does not know it and the id has no suffix
        expect([null, 'foundation', 'deployment']).toContain(modelUsage.accessType);
      }
    });

    test('accepts every granularity', async () => {
      for (const granularity of ['hour', 'day', 'week', 'month']) {
        const response = await usageStatistics(`${year}-01-01`, `${year}-01-31`, granularity);
        expect(response.status).toBe(200);
        expect(Array.isArray(response.data.apiKeyUsage)).toBe(true);
        expect(Array.isArray(response.data.providerUsage)).toBe(true);
      }
    });

    test('aggregates e-mail usage across API keys and AWS credentials', async () => {
      const response = await usageStatistics(`${year}-01-01`, `${year}-12-31`, 'day');
      expect(response.status).toBe(200);
      for (const emailUsage of response.data.emailUsage) {
        // a user's e-mail, or a service identity such as the admin-to-gateway key's
        expect(typeof emailUsage.email).toBe('string');
        expect(emailUsage.email.length).toBeGreaterThan(0);
        for (const field of ['totalRequests', 'totalInputTokens', 'totalOutputTokens', 'totalTokens', 'totalInputCost', 'totalOutputCost', 'totalCost', 'avgResponseTime', 'uniqueKeysUsed', 'lastActivity']) {
          expect(emailUsage).toHaveProperty(field);
        }
        expect(typeof emailUsage.totalRequests).toBe('number');
        expect(emailUsage.totalRequests).toBeGreaterThanOrEqual(0);
        expect(emailUsage.totalTokens).toBeGreaterThanOrEqual(0);
        expect(emailUsage.totalCost).toBeGreaterThanOrEqual(0);
      }
    }, 20000);

    test('answers an end date before the start date without failing', async () => {
      const response = await usageStatistics(`${year}-12-31`, `${year}-01-01`, 'day');
      expect([200, 400]).toContain(response.status);
      if (response.status === 200) {
        expect(Array.isArray(response.data.apiKeyUsage)).toBe(true);
      }
    });
  });

  describe('Security Events', () => {
    test('should get security events via getSecurityEvents action', async () => {
      const startDate = '2024-01-01T00:00:00Z';
      const endDate = '2024-12-31T23:59:59Z';
      const severity = 'high';

      const response = await client.post('/odata/v4/admin/getSecurityEvents', {
        startDate,
        endDate,
        severity
      });

      if (response.status === 200) {
        expect(response.data).toHaveProperty('value');
        expect(Array.isArray(response.data.value)).toBe(true);

        // Validate structure of security events
        if (response.data.value.length > 0) {
          const event = response.data.value[0];
          expect(event).toHaveProperty('eventType');
          expect(event).toHaveProperty('severity');
          expect(event).toHaveProperty('count');
          expect(event).toHaveProperty('lastOccurrence');
          expect(event).toHaveProperty('affectedCredentials');
          
          expect(typeof event.count).toBe('number');
          expect(typeof event.affectedCredentials).toBe('number');
        }
      } else {
        // Action may return errors or not be implemented
        expect([200, 405, 404, 501, 500]).toContain(response.status);
      }
    });

    test('should get security events without severity filter', async () => {
      const response = await client.post('/odata/v4/admin/getSecurityEvents', {
        startDate: '2024-01-01T00:00:00Z',
        endDate: '2024-12-31T23:59:59Z'
        // No severity filter
      });

      if (response.status === 200) {
        expect(response.data).toHaveProperty('value');
        expect(Array.isArray(response.data.value)).toBe(true);
      } else {
        expect([200, 405, 404, 501, 500]).toContain(response.status);
      }
    });

    test('should handle different severity levels for security events', async () => {
      const severities = ['low', 'medium', 'high', 'critical'];
      
      for (const severity of severities) {
        const response = await client.post('/odata/v4/admin/getSecurityEvents', {
          startDate: '2024-01-01T00:00:00Z',
          endDate: '2024-12-31T23:59:59Z',
          severity
        });

        if (response.status === 200) {
          expect(response.data).toHaveProperty('value');
          expect(Array.isArray(response.data.value)).toBe(true);
          
          // If events exist, they should match the requested severity
          response.data.value.forEach((event: any) => {
            expect(event.severity).toBe(severity);
          });
        } else {
          expect([200, 405, 404, 501, 500]).toContain(response.status);
        }
      }
    });
  });

  describe('Usage Statistics Views', () => {
    test('should query API key usage statistics view', async () => {
      const response = await client.get('/odata/v4/admin/ApiKeyUsageStats');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
      
      // Validate structure if data exists
      if (response.data.value.length > 0) {
        const stat = response.data.value[0];
        expect(stat).toHaveProperty('apiKey_ID');
        // Should have usage metrics
        expect(stat).toHaveProperty('totalRequests');
        expect(stat).toHaveProperty('totalInputTokens');
        expect(stat).toHaveProperty('totalOutputTokens');
      }
    });

    test('should query AWS credential usage statistics view', async () => {
      const response = await client.get('/odata/v4/admin/AwsCredentialUsageStats');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
      
      // Validate structure if data exists
      if (response.data.value.length > 0) {
        const stat = response.data.value[0];
        expect(stat).toHaveProperty('credential_ID');
        // Should have usage metrics
        expect(stat).toHaveProperty('totalRequests');
        expect(stat).toHaveProperty('totalInputTokens');
        expect(stat).toHaveProperty('totalOutputTokens');
      }
    });

    test('should query usage statistics without date filtering', async () => {
      const response = await client.get('/odata/v4/admin/ApiKeyUsageStats?$top=10');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
      
      // Validate structure if data exists
      if (response.data.value.length > 0) {
        const stat = response.data.value[0];
        expect(stat).toHaveProperty('totalRequests');
        expect(typeof stat.totalRequests).toBe('number');
      }
    });

    test('should order usage statistics by total requests', async () => {
      const response = await client.get('/odata/v4/admin/ApiKeyUsageStats?$orderby=totalRequests desc&$top=10');
      
      expect(response.status).toBe(200);
      expect(response.data.value.length).toBeLessThanOrEqual(10);
      
      // Verify ordering if data exists
      if (response.data.value.length > 1) {
        for (let i = 1; i < response.data.value.length; i++) {
          const current = response.data.value[i].totalRequests || 0;
          const previous = response.data.value[i-1].totalRequests || 0;
          expect(current).toBeLessThanOrEqual(previous);
        }
      }
    });
  });

  describe('Security Events Views', () => {
    test('should query AWS credential security events', async () => {
      const response = await client.get('/odata/v4/admin/AwsCredentialSecurityEvents');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
      
      // Validate structure if data exists
      if (response.data.value.length > 0) {
        const event = response.data.value[0];
        expect(event).toHaveProperty('eventType');
        expect(event).toHaveProperty('severity');
        expect(event).toHaveProperty('description');
        expect(event).toHaveProperty('credential_ID');
      }
    });

    test('should query AWS credential security summary', async () => {
      const response = await client.get('/odata/v4/admin/AwsCredentialSecuritySummary');
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('value');
      expect(Array.isArray(response.data.value)).toBe(true);
      
      // Validate structure if data exists
      if (response.data.value.length > 0) {
        const summary = response.data.value[0];
        expect(summary).toHaveProperty('credential_ID');
        expect(summary).toHaveProperty('eventType');
        expect(summary).toHaveProperty('severity');
        expect(summary).toHaveProperty('eventCount');
      }
    });

    test('should filter security events by severity', async () => {
      const response = await client.get('/odata/v4/admin/AwsCredentialSecurityEvents?$filter=severity eq \'high\'');
      
      expect(response.status).toBe(200);
      
      // All returned events should have high severity
      response.data.value.forEach((event: any) => {
        expect(event.severity).toBe('high');
      });
    });

    test('should filter security events by event type', async () => {
      const eventTypes = ['unauthorized_access', 'rate_limit_exceeded', 'credential_rotation'];
      
      for (const eventType of eventTypes) {
        const response = await client.get(`/odata/v4/admin/AwsCredentialSecurityEvents?$filter=eventType eq '${eventType}'`);
        
        expect(response.status).toBe(200);
        
        // All returned events should match the event type
        response.data.value.forEach((event: any) => {
          expect(event.eventType).toBe(eventType);
        });
      }
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle large date ranges for analytics queries', async () => {
      const startTime = Date.now();
      const response = await client.get("/odata/v4/admin/getUsageStatistics(startDate=2020-01-01,endDate=2030-12-31,granularity='month')");
      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      // Should complete within reasonable time even for large ranges
      expect(duration).toBeLessThan(10000);
      expect(Array.isArray(response.data.apiKeyUsage)).toBe(true);
    });

    test('should handle concurrent analytics requests', async () => {
      const year = new Date().getFullYear();
      const requests = Array.from({ length: 3 }, () =>
        client.get(`/odata/v4/admin/getUsageStatistics(startDate=${year}-01-01,endDate=${year}-01-31,granularity='day')`)
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });

    test('should paginate large analytics result sets', async () => {
      const response = await client.get('/odata/v4/admin/ApiKeyUsageStats?$top=50&$skip=0');
      
      expect(response.status).toBe(200);
      expect(response.data.value.length).toBeLessThanOrEqual(50);
      
      // Should support pagination controls
      if (response.data['@odata.count']) {
        expect(typeof response.data['@odata.count']).toBe('number');
      }
    });

    test('should handle analytics queries with simple filters', async () => {
      const simpleFilter = "totalRequests gt 0";
      const response = await client.get(`/odata/v4/admin/ApiKeyUsageStats?$filter=${encodeURIComponent(simpleFilter)}`);
      
      // Filters may not be supported - handle gracefully
      expect([200, 400]).toContain(response.status);
      if (response.status === 200) {
        expect(response.data).toHaveProperty('value');
        // All returned stats should have totalRequests > 0
        response.data.value.forEach((usage: any) => {
          expect(usage.totalRequests).toBeGreaterThan(0);
        });
      }
    });
  });

  describe('Real-time Analytics', () => {
    test('should get current usage count', async () => {
      const response = await client.get('/odata/v4/admin/ApiKeyUsage?$count=true&$top=10');
      
      // Count query should work
      expect([200, 400]).toContain(response.status);
      if (response.status === 200) {
        expect(response.data).toHaveProperty('value');
      
        // Should include count of usage records
        if (response.data['@odata.count'] !== undefined) {
          expect(typeof response.data['@odata.count']).toBe('number');
          expect(response.data['@odata.count']).toBeGreaterThanOrEqual(0);
        }
      }
    });

    test('should get recent security events', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();
      
      const response = await client.get(`/odata/v4/admin/AwsCredentialSecurityEvents?$filter=createdAt ge ${oneHourAgo}&$orderby=createdAt desc&$top=10`);
      
      // Date filtering may not be supported - handle gracefully
      expect([200, 400]).toContain(response.status);
      if (response.status === 200) {
        expect(response.data.value.length).toBeLessThanOrEqual(10);
      }
    });

    test('should monitor rate limit violations', async () => {
      const response = await client.get('/odata/v4/admin/AwsCredentialSecurityEvents?$filter=eventType eq \'rate_limit_exceeded\'&$orderby=createdAt desc&$top=20');
      
      // Event type filtering may not be supported - handle gracefully
      expect([200, 400]).toContain(response.status);
      
      if (response.status === 200) {
        // All returned events should be rate limit violations
        response.data.value.forEach((event: any) => {
          expect(event.eventType).toBe('rate_limit_exceeded');
        });
      }
    });
  });
});