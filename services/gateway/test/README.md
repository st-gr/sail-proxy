# Test Suite for Unified Authentication System

This directory contains comprehensive tests for the unified token-based authentication system implemented in the SAP LLM Gateway.

## Test Overview

The unified authentication system supports two primary authentication methods:
- **API Key Authentication**: For Anthropic, OpenRouter, and OpenAI chat routes
- **AWS SigV4 Authentication**: For AWS Bedrock routes with conditional logic

## Available Tests

### End-to-End Tests

#### `test-unified-auth-e2e.js`
**Comprehensive end-to-end test suite for the unified authentication system**

This test validates the complete authentication flow with real services running:

- ✅ **API Key Authentication Tests**
  - Anthropic Messages endpoint (`/anthropic/v1/messages`)
  - OpenRouter Chat Completions (`/openrouter/api/v1/chat/completions`)
  - OpenAI Chat Completions (`/openai/v1/chat/completions`)

- ✅ **AWS SigV4 Authentication Tests**
  - AWS Bedrock Invoke (`/aws-bedrock/model/{modelId}/invoke`)
  - AWS Bedrock Invoke Stream (`/aws-bedrock/model/{modelId}/invoke-with-response-stream`)

- ✅ **Service Availability Tests**
  - Gateway health checks
  - Admin service connectivity
  - Service endpoint discovery

- ✅ **Invalid Authentication Tests**
  - Missing authentication headers
  - Invalid API key formats
  - Empty credentials

**Usage:**
```bash
# Run the complete end-to-end test suite
pnpm run test:e2e

# Or run directly
node test/test-unified-auth-e2e.js
```

### AWS-Specific Tests

#### `simple-aws-test.js`
Comprehensive AWS SigV4 signature validation test with multiple host header variations.

#### `test-aws-sigv4.js`
AWS SDK v3 based SigV4 testing with path encoding validation.

**Usage:**
```bash
# AWS signature tests
node test/simple-aws-test.js
node test/test-aws-sigv4.js
```

### Legacy Tests

#### Individual Service Tests
- `test-anthropic-*.js` - Anthropic-specific testing
- `test-openrouter-*.js` - OpenRouter-specific testing
- Various debugging and health check scripts

### Token Counting Tests (Jest)

Unit tests for the Anthropic token counting endpoint and supporting services.

#### `token-count-service.test.ts`
Tests for the `tokenCountService` which provides local tokenization using `gpt-tokenizer`:
- Encoding pre-loading and readiness checks
- Token counting for various message formats (string, array, images)
- Tool definitions token calculation
- Model-specific tokenizer selection (cl100k_base, o200k_base)

#### `anthropic-translation-service.test.ts`
Tests for the `anthropicTranslationService` which converts Anthropic Messages API format to OpenAI format:
- Message translation (user, assistant, system)
- Model name normalization (stripping version suffixes)
- Content block handling (text, images, tool_use, tool_result, thinking)
- Tool definitions and tool_choice translation

#### `count-tokens-controller.test.ts`
Tests for the `/anthropic/v1/messages/count_tokens` endpoint controller:
- Token counting for simple and complex payloads
- Model-specific multipliers (Claude 1.15x, Grok 1.03x)
- Tool overhead application (+346 for Claude, +480 for Grok)
- MCP tool detection and overhead exemption
- Error handling for invalid requests

**Usage:**
```bash
# Run all token counting related tests
pnpm test -- "token-count-service|anthropic-translation-service|count-tokens-controller"

# Run individual test files
pnpm test -- token-count-service.test.ts
pnpm test -- anthropic-translation-service.test.ts
pnpm test -- count-tokens-controller.test.ts
```

## Test Configuration

### Environment Setup

Before running tests, ensure you have the following environment configured:

1. **Copy the environment template:**
   ```bash
   cp .env.sample .env
   ```

