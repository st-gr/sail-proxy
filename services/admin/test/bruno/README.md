# Bruno API Tests - Happy Path Testing for UI Surrogate

This directory contains Bruno API tests focused on **successful operations** that a real UI would perform. These tests serve as a **UI surrogate** for manual testing and demonstration purposes.

## Test Philosophy

✅ **Happy Path Only** - Tests successful operations that users would actually perform  
❌ **No Failure Testing** - Validation errors, authorization failures, and edge cases are handled by Jest tests  
🎯 **UI Surrogate** - Each test represents a real user workflow through a UI

## Test Structure

### API Keys/ (9 tests)
- **Create API Key**: Creates new API key with proper permissions
- **List API Keys**: Retrieves user's API keys  
- **Get API Key by ID**: Retrieves specific API key details
- **Filter Active API Keys**: Shows only active API keys
- **Disable API Key (Happy Path)**: Deactivates an API key
- **Enable API Key (After Disable)**: Reactivates a disabled API key  
- **Update API Key Value (External Key)**: Updates API key to external value
- **Delete API Key**: Permanently removes an API key
- **Revoke API Key**: Alternative disable action

### Role-Based Access Control/ (12 tests)
**Successful User Operations:**
- **Create User API Key**: Admin creates API key for user
- **Create Other User API Key**: Admin creates API key for different user  
- **User Can Access Own Key by ID**: User views their own API key
- **User Lists Own Keys Only**: User sees only their API keys
- **User Disables Own API Key**: User deactivates their API key
- **User Disables Own API Key**: User manages their own API key

**Successful Admin Operations:**
- **Admin Lists All Keys**: Admin views all API keys across users
- **Admin Can Delete Any Key**: Admin removes user's API key
- **Admin Enables Any User API Key**: Admin reactivates user's API key
- **Admin Updates with 128-char Key**: Admin sets maximum length API key
- **Update API Key Value (Admin Updates Any)**: Admin updates any user's API key

**Utilities:**
- **Cleanup RBAC Test Data**: Removes test data after execution

### AWS Credentials/ (7 tests)
- **Create AWS Credentials**: Creates new AWS credentials with permissions
- **Create AWS Credentials with Permissions**: Comprehensive AWS credential setup
- **List AWS Credentials**: Shows user's AWS credentials
- **Disable AWS Credentials**: Deactivates AWS credentials
- **Enable AWS Credentials**: Reactivates AWS credentials
- **Rotate AWS Credentials**: Generates new AWS credential pair
- **Delete AWS Credentials**: Permanently removes AWS credentials

### Analytics/ (5 tests)
- **Get Usage Statistics with Granularity**: Retrieves usage metrics with time periods
- **Get Security Events**: Shows security event logs
- **Query API Key Usage Statistics View**: Queries usage statistics view
- **Query API Key Usage Stats**: Alternative usage query
- **Query AWS Credential Security Events**: Shows AWS-specific security events

### Configuration/ (5 tests)
- **Create and Validate Configuration**: Creates new service configuration
- **Get Active Configuration**: Retrieves currently active configuration
- **Get Configuration Summary**: Shows configuration overview
- **List API Configurations**: Shows all available configurations  
- **Validate Configuration**: Validates configuration JSON structure

### Gateway Validation/ (2 tests)
- **Get API Key by Key**: Lookup API key details by key value for gateway validation
- **Get AWS Credential by Access Key ID**: Lookup AWS credential details by access key ID for gateway validation

## Environment Variables

```javascript
vars {
  base_url: http://localhost:4004/odata/v4/admin
  test_email: test-{{$randomUUID}}@example.com
  aws_user_id: tenant-{{$randomUUID}}
  config_name: Test-Config-{{$randomUUID}}
  admin_email: admin@test.com
  user_email: user@test.com
  other_user_email: other@test.com
}
```

## Authentication (Development Mode)

Uses **Basic Authentication** with mocked users:

### Admin User
- **Username**: admin@test.com
- **Password**: admin
- **Capabilities**: All operations across all users

### Regular User  
- **Username**: user@test.com
- **Password**: user
- **Capabilities**: Operations on own resources only

### Other User
- **Username**: other@test.com  
- **Password**: other
- **Capabilities**: Operations on own resources only

## Happy Path Workflows

### 1. API Key Management Workflow
```
1. Create API Key → 2. List API Keys → 3. Get API Key by ID → 
4. Disable API Key → 5. Enable API Key → 6. Update API Key Value → 7. Delete API Key
```

### 2. User Self-Service Workflow  
```
1. User Lists Own Keys → 2. User Views Own Key Details → 
3. User Disables Own Key → 4. User Updates Own Key Value
```

### 3. Admin Management Workflow
```
1. Admin Lists All Keys → 2. Admin Creates User Keys → 
3. Admin Enables/Disables Any Key → 4. Admin Deletes User Keys
```

### 4. AWS Credentials Workflow
```
1. Create AWS Credentials → 2. List AWS Credentials → 3. Rotate AWS Credentials → 
4. Disable AWS Credentials → 5. Enable AWS Credentials → 6. Delete AWS Credentials
```

### 5. Analytics & Monitoring Workflow
```
1. Get Usage Statistics → 2. Query Usage Views → 
3. Get Security Events → 4. Review AWS Security Events
```

### 6. Configuration Management Workflow
```
1. Create Configuration → 2. List Configurations → 
3. Get Active Configuration → 4. Validate Configuration
```

## Test Execution

### Prerequisites
1. Start admin service: `npm run dev:ts:mock`
2. Reset database: `npm run db:reset`

### Recommended Execution Order
1. **API Keys/** folder - Core functionality
2. **Role-Based Access Control/** folder - User scenarios  
3. **AWS Credentials/** folder - AWS integration
4. **Configuration/** folder - Service configuration
5. **Analytics/** folder - Monitoring and reporting

### Test Dependencies
- Most tests are independent and can run in any order
- RBAC tests create and clean up their own test data
- Some tests use shared variables (created_api_key_id, etc.)

## Success Indicators

All tests should return **HTTP 200** status codes with successful response bodies:
- API Keys: `{ "id": "...", "key": "...", "success": true }`
- Actions: `{ "success": true, "message": "... successfully" }`
- Lists: `{ "value": [...] }` arrays
- Analytics: Data arrays with usage/security information

## Integration with Jest Tests

- **Bruno Tests**: Happy path scenarios for manual testing and UI development
- **Jest Tests**: Comprehensive failure scenarios, validation, security, and edge cases
- **Together**: Complete test coverage for both development and production confidence