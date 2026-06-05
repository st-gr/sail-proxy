using { sap.llm.gateway.admin as admin } from '../db/schema';

/**
 * Initial test data for development and testing
 */

// Sample API Keys for testing
entity admin.ApiKeys {
  key: 'sk-test-api-key-123456789abcdef';
  name: 'Development Test Key';
  email: 'dev@example.com';
  createdBy: 'system';
  isActive: true;
  usageCount: 0;
}

entity admin.ApiKeys {
  key: 'sk-demo-api-key-987654321fedcba';
  name: 'Demo Key';  
  email: 'demo@example.com';
  createdBy: 'admin';
  isActive: true;
  usageCount: 42;
}

// Sample AWS Credentials for testing
entity admin.AwsCredentials {
  accessKeyId: 'AKIA123EXAMPLE12345';
  secretHash: 'hashed-secret-value';
  salt: 'random-salt-123';
  userId: 'test-user';
  name: 'Development AWS Credentials';
  description: 'AWS credentials for development testing';
  isActive: true;
  region: 'us-east-1';
  sapAiRegion: 'us-east-1.aws.bedrock';
  usageCount: 15;
}

// Sample API Configuration
entity admin.ApiConfiguration {
  name: 'Default Development Configuration';
  version: '1.0.0';
  description: 'Default configuration for development environment';
  environment: 'development';
  isActive: true;
  isDefault: true;
  isValid: true;
  configData: '{
    "api_config": {
      "openai": {
        "substitute_models": [
          {"from": "GPT-4", "to": "o1"},
          {"from": "GPT-3.5", "to": "GPT-4"}
        ],
        "emulate_streaming_for_models": []
      },
      "anthropic": {
        "substitute_models": [
          {"from": "claude-3-5-haiku-20241022", "to": "anthropic--claude-3-haiku"}
        ],
        "emulate_streaming_for_models": ["anthropic--claude-3.7-sonnet"]
      },
      "timeouts": {
        "default": 60000,
        "streaming": 300000
      },
      "logging": {
        "defaultLevel": "INFO",
        "payloadLoggingEnabled": true
      }
    }
  }';
}

// Sample rate limits
entity admin.RateLimits {
  requestsPerMinute: 60;
  requestsPerHour: 1000;
  requestsPerDay: 10000;
  burstLimit: 10;
}

// Sample permissions
entity admin.ApiKeyPermissions {
  permission: 'models:read';
  scope: '*';
  grantedBy: 'system';
}

entity admin.ApiKeyPermissions {
  permission: 'chat:create';
  scope: 'openai,anthropic';
  grantedBy: 'admin';
}