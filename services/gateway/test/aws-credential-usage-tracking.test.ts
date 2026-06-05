import crypto from 'crypto';
import { describe, beforeAll, afterAll, it, expect, beforeEach, jest } from '@jest/globals';

// Import the usage tracking utilities
import { extractAuthInfo, createUsageMetrics, emitUsageEvent } from '../src/utils/usageTracker';
import usageEmitter from '../src/services/usageEventEmitter';

// Mock logger
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn()
  })
}));

// Mock unified auth config - default to non-standalone
jest.mock('../src/config/unifiedAuthConfig', () => ({
  isStandaloneMode: jest.fn(() => false)
}));

describe('AWS Credential Usage Tracking Integration Test', () => {
  let capturedEvents: any[] = [];

  // Test AWS credentials - matching the ones from admin service tests
  const testAwsCredentials = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1'
  };

  beforeAll(async () => {
    // Mock the usage emitter to capture events
    const originalEmit = usageEmitter.emit;
    usageEmitter.emit = jest.fn().mockImplementation(async (event: any) => {
      capturedEvents.push(event);
      return await originalEmit.call(usageEmitter, event);
    }) as any;
  });

  beforeEach(() => {
    capturedEvents = [];
  });

  // AWS SigV4 signing utility functions
  function getSigningKey(secret: string, date: string, region: string, service: string): Buffer {
    const kDate = crypto.createHmac('sha256', 'AWS4' + secret).update(date).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    return kSigning;
  }

  function calculateSignature(signingKey: Buffer, stringToSign: string): string {
    return crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  }

  function createAwsSignedRequest(
    method: string,
    path: string,
    body: string,
    credentials: typeof testAwsCredentials,
    host: string = 'localhost'
  ) {
    const timestamp = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const date = timestamp.substring(0, 8);
    
    // Calculate body hash
    const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
    
    // Required headers
    const headers = {
      'host': host,
      'x-amz-date': timestamp,
      'x-amz-content-sha256': payloadHash,
      'content-type': 'application/json'
    };

    // Create canonical request
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map(key => `${key}:${headers[key as keyof typeof headers]}`)
      .join('\n') + '\n';

    const canonicalRequest = [
      method.toUpperCase(),
      path,
      '', // query string (empty)
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    // Create string to sign
    const credentialScope = `${date}/${credentials.region}/bedrock/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      timestamp,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex')
    ].join('\n');

    // Calculate signature
    const signingKey = getSigningKey(credentials.secretAccessKey, date, credentials.region, 'bedrock');
    const signature = calculateSignature(signingKey, stringToSign);

    // Create authorization header
    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      headers: {
        ...headers,
        'authorization': authorizationHeader
      },
      canonicalRequest,
      stringToSign,
      signature
    };
  }

  it('should extract AWS credential ID from unified auth data structure with credentialId field', () => {
    // This tests the actual fix - ensuring extractAuthInfo properly handles the credentialId field
    // as set by the AWS middleware in tokenBasedAwsAuth.ts line 202
    const mockRequest = {
      unifiedAuth: {
        valid: true,
        authType: 'aws_credential' as const,
        data: {
          accessKeyId: testAwsCredentials.accessKeyId,
          userId: 'test-user',
          permissions: [],
          region: testAwsCredentials.region,
          credentialId: 'aws-cred-12345' // This is what the AWS middleware actually sets
        }
      }
    } as any;

    const authInfo = extractAuthInfo(mockRequest);

    console.log('🔍 Extracted Auth Info:', authInfo);
    
    expect(authInfo).not.toBeNull();
    expect(authInfo!.authType).toBe('aws_credential');
    expect(authInfo!.credentialId).toBe('aws-cred-12345'); // Should extract from credentialId field
  });

  it('should extract AWS credential ID from unified auth data structure with keyId field (legacy support)', () => {
    // This tests backward compatibility with existing tests that use keyId
    const mockRequest = {
      unifiedAuth: {
        valid: true,
        authType: 'aws_credential' as const,
        data: {
          keyId: 'test-aws-key-legacy'
        }
      }
    } as any;

    const authInfo = extractAuthInfo(mockRequest);

    console.log('🔍 Extracted Auth Info (Legacy):', authInfo);
    
    expect(authInfo).not.toBeNull();
    expect(authInfo!.authType).toBe('aws_credential');
    expect(authInfo!.credentialId).toBe('test-aws-key-legacy'); // Should extract from keyId field
  });

  it('should emit usage event with correct AWS credential auth type', async () => {
    const mockRequest = {
      unifiedAuth: {
        valid: true,
        authType: 'aws_credential' as const,
        data: {
          credentialId: 'aws-credential-test-id'
        }
      },
      originalUrl: '/aws-bedrock/model/us.anthropic.claude-3-5-haiku-20241022-v1:0/converse',
      debugRequestId: 'test-request-123'
    } as any;

    const metrics = createUsageMetrics();
    metrics.inputTokens = 100;
    metrics.outputTokens = 50;

    await emitUsageEvent(mockRequest, metrics, 'us.anthropic.claude-3-5-haiku-20241022-v1:0', 200);

    expect(capturedEvents).toHaveLength(1);
    const usageEvent = capturedEvents[0];

    console.log('✅ Emitted Usage Event:', usageEvent);

    expect(usageEvent.authType).toBe('aws_credential');
    expect(usageEvent.credentialId).toBe('aws-credential-test-id');
    expect(usageEvent.model).toBe('us.anthropic.claude-3-5-haiku-20241022-v1:0');
    expect(usageEvent.inputTokens).toBe(100);
    expect(usageEvent.outputTokens).toBe(50);
    expect(usageEvent.statusCode).toBe(200);
    expect(usageEvent.endpoint).toBe('/aws-bedrock/model/us.anthropic.claude-3-5-haiku-20241022-v1:0/converse');
  });

  it('should create valid AWS SigV4 signature components (bonus: shows proper signing)', () => {
    const testBody = '{"test": "data"}';
    const path = '/test-path';
    const signedRequest = createAwsSignedRequest('POST', path, testBody, testAwsCredentials);

    // Verify signature components
    expect(signedRequest.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(signedRequest.headers.authorization).toContain(testAwsCredentials.accessKeyId);
    expect(signedRequest.headers.authorization).toContain('/us-east-1/bedrock/aws4_request');
    expect(signedRequest.headers.authorization).toContain('SignedHeaders=');
    expect(signedRequest.headers.authorization).toContain('Signature=');
    
    expect(signedRequest.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(signedRequest.headers['x-amz-content-sha256']).toHaveLength(64);
    expect(signedRequest.signature).toHaveLength(64);
    
    console.log('🔐 AWS SigV4 Signature Example:');
    console.log('Authorization:', signedRequest.headers.authorization);
    console.log('X-Amz-Date:', signedRequest.headers['x-amz-date']);
    console.log('X-Amz-Content-SHA256:', signedRequest.headers['x-amz-content-sha256']);
  });
});