2. **Configure required variables in `.env`:**
   ```bash
   # Core Configuration
   NODE_ENV=test
   PORT=3000
   
   # Authentication
   VALIDATION_TOKEN_SECRET=your-secret-here
   METADATA_ENCRYPTION_KEY=your-32-char-encryption-key-here
   
   # Admin Service
   ADMIN_SERVICE_URL=http://localhost:4004
   
   # Test Credentials
   TEST_API_KEY=sk-test-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd
   TEST_AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
   TEST_AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
   
   # Downstream Services (optional for testing)
   ANTHROPIC_API_KEY=your-anthropic-key
   OPENROUTER_API_KEY=your-openrouter-key
   OPENAI_API_KEY=your-openai-key
   ```

### Service Dependencies

For complete end-to-end testing, ensure these services are running:

1. **Gateway Service** (Port 3000)
   ```bash
   pnpm run dev
   ```

2. **Admin Service** (Port 4004)
   ```bash
   cd ../admin && pnpm run dev
   ```

3. **Optional: Redis** (for distributed caching)
   ```bash
   redis-server
   ```

## Running Tests

### Quick Test Suite
```bash
# Build and run end-to-end tests
pnpm run build
pnpm run test:e2e
```

### Individual Test Categories
```bash
# Test unified authentication components
pnpm run test:unified-auth
pnpm run test:unified-apikey
pnpm run test:unified-cache

# Test AWS integration
pnpm run test
node test/simple-aws-test.js

# Test configuration and admin client
pnpm run test:config
pnpm run test:admin-client
```

### Development Testing
```bash
# Run with detailed logging
LOG_LEVEL=debug pnpm run test:e2e

# Test with specific environment
NODE_ENV=test ENABLE_DEBUG_HEADERS=true pnpm run test:e2e
```

## Test Results Interpretation

### Expected Results

#### ✅ **Success Scenarios**
- **200-299**: Successful authentication and request processing
- **401**: Proper rejection of invalid credentials (expected for test keys)
- **403**: Valid authentication but insufficient permissions

#### ⚠️ **Warning Scenarios**  
- **500**: Server errors (check service configuration)
- **404**: Endpoint not found (check route configuration)
- **503**: Service unavailable (check downstream services)

#### ❌ **Failure Scenarios**
- **Network errors**: Services not running
- **Timeout errors**: Service connectivity issues
- **Unexpected status codes**: Implementation issues

### Debugging Failed Tests

1. **Check Service Status:**
   ```bash
   curl http://localhost:3000/health
   curl http://localhost:4004/health
   ```

2. **Verify Authentication Configuration:**
   ```bash
   # Check unified auth status
   curl http://localhost:3000/ | jq
   ```

3. **Review Logs:**
   ```bash
   tail -f src/logs/app.log
   tail -f src/logs/audit/*.log
   ```

4. **Test Individual Components:**
   ```bash
   pnpm run test:config
   pnpm run test:admin-client
   pnpm run test:unified-cache
   ```

## Legacy OpenRouter Tests

### Quick API Health Check

To verify that all endpoints are accessible:

```bash
node test-openrouter-ping.js
```

### Testing Chat Completions

To test the chat completions endpoint only:

```bash
node test-openrouter-chat.js
```

### Full OpenRouter Test Suite

To run the complete OpenRouter test suite:

```bash
node test-openrouter.js
```

## Troubleshooting

### Common Issues

1. **Port conflicts**: Ensure ports 3000 and 4004 are available
2. **Missing environment variables**: Check `.env` file configuration
3. **Service dependencies**: Verify admin service is running
4. **Network connectivity**: Check firewall and DNS resolution
5. **Credentials**: Ensure test credentials are properly configured

### Debug Mode

Enable detailed logging for troubleshooting:

```bash
DEBUG=* LOG_LEVEL=debug pnpm run test:e2e
```

## Security Considerations

- Test credentials are for development/testing only
- Never commit real API keys or secrets to version control
- Use environment variables for sensitive configuration
- Regularly rotate test credentials
- Monitor test logs for security issues

---

For additional help or questions about the testing suite, refer to the main project documentation or contact the development team.