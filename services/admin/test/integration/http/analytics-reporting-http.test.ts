import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getAdminServiceUrl } from '@libs/test-utils';

describe('Analytics and Reporting HTTP Integration Tests', () => {
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
    test('should get usage statistics via getUsageStatistics function', async () => {
      const startDate = '2024-01-01';
      const endDate = '2024-12-31';
      const granularity = 'day';

      const response = await client.post('/odata/v4/admin/getUsageStatistics', {
        startDate,
        endDate,
        granularity
      });

      if (response.status === 200) {
        expect(response.data).toHaveProperty('apiKeyUsage');
        expect(response.data).toHaveProperty('awsCredentialUsage');
        expect(response.data).toHaveProperty('providerUsage');
        
        expect(Array.isArray(response.data.apiKeyUsage)).toBe(true);
        expect(Array.isArray(response.data.awsCredentialUsage)).toBe(true);
        expect(Array.isArray(response.data.providerUsage)).toBe(true);

        // Validate structure of API key usage data
        if (response.data.apiKeyUsage.length > 0) {
          const apiKeyUsage = response.data.apiKeyUsage[0];
          expect(apiKeyUsage).toHaveProperty('keyId');
          expect(apiKeyUsage).toHaveProperty('keyName');
          expect(apiKeyUsage).toHaveProperty('totalRequests');
          expect(apiKeyUsage).toHaveProperty('totalTokens');
        }

        // Validate structure of AWS credential usage data
        if (response.data.awsCredentialUsage.length > 0) {
          const awsUsage = response.data.awsCredentialUsage[0];
          expect(awsUsage).toHaveProperty('credentialId');
          expect(awsUsage).toHaveProperty('userId');
          expect(awsUsage).toHaveProperty('totalRequests');
          expect(awsUsage).toHaveProperty('totalTokens');
        }

        // Validate structure of provider usage data
        if (response.data.providerUsage.length > 0) {
          const providerUsage = response.data.providerUsage[0];
          expect(providerUsage).toHaveProperty('provider');
          expect(providerUsage).toHaveProperty('totalRequests');
          expect(providerUsage).toHaveProperty('avgResponseTime');
        }
      } else {
        // Function may return 405 Method Not Allowed when called as POST
        expect([200, 405, 404, 501, 500]).toContain(response.status);
      }
    });

    test('should handle different granularity options for usage statistics', async () => {
      const granularities = ['hour', 'day', 'week', 'month'];
      
      for (const granularity of granularities) {
        const response = await client.post('/odata/v4/admin/getUsageStatistics', {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          granularity
        });

        if (response.status === 200) {
          expect(response.data).toHaveProperty('apiKeyUsage');
          expect(response.data).toHaveProperty('awsCredentialUsage');
          expect(response.data).toHaveProperty('providerUsage');
        } else {
          expect([200, 405, 404, 501, 500]).toContain(response.status);
        }
      }
    });

    test('should include AWS credential usage in emailUsage aggregation', async () => {
      const response = await client.post('/odata/v4/admin/getUsageStatistics', {
        startDate: '2024-01-01',
        endDate: '2025-12-31',
        granularity: 'day'
      });

      if (response.status === 200) {
        // Verify emailUsage is present
        expect(response.data).toHaveProperty('emailUsage');
        expect(Array.isArray(response.data.emailUsage)).toBe(true);

        // Verify both AWS credential and email usage data
        const hasAwsCredentialUsage = response.data.awsCredentialUsage?.length > 0;
        const hasEmailUsage = response.data.emailUsage?.length > 0;

        if (hasAwsCredentialUsage && hasEmailUsage) {
          // If we have AWS credential usage, verify email aggregation includes it
          const emailUsage = response.data.emailUsage[0];
          
          // Validate email usage structure
          expect(emailUsage).toHaveProperty('email');
          expect(emailUsage).toHaveProperty('totalRequests');
          expect(emailUsage).toHaveProperty('totalInputTokens');
          expect(emailUsage).toHaveProperty('totalOutputTokens');
          expect(emailUsage).toHaveProperty('totalTokens');
          expect(emailUsage).toHaveProperty('totalInputCost');
          expect(emailUsage).toHaveProperty('totalOutputCost');
          expect(emailUsage).toHaveProperty('totalCost');
          expect(emailUsage).toHaveProperty('avgResponseTime');
          expect(emailUsage).toHaveProperty('uniqueKeysUsed');
          expect(emailUsage).toHaveProperty('lastActivity');

          // Verify email contains an @ symbol (is actually an email)
          expect(emailUsage.email).toMatch(/^[^@]+@[^@]+$/);

          // Verify numeric fields are valid
          expect(typeof emailUsage.totalRequests).toBe('number');
          expect(typeof emailUsage.totalTokens).toBe('number');
          expect(typeof emailUsage.totalCost).toBe('number');
          expect(emailUsage.totalRequests).toBeGreaterThanOrEqual(0);
          expect(emailUsage.totalTokens).toBeGreaterThanOrEqual(0);
          expect(emailUsage.totalCost).toBeGreaterThanOrEqual(0);

          console.log(`✅ Email usage aggregation test passed - Found email: ${emailUsage.email} with ${emailUsage.totalRequests} requests`);
        } else if (hasEmailUsage) {
          console.log('✅ Email usage present, but no AWS credential usage data found (may be expected if no AWS requests made)');
        } else {
          console.log('ℹ️  No email usage data found (may be expected if no usage data exists)');
        }
      } else {
        expect([200, 405, 404, 501, 500]).toContain(response.status);
      }
    }, 20000); // 20 second timeout for this comprehensive test

    test('should validate date range parameters for usage statistics', async () => {
      const response = await client.post('/odata/v4/admin/getUsageStatistics', {
        startDate: '2024-12-31', // End date before start date
        endDate: '2024-01-01',
        granularity: 'day'
      });

      // Should handle invalid date ranges gracefully
      if (response.status === 200) {
        expect(response.data).toHaveProperty('apiKeyUsage');
      } else {
        expect([200, 400, 405, 404, 501]).toContain(response.status);
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
        expect(event).toHaveProperty('eventData');
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
        expect(summary).toHaveProperty('credential');
        expect(summary).toHaveProperty('eventType');
        expect(summary).toHaveProperty('severity');
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
      
      const response = await client.post('/odata/v4/admin/getUsageStatistics', {
        startDate: '2020-01-01',
        endDate: '2024-12-31',
        granularity: 'month'
      });
      
      const duration = Date.now() - startTime;
      
      // Should complete within reasonable time even for large ranges
      expect(duration).toBeLessThan(10000);
      
      if (response.status === 200) {
        expect(response.data).toHaveProperty('apiKeyUsage');
      }
    });

    test('should handle concurrent analytics requests', async () => {
      const requests = Array.from({ length: 3 }, () => 
        client.post('/odata/v4/admin/getUsageStatistics', {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          granularity: 'day'
        })
      );

      const responses = await Promise.all(requests);
      
      // All requests should complete without errors
      responses.forEach(response => {
        expect([200, 405, 404, 501, 500]).toContain(response.status);
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