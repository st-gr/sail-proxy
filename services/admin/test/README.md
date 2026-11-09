# SAP CAP Admin Service - Test Suite

This comprehensive test suite validates the complete functionality, security, and performance of the SAP CAP Admin Service for the LLM Gateway project.

## Test Architecture

### Test Categories

#### 1. **Unit Tests** (`test/unit/`)
- **Entity Tests** (`entities/`): Test individual entity CRUD operations, validation, and constraints
- **Service Tests** (`services/`): Test business logic, service functions, and data transformations

#### 2. **Integration Tests** (`test/integration/`)
- **API Tests** (`api/`): Test OData endpoints, custom actions, and HTTP interfaces
- **Workflow Tests** (`workflows/`): Test complete end-to-end business processes

#### 3. **Security Tests** (`test/security/`)
- Authentication and authorization validation
- Data security and secret masking
- Input sanitization and injection prevention
- Rate limiting and IP restrictions

### Test Infrastructure

#### Test Utilities (`test/test-utils.ts`)
- Environment setup and teardown
- Database initialization and cleanup
- Common test helpers

#### Test Data Factory (`test/fixtures/test-data-factory.ts`)
- Generates realistic test data for all entities
- Provides factory methods for consistent test scenarios
- Handles complex relationships and dependencies

#### Configuration
- **Jest Configuration** (`test/jest.config.js`): TypeScript support, coverage, timeouts
- **Global Setup/Teardown**: Database initialization and cleanup
- **Environment Isolation**: In-memory SQLite for fast, isolated tests

## Test Coverage

### API Key Management
- ✅ Key generation and validation
- ✅ Rate limiting enforcement
- ✅ Permission system validation
- ✅ Usage tracking and analytics
- ✅ Key revocation and blacklisting
- ✅ Secret hashing and masking

### AWS Credentials Management
- ✅ Access key generation and validation
- ✅ SigV4 signature validation
- ✅ IP restriction enforcement
- ✅ Permission mapping and validation
- ✅ Credential rotation workflows
- ✅ Security event detection and logging

### Configuration Management
- ✅ Schema validation and versioning
- ✅ Environment-specific configurations
- ✅ Change auditing and rollback
- ✅ Template management
- ✅ JSON patch operations
- ✅ Provider and model management

### Security Features
- ✅ Authentication and authorization
- ✅ Data encryption and hashing
- ✅ Input sanitization
- ✅ Rate limiting and IP restrictions
- ✅ Security event monitoring
- ✅ Audit trail validation

## Running Tests

### Prerequisites
```bash
# Install dependencies
pnpm install

# Initialize test database
pnpm db:migrate
```

### Test Commands

#### Run All Tests
```bash
pnpm test
```

#### Run Specific Test Categories
```bash
# Unit tests only
pnpm test:unit

# Integration tests only
pnpm test:integration

# Security tests only
pnpm test:security

# All tests with coverage
pnpm test:coverage
```

#### Run Individual Test Suites
```bash
# Entity tests
pnpm test entities

# Service logic tests
pnpm test services

# API endpoint tests
pnpm test api

# End-to-end workflow tests
pnpm test workflows

# Security tests
pnpm test security
```

#### Development Mode
```bash
# Watch mode for continuous testing
pnpm test:watch

# Run specific test file
npx jest test/unit/entities/api-keys.test.ts
```

### Test Output

The test runner provides detailed output including:
- Test suite execution status
- Individual test results
- Performance metrics
- Coverage reports
- Failed test details

Example output:
```
🚀 Starting SAP CAP Admin Service Test Suite

📋 Running Unit Tests - Entities...
✅ Unit Tests - Entities completed in 15423ms

📋 Running Unit Tests - Services...
✅ Unit Tests - Services completed in 22156ms

📋 Running Integration Tests - API...
✅ Integration Tests - API completed in 45782ms

📋 Running Integration Tests - Workflows...
✅ Integration Tests - Workflows completed in 67234ms

📋 Running Security Tests...
✅ Security Tests completed in 31567ms

📊 Generating coverage report...
✅ Coverage report generated

📈 Test Summary:
  Total Suites: 5
  Passed: 5
  Failed: 0
  Total Time: 182162ms

✅ All test suites passed!
```

## Test Data Management

### Test Data Factory
The `TestDataFactory` class provides consistent test data generation:

