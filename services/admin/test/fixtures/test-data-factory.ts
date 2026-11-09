import { v4 as uuidv4 } from 'uuid';

// Mock bcrypt functions for testing
const mockBcrypt = {
  hashSync: (data: string, saltRounds: number | string): string => {
    return `hashed_${data}_${Date.now()}_${Math.random()}`;
  },
  compareSync: (data: string, hash: string): boolean => {
    return hash.includes(data);
  },
  genSaltSync: (rounds: number): string => {
    return `salt_${rounds}_${Date.now()}`;
  }
};

const bcrypt = mockBcrypt;

export interface TestApiKey {
  name: string;
  email: string;
  key?: string;
  keyHash?: string;
  isActive?: boolean;
  permissions?: string[];
  rateLimits?: {
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
  };
}

export interface TestAwsCredential {
  userId: string;
  name: string;
  description?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  secretHash?: string;
  salt?: string;
  region?: string;
  sapAiRegion?: string;
  isActive?: boolean;
  expiresAt?: Date;
  permissions?: Array<{
    service: string;
    action: string;
    resource: string;
    effect: string;
  }>;
}

export interface TestConfiguration {
  name: string;
  version?: string;
  description?: string;
  environment?: 'development' | 'staging' | 'production';
  configData?: object;
  isActive?: boolean;
  isDefault?: boolean;
}

export class TestDataFactory {
  static createApiKey(overrides: Partial<TestApiKey> = {}): TestApiKey {
    // Generate realistic API key with length between 64-120 characters
    const key = this.generateRandomKey(overrides.key ? overrides.key.length : undefined);
    const keyHash = bcrypt.hashSync(key, 10);
    
    return {
      name: 'Test API Key',
      email: 'test@example.com',
      key,
      keyHash,
      isActive: true,
      permissions: ['models:read', 'chat:create'],
      rateLimits: {
        requestsPerMinute: 100,
        requestsPerHour: 2000,
        requestsPerDay: 10000
      },
      ...overrides
    };
  }

  static createAwsCredential(overrides: Partial<TestAwsCredential> = {}): TestAwsCredential {
    const accessKeyId = `AKIA${uuidv4().replace(/-/g, '').substring(0, 16).toUpperCase()}`;
    const secretAccessKey = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const salt = bcrypt.genSaltSync(10);
    const secretHash = bcrypt.hashSync(secretAccessKey, salt);
    
    return {
      userId: 'test-user-123',
      name: 'Test AWS Credential',
      description: 'Test AWS credential for unit testing',
      accessKeyId,
      secretAccessKey,
      secretHash,
      salt,
      region: 'us-east-1',
      sapAiRegion: 'us10',
      isActive: true,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year from now
      permissions: [{
        service: 'bedrock',
        action: 'bedrock:InvokeModel',
        resource: '*',
        effect: 'Allow'
      }],
      ...overrides
    };
  }

  static createConfiguration(overrides: Partial<TestConfiguration> = {}): TestConfiguration {
    return {
      name: 'Test Configuration',
      version: '1.0.0',
      description: 'Test configuration for unit testing',
      environment: 'development',
      configData: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            models: ['gpt-4', 'gpt-3.5-turbo']
          }
        }
      },
      isActive: true,
      isDefault: false,
      ...overrides
    };
  }

  static createUsageRecord(keyId: string, overrides: any = {}) {
    return {
      apiKey: keyId,
      endpoint: '/v1/chat/completions',
      httpMethod: 'POST',
      statusCode: 200,
      requestTime: new Date(),
      responseTime: 1500,
      inputTokens: 150,
      outputTokens: 300,
      totalTokens: 450,
      estimatedCost: 0.0045,
      model: 'gpt-4',
      provider: 'openai',
      clientIP: '192.168.1.100',
      userAgent: 'test-client/1.0',
      ...overrides
    };
  }

  static createSecurityEvent(credentialId: string, overrides: any = {}) {
    return {
      credential: credentialId,
      eventType: 'failed_auth',
      severity: 'medium',
      description: 'Failed authentication attempt',
      clientIP: '192.168.1.100',
      userAgent: 'suspicious-client/1.0',
      endpoint: '/v1/models',
      actionTaken: 'blocked',
      autoBlocked: true,
      investigated: false,
      ...overrides
    };
  }

  static generateRandomEmail(): string {
    return `test-${uuidv4()}@example.com`;
  }

  static generateRandomKey(targetLength?: number): string {
    // Default to a length between 64-120 characters total
    const desiredLength = targetLength || Math.floor(Math.random() * 57) + 64; // 64-120 chars
    const prefixLength = 3; // "sk-"
    const suffixLength = desiredLength - prefixLength;
    
    // Generate hexadecimal string of required length
    const hexChars = '0123456789abcdef';
    let suffix = '';
    for (let i = 0; i < suffixLength; i++) {
      suffix += hexChars[Math.floor(Math.random() * hexChars.length)];
    }
    
    return `sk-${suffix}`;
  }

  static generateKeyOfLength(length: number): string {
    if (length < 4) {
      throw new Error('API key must be at least 4 characters (sk- prefix)');
    }
    if (length > 128) {
      throw new Error('API key cannot exceed 128 characters');
    }
    return this.generateRandomKey(length);
  }

  static generateRandomAccessKeyId(): string {
    return `AKIA${uuidv4().replace(/-/g, '').substring(0, 16).toUpperCase()}`;
  }

  static generateRandomUuid(): string {
    return uuidv4();
  }
}