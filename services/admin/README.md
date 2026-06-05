# SAP LLM Gateway Admin Service - CAP Implementation

This directory contains the SAP CAP (Cloud Application Programming Model) implementation for the Admin Service, providing structured data models and OData services for managing API keys, AWS credentials, and API configurations.

## Architecture Overview

### Entity Schema Design

Based on analysis of the existing gateway routes and services, the following entity schemas have been created:

#### 1. API Key Management (`api-keys.cds`)
- **ApiKeys**: Core API key entity with authentication tokens
- **RateLimits**: Rate limiting configuration per API key
- **RateLimitWindows**: Custom time-based rate limiting windows
- **ApiKeyPermissions**: Granular permission system
- **ApiKeyUsage**: Request tracking and analytics
- **ApiKeyBlacklist**: Revoked/compromised key management

#### 2. AWS Credentials Management (`aws-credentials.cds`)
- **AwsCredentials**: AWS-style credentials for SigV4 authentication
- **AwsCredentialIPRestrictions**: IP-based access control
- **AwsCredentialPermissions**: AWS service/action permissions
- **AwsCredentialUsage**: Usage tracking for AWS requests
- **AwsCredentialSecurityEvents**: Security monitoring and alerts
- **AwsCredentialRotations**: Credential rotation history

#### 3. API Configuration Management (`api-config.cds`)
- **ApiConfiguration**: Complete API configuration storage
- **ConfigProviders**: Provider-specific settings (OpenAI, Anthropic, AWS Bedrock)
- **ConfigModels**: Model definitions and metadata
- **ConfigModelSubstitutions**: Model substitution rules
- **ConfigTimeouts**: Timeout configurations
- **ConfigLogging**: Logging settings
- **ConfigPlugins**: Plugin system configuration
- **ConfigHooks**: Hook definitions for customization
- **ConfigurationChanges**: Audit trail of configuration changes

### Service Definition (`admin-service.cds`)

The AdminService provides:

#### OData Entities
- Read/write access to all entity types
- Security-filtered projections (secrets excluded)
- Computed views for analytics and reporting

#### Custom Actions
- **API Key Management**: Create, revoke, validate API keys
- **AWS Credentials**: Create, revoke, rotate AWS credentials
- **Configuration Management**: Update, patch, reset, validate configurations
- **Analytics**: Usage statistics, security event reporting

#### Security Features
- Secrets are never exposed in responses
- Hashed storage for sensitive data
- Audit trails for all changes
- IP restriction capabilities
- Permission-based access control

## Key Features Implemented

### 1. **Comprehensive Data Model**
- **Temporal aspects**: Full audit trail with created/modified timestamps
- **Managed aspects**: Automatic user tracking for changes
- **Compositions**: Proper parent-child relationships
- **Views**: Pre-built queries for common operations

### 2. **Security-First Design**
- **No secret exposure**: API keys and AWS secrets are hashed
- **Permission system**: Granular access control
- **Rate limiting**: Multi-tier rate limiting support
- **IP restrictions**: Network-based access control
- **Security events**: Comprehensive monitoring and alerting

### 3. **Analytics & Monitoring**
- **Usage tracking**: Detailed request/response metrics
- **Cost tracking**: Token usage and estimated costs
- **Performance metrics**: Response times and error rates
- **Security monitoring**: Failed authentication attempts, suspicious activity

### 4. **Configuration Management**
- **Version control**: Configuration versioning and history
- **Validation**: JSON schema validation
- **Environment support**: Development, staging, production configurations
- **Change auditing**: Complete change history with rollback support

## Entity Relationships

```
ApiKeys
├── RateLimits (1:1)
│   └── RateLimitWindows (1:n)
├── ApiKeyPermissions (1:n)
├── ApiKeyUsage (1:n)
└── ApiKeyBlacklist (reference)

AwsCredentials
├── AwsCredentialIPRestrictions (1:n)
├── AwsCredentialPermissions (1:n)
├── AwsCredentialUsage (1:n)
├── AwsCredentialSecurityEvents (1:n)
└── AwsCredentialRotations (1:n)

ApiConfiguration
├── ConfigProviders (1:n)
│   └── ConfigModelSubstitutions (1:n)
├── ConfigModels (1:n)
│   └── ConfigModelSubpaths (1:n)
├── ConfigTimeouts (1:1)
│   └── ConfigProviderTimeouts (1:n)
├── ConfigLogging (1:1)
│   └── ConfigLogLevels (1:n)
├── ConfigPlugins (1:n)
│   └── ConfigPluginRules (1:n)
├── ConfigHooks (1:n)
└── ConfigurationChanges (1:n)
```

## Development Setup

### Prerequisites
- Node.js 20+
- SAP CAP CLI (`pnpm add -g @sap/cds-dk`)
- SQLite3 (for local development)

### Installation
```bash
cd services/admin
pnpm install
```