```typescript
// Generate API key test data
const testKey = TestDataFactory.createApiKey({
  name: 'Custom Test Key',
  email: 'custom@test.com',
  permissions: ['models:read', 'chat:create']
});

// Generate AWS credentials test data
const testCred = TestDataFactory.createAwsCredential({
  userId: 'test-user',
  permissions: [{
    service: 'bedrock',
    action: 'bedrock:InvokeModel',
    resource: '*',
    effect: 'Allow'
  }]
});

// Generate configuration test data
const testConfig = TestDataFactory.createConfiguration({
  environment: 'production',
  isDefault: true
});
```

### Data Cleanup
Each test has proper cleanup to ensure isolation:
- Database tables are cleared before each test
- In-memory SQLite provides fast, isolated test environments
- No test pollution between different test suites

## Performance Testing

### Load Testing Considerations
The test suite includes performance validation for:
- High-volume API key operations
- Concurrent request handling
- Database query optimization
- Memory usage monitoring

### Benchmark Tests
```typescript
// Example performance test
test('should handle 1000 API keys efficiently', async () => {
  const startTime = Date.now();
  
  // Create 1000 API keys
  const keys = [];
  for (let i = 0; i < 1000; i++) {
    keys.push(TestDataFactory.createApiKey({
      email: \`user\${i}@test.com\`
    }));
  }
  
  await db.run(INSERT.into('sap.llm.gateway.admin.ApiKeys').entries(keys));
  
  const endTime = Date.now();
  expect(endTime - startTime).toBeLessThan(5000); // Should complete in under 5s
});
```

## Security Testing

### Authentication Tests
- Mock authentication for unit tests
- JWT token validation (when enabled)
- Permission-based access control

### Authorization Tests
- Role-based permissions
- Resource-level access control
- API endpoint protection

### Data Security Tests
- Secret masking validation
- Hash verification
- Input sanitization
- SQL injection prevention

### Rate Limiting Tests
- Request throttling validation
- Burst limit enforcement
- Time-window calculations

## Continuous Integration

### GitHub Actions Integration
The test suite is designed for CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run Tests
  run: |
    pnpm install
    pnpm test:all
    
- name: Upload Coverage
  uses: codecov/codecov-action@v3
  with:
    file: ./coverage/lcov.info
```

### Quality Gates
- Minimum 80% test coverage
- All security tests must pass
- Performance benchmarks must be met
- No flaky tests allowed

## Troubleshooting

### Common Issues

#### Database Connection Issues
```bash
# Reset test database
rm -f db/admin.db
pnpm db:migrate
```

#### Memory Issues with Large Test Suites
```bash
# Run tests with increased memory
NODE_OPTIONS="--max-old-space-size=4096" pnpm test
```

#### Timeout Issues
```bash
# Increase test timeout
npx jest --testTimeout=60000
```

### Debug Mode
```bash
# Run tests with debug output
DEBUG=* pnpm test

# Run specific test with debugging
npx jest --runInBand --verbose test/unit/entities/api-keys.test.ts
```

## Contributing

### Adding New Tests

1. **Entity Tests**: Add to `test/unit/entities/`
2. **Service Tests**: Add to `test/unit/services/`
3. **API Tests**: Add to `test/integration/api/`
4. **Security Tests**: Add to `test/security/`

### Test Standards

- Use descriptive test names
- Follow AAA pattern (Arrange, Act, Assert)
- Clean up test data properly
- Use factory methods for test data
- Test both success and error scenarios
- Include performance considerations
- Document complex test logic

### Example Test Structure
```typescript
describe('Feature Name', () => {
  beforeEach(async () => {
    await clearTestData();
  });

  describe('Success Scenarios', () => {
    test('should handle valid input correctly', async () => {
      // Arrange
      const testData = TestDataFactory.createTestData();
      
      // Act
      const result = await performOperation(testData);
      
      // Assert
      expect(result).toBeDefined();
      expect(result.status).toBe('success');
    });
  });

  describe('Error Scenarios', () => {
    test('should reject invalid input', async () => {
      // Arrange
      const invalidData = { invalid: 'data' };
      
      // Act & Assert
      await expect(performOperation(invalidData)).rejects.toThrow();
    });
  });
});
```

This test suite ensures the SAP CAP Admin Service meets enterprise-grade quality, security, and performance standards while providing comprehensive validation of all features and functionality.