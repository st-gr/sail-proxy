# HTTP Integration Tests for SAP CAP Admin Service

This directory contains comprehensive HTTP integration tests that target the live SAP CAP Admin Service running on `http://localhost:4004`.

## Prerequisites

1. **Start the CAP Service**:
   ```bash
   # In the admin service directory
   pnpm dev
   # OR for TypeScript
   pnpm dev:ts
   ```

2. **Verify Service is Running**:
   ```bash
   curl http://localhost:4004/
   curl http://localhost:4004/odata/v4/admin/\$metadata
   ```

## Running the Tests

### Quick Start
```bash
# Run the integration test script (includes health checks)
pnpm test:integration:http

# Or run tests directly
pnpm test:http
```

### Individual Test Suites
```bash
# Run just the API key tests
npx jest test/integration/http/api-keys-http.test.ts

# Run just the AWS credentials tests
npx jest test/integration/http/aws-credentials-http.test.ts

# Run just the configuration management tests
npx jest test/integration/http/configuration-management-http.test.ts

# Run just the analytics and reporting tests
npx jest test/integration/http/analytics-reporting-http.test.ts

# Run just the custom actions tests  
npx jest test/integration/http/admin-service-actions.test.ts

# Or use the new npm scripts
pnpm test:http:aws        # AWS credentials tests
pnpm test:http:config     # Configuration management tests
pnpm test:http:analytics  # Analytics and reporting tests
```

## Test Coverage

### API Key Management (`api-keys-http.test.ts`)
- ✅ **Create** API keys via POST `/odata/v4/admin/ApiKeys`
- ✅ **Read** API keys via GET `/odata/v4/admin/ApiKeys`
- ✅ **Update** API keys via PATCH `/odata/v4/admin/ApiKeys(id)`
- ✅ **Delete** API keys via DELETE `/odata/v4/admin/ApiKeys(id)`
- ✅ **Custom Actions**: `createApiKey`, `revokeApiKey`, `validateApiKey`

### AWS Credentials Management (`aws-credentials-http.test.ts`)
- ✅ **Create** AWS credentials via `POST /odata/v4/admin/createAwsCredentials`
- ✅ **Revoke** AWS credentials via `POST /odata/v4/admin/revokeAwsCredentials`
- ✅ **Rotate** AWS credentials via `POST /odata/v4/admin/rotateAwsCredentials`
- ✅ **Validate** AWS credentials via `POST /odata/v4/admin/validateAwsCredentials`
- ✅ **Query** AWS credentials with security field exclusions
- ✅ **Filter** active credentials and usage statistics
- ✅ **Performance** testing for credential operations

### Configuration Management (`configuration-management-http.test.ts`)
- ✅ **CRUD** operations on `ApiConfiguration` entities
- ✅ **Update** configuration via `POST /odata/v4/admin/updateConfiguration`
- ✅ **Validate** configuration via `POST /odata/v4/admin/validateConfiguration`
- ✅ **Get** active configuration via `GET /odata/v4/admin/getActiveConfiguration`
- ✅ **Query** configuration providers, models, and templates
- ✅ **Track** configuration changes and audit trail
- ✅ **Handle** large configuration data and complex validation

### Analytics and Reporting (`analytics-reporting-http.test.ts`)
- ✅ **Usage Statistics**: `POST /odata/v4/admin/getUsageStatistics`
- ✅ **Security Events**: `POST /odata/v4/admin/getSecurityEvents`
- ✅ **Usage Views**: API key and AWS credential usage statistics
- ✅ **Security Views**: Security events and summaries
- ✅ **Performance**: Large date ranges and concurrent requests
- ✅ **Real-time**: Active sessions and recent events monitoring

### OData Query Features
- ✅ **Filtering**: `$filter=isActive eq true`
- ✅ **Selection**: `$select=ID,name,email`
- ✅ **Ordering**: `$orderby=name desc`
- ✅ **Pagination**: `$top=10&$skip=20`
- ✅ **Counting**: `$count=true`
- ✅ **Complex Filters**: Date ranges, string operations, numeric comparisons

### Error Handling
- ✅ **400 Bad Request** - Invalid data validation
- ✅ **404 Not Found** - Non-existent resources
- ✅ **405 Method Not Allowed** - Functions called as actions
- ✅ **409 Conflict** - Duplicate constraints
- ✅ **501 Not Implemented** - Graceful handling of unimplemented features

### Security Testing
- ✅ **Field Exclusion**: API keys and AWS credentials sensitive data
- ✅ **Validation**: Configuration data and parameter validation
- ✅ **Rate Limiting**: Concurrent request handling
- ✅ **Authentication**: Service-level security patterns

## Test Data Management

The tests automatically:
- 📝 **Create** unique test data using UUIDs
- 🧹 **Clean up** all created data after tests complete
- 🔄 **Isolate** each test with fresh data
- ⚡ **Run fast** by targeting live HTTP endpoints

## Example Test Structure

```typescript
describe('API Key CRUD Operations', () => {
  test('should create a new API key via POST', async () => {
    const testKey = {
      name: 'Integration Test Key',
      email: `test-${uuidv4()}@example.com`,
      keyHash: 'hashed_test_key_12345',
      maskedKey: 'sk-test...5678',
      isActive: true
    };

    const response = await client.post('/odata/v4/admin/ApiKeys', testKey);
    
    expect(response.status).toBe(201);
    expect(response.data.name).toBe(testKey.name);
    expect(response.data.ID).toBeDefined();
  });
});
```

## Debugging Failed Tests

### Check Service Health
```bash
# Verify service is running
curl -i http://localhost:4004/

# Check OData metadata
curl -i http://localhost:4004/odata/v4/admin/\$metadata

# List existing API keys
curl -i http://localhost:4004/odata/v4/admin/ApiKeys
```

### Enable Verbose Logging
```bash
# Run tests with detailed output
npx jest test/integration/http/ --verbose --detectOpenHandles

# Debug specific test
npx jest test/integration/http/api-keys-http.test.ts --verbose
```

### Common Issues

1. **Service Not Running**:
   ```
   Error: connect ECONNREFUSED 127.0.0.1:4004
   ```
   **Solution**: Start the CAP service with `pnpm dev`

2. **Custom Actions Not Found (404)**:
   ```
   Expected: 200, Received: 404
   ```
   **Solution**: Custom service actions may not be implemented yet - this is expected

3. **Database Constraints**:
   ```
   Expected: 201, Received: 409 Conflict
   ```
   **Solution**: Email uniqueness constraint is working correctly

## Integration vs Unit Tests

| Feature | Unit Tests | Integration Tests |
|---------|------------|-------------------|
| **Speed** | ⚡ Very Fast | 🐌 Slower |
| **Setup** | 📦 Mocked Dependencies | 🌐 Real Service |
| **Coverage** | 🎯 Business Logic | 🔄 End-to-End |
| **Reliability** | 🔒 Isolated | 🌍 Environment Dependent |
| **Value** | 💡 Development | ✅ Production Confidence |

Use integration tests to verify that your SAP CAP service works correctly in a realistic environment with real HTTP requests, OData protocols, and database operations.