### Development Commands
```bash
# Start CAP development server with hot reload
pnpm dev

# Build CDS models
pnpm cds:build

# Deploy to local SQLite database
pnpm db:migrate

# Serve with mock data
pnpm cds:serve
```

### Database Operations
```bash
# Initialize database with schema
cds deploy --to sqlite

# Load test data
cds run --in-memory

# Reset database
rm db/admin.db && cds deploy --to sqlite
```

## API Usage Examples

### OData Queries
```bash
# Get all active API keys (masked)
GET /api/admin/ApiKeys?$filter=isActive eq true

# Get API key usage statistics
GET /api/admin/ApiKeyUsageStats

# Get AWS credential security events
GET /api/admin/AwsCredentialSecurityEvents?$filter=severity eq 'high'

# Get active configuration
GET /api/admin/ActiveConfigurations
```

### Custom Actions
```bash
# Create new API key
POST /api/admin/createApiKey
{
  "name": "My API Key",
  "email": "user@example.com", 
  "permissions": ["models:read", "chat:create"],
  "rateLimits": {
    "requestsPerMinute": 100,
    "requestsPerHour": 2000
  }
}

# Create AWS credentials
POST /api/admin/createAwsCredentials
{
  "userId": "user123",
  "name": "Production Credentials",
  "description": "AWS credentials for production workload",
  "permissions": [
    {
      "service": "bedrock",
      "action": "bedrock:InvokeModel",
      "resource": "*"
    }
  ]
}

# Validate API key
POST /api/admin/validateApiKey
{
  "key": "sk-1234567890abcdef"
}
```

## Integration with Gateway Service

The CAP Admin Service is designed to replace the in-memory storage currently used in the gateway service:

### Current Gateway Implementation
- In-memory arrays for API keys and AWS credentials  
- File-based JSON configuration
- No persistence or audit trails
- Limited analytics capabilities

### CAP Integration Benefits
- **Persistent storage**: SQLite/HANA database storage
- **OData APIs**: Standardized REST APIs with filtering/sorting
- **Audit trails**: Complete change history
- **Analytics**: Built-in usage statistics and reporting
- **Security**: Proper secret management and access control
- **Scalability**: Enterprise-ready data model

### Migration Path
1. **Phase 1**: Deploy CAP service alongside existing gateway
2. **Phase 2**: Update gateway to use CAP APIs for new operations
3. **Phase 3**: Migrate existing data from in-memory to CAP database
4. **Phase 4**: Remove in-memory implementations from gateway
5. **Phase 5**: Enable advanced features (analytics, security monitoring)

## Production Considerations

### Database
- Replace SQLite with SAP HANA for production
- Enable audit logging
- Configure connection pooling
- Set up database backups

### Security
- Enable JWT authentication
- Configure role-based access control
- Set up TLS/SSL certificates
- Enable API rate limiting

### Monitoring
- Configure health checks
- Set up application metrics
- Enable distributed tracing
- Configure alerting for security events

### Performance
- Index frequently queried fields
- Configure caching for configuration data
- Set up database connection pooling
- Optimize OData query performance

## Troubleshooting

### Database Connection Timeouts

If you see errors like `TimeoutError: ResourceRequest timed out` or `Failed to get active configuration`, this is usually a database configuration issue.

#### Problem: PostgreSQL vs SQLite Configuration

The `.env` file supports both development (SQLite) and production (PostgreSQL) configurations:

**For Local Development** (default):
```bash
# SQLite configuration (development)
cds.requires.db.kind=sqlite
cds.requires.db.credentials.database=db/admin.db
```

**For Docker/Production**:
```bash
# PostgreSQL configuration (production)
cds.requires.db.kind=postgres
cds.requires.db.impl=@cap-js/postgres
cds.requires.db.credentials.host=postgres
cds.requires.db.credentials.port=5432
cds.requires.db.credentials.user=admin_user
cds.requires.db.credentials.password=<your_password>
cds.requires.db.credentials.database=sap_llm_gateway
```

#### Solution

1. **For local development**: Ensure PostgreSQL settings are commented out and SQLite is active
2. **For Docker deployment**: Uncomment PostgreSQL settings and comment out SQLite
3. **Check NODE_ENV**: Set to `development` for local, `production` for Docker

The connection pool timeout occurs when trying to connect to PostgreSQL (`postgres:5432`) in a local environment where PostgreSQL is not running.

## File Structure
```
services/admin/src/
├── db/
│   ├── schema/
│   │   ├── api-keys.cds         # API key entity definitions
│   │   ├── aws-credentials.cds  # AWS credential entities
│   │   ├── api-config.cds       # Configuration entities
│   │   └── index.cds           # Main schema file
│   └── data/
│       └── test-data.cds       # Initial test data
├── srv/
│   ├── admin-service.cds       # Service definition
│   └── admin-service.js        # Service implementation
└── server.js                  # Custom server setup
```

This comprehensive data model provides a solid foundation for enterprise-grade API key management, AWS credential handling, and configuration management while maintaining compatibility with the existing gateway service architecture.