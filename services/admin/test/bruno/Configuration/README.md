# Configuration Management API Tests

This folder contains comprehensive Bruno API tests for the SAP LLM Gateway configuration management system.

## Test Structure

### Core Configuration Management Tests
1. **01-list-configurations.bru** - List all configurations via OData
2. **02-get-active-configuration.bru** - Get currently active configuration
3. **03-get-configuration-history.bru** - Get configuration history via OData
4. **04-create-configuration.bru** - Create new configuration version
5. **05-validate-configuration.bru** - Validate configuration data
6. **06-activate-configuration.bru** - Activate a configuration version
7. **07-get-configuration-status.bru** - Get configuration service status
8. **08-get-configuration-history-action.bru** - Get history via action endpoint
9. **09-rollback-configuration.bru** - Rollback to previous configuration

### REST API Compatibility Tests
10. **10-rest-get-config.bru** - GET /api/admin/api-config (Gateway compatibility)
11. **11-rest-update-config.bru** - PUT /api/admin/api-config (Gateway compatibility)
12. **12-rest-rollback-config.bru** - POST /api/admin/api-config/rollback
13. **13-rest-get-status.bru** - GET /api/admin/api-config/status

### Error Handling Tests
14. **14-error-handling-invalid-config.bru** - Test validation error handling
15. **15-error-handling-nonexistent-config.bru** - Test activation of non-existent config

## Features Tested

### ✅ Configuration Versioning
- Automatic semantic versioning (YYYY.M.DDHHMMM)
- Complete configuration history tracking
- Version-based rollback capability

### ✅ Validation System
- JSON structure validation
- Business rule validation (model substitutions, etc.)
- Detailed error and warning reporting

### ✅ Event Publishing
- Configuration change events via Valkey/Redis
- Event publishing status monitoring
- Graceful fallback when Redis unavailable

### ✅ REST API Compatibility
- Gateway service compatibility endpoints
- Proper HTTP headers for change detection (ETag, X-Config-*)
- Backward compatible JSON format

### ✅ Error Handling
- Proper HTTP status codes
- Detailed error messages
- Validation error reporting

## Running the Tests

### Prerequisites
- Admin service running on `http://localhost:4004`
- Basic authentication enabled with `admin@test.com:admin`
- Database initialized with schema

### Environment Variables
The tests use the following variables:
- `base_url`: Admin service base URL (default: `http://localhost:4004/admin`)
- Dynamic variables are set during test execution for chaining tests

### Test Flow
1. **Setup**: List existing configurations and get active config
2. **Create**: Create new configuration with validation
3. **Activate**: Activate the new configuration
4. **Verify**: Check status and history
5. **Rollback**: Test rollback functionality
6. **REST API**: Test Gateway service compatibility endpoints
7. **Error Handling**: Test validation and error scenarios

### Expected Results
- All tests should pass with ✅ status
- Configuration versions should increment automatically
- Events should be published (if Valkey available)
- Rollback should restore previous configuration
- REST API should return Gateway-compatible format

## Configuration Structure

The tests use a standard configuration structure:
```json
{
  "api_config": {
    "timeouts": {
      "default": 120000,
      "streaming": 300000
    },
    "anthropic": {
      "substitute_models": [
        {
          "from": "claude-3-5-haiku-20241022",
          "to": "anthropic--claude-3-haiku--deployed"
        }
      ]
    },
    "openai": {
      "substitute_models": [
        {
          "from": "GPT-4",
          "to": "o1"
        }
      ]
    }
  }
}
```

## Troubleshooting

### Common Issues
1. **404 Not Found**: Check if admin service is running and accessible
2. **Authentication Failed**: Verify basic auth credentials
3. **Validation Errors**: Check configuration JSON structure
4. **Database Errors**: Ensure database is initialized with proper schema

### Debug Tips
- Check admin service logs for detailed error messages
- Verify Valkey/Redis connection for event publishing tests
- Use Bruno's console output to see detailed test results
- Check response headers for configuration metadata