---
title: SAIL-PROXY User Guide - Chapter 6
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-5-github-copilot.md) | [Content Table](README.md) | [Next Chapter >>](chapter-7-roles.md)

---

## Manage Access & Monitor Usage with Admin Cockpit

The Admin Cockpit is a comprehensive web-based management interface available in Docker deployments. It provides enterprise-grade user management, API key administration, usage analytics, and security monitoring capabilities.

**Note**: The Admin Cockpit is only available in Docker deployments, not in the CLI version. For CLI users, basic management is available through command-line tools.

### Accessing the Admin Cockpit

#### Prerequisites
- **Docker deployment** of SAIL-PROXY with OAuth2 authentication configured
- **Valid user account** through your configured OAuth2 provider (GitHub, Okta, LDAP)
- **Admin or appropriate role** permissions

#### Login Process

1. **Navigate to the Admin Cockpit**:
   - URL: `https://your-domain.com/admin/` or `http://localhost:8080/admin/`

2. **Authenticate through OAuth2**:
   ![OAuth2 Login Screen](/docs/assets/oauth2-login.png)
   - Click "Login with GitHub" (or your configured provider)
   - Complete the OAuth2 authentication flow
   - First user automatically becomes an administrator

3. **Access the Dashboard**:
   ![Admin Dashboard](/docs/assets/admin-dashboard-main.png)
   - Overview of system health and usage
   - Quick access to all management functions

### API Key Management

#### Creating API Keys

1. **Navigate to API Keys section**:
   ![API Key Management](/docs/assets/api-key-management.png)

2. **Create New API Key**:
   - Click "Create API Key"
   - Fill in the details:
     ```
     Name: Development Key - John Doe
     Description: Personal development environment
     Rate Limit: 1000 requests/hour
     IP Restrictions: 192.168.1.0/24 (optional)
     Expiration Date: 2025-04-28 (optional)
     ```

3. **Configure Permissions**:
   - **Models**: Select which models this key can access
   - **Endpoints**: Choose API formats (OpenAI, Anthropic, Bedrock, etc.)
   - **Features**: Enable streaming, tool use, embeddings as needed

4. **Generate and Secure the Key**:
   - Copy the generated key immediately (shown only once)
   - Store securely in your password manager
   - Key format: `sp-proj-1a2b3c4d5e6f7g8h9i0j...` (64 characters)

#### Managing Existing Keys

**View Key Details**:
```
Key ID: sp-proj-1a2b3c4d...
Name: Development Key - John Doe
Created: 2025-01-15 09:30 UTC
Last Used: 2025-01-28 14:22 UTC
Requests Today: 47 / 1000
Status: Active
```

**Key Operations**:
- **Edit**: Modify name, description, rate limits, IP restrictions
- **Rotate**: Generate new key value while preserving configuration
- **Suspend**: Temporarily disable without deletion
- **Revoke**: Permanently disable and delete

**Bulk Operations**:
- Select multiple keys for bulk suspension/revocation
- Export key usage reports
- Set organization-wide defaults

#### API Key Security Features

**Rate Limiting**:
- Per-key request limits (hourly, daily, monthly)
- Token usage limits to control costs
- Automatic throttling with configurable backoff

**Access Controls**:
- IP address allowlists/blocklists
- Time-based access restrictions
- Geographic restrictions (future feature)
- Referrer-based restrictions for web applications

**Monitoring**:
- Real-time usage tracking
- Security event alerts
- Unusual activity detection
- Failed authentication logging

### AWS Credential Management

For organizations using AWS Bedrock integration, the Admin Cockpit provides secure AWS credential management.

#### Adding AWS Credentials

1. **Navigate to AWS Credentials section**:

2. **Create New Credential Set**:
   ```
   Name: Production AWS Account
   Description: Main production environment credentials
   AWS Access Key ID: AKIA...
   AWS Secret Access Key: [encrypted at rest]
   Default Region: us-east-1
   IP Restrictions: 10.0.0.0/8 (optional)
   ```

3. **Configure Permissions**:
   - **Bedrock Models**: Select accessible Bedrock models
   - **Regions**: Specify allowed AWS regions
   - **Features**: Enable Claude, Jurassic, Titan models as needed

#### AWS Security Features

**SigV4 Authentication**:
- Full AWS Signature Version 4 implementation
- Automatic signature generation and validation
- Support for temporary credentials and assume role

**Encryption**:
- AWS secrets encrypted with AES-256
- Hardware security module (HSM) support
- Key rotation capabilities

**Access Controls**:
- IAM policy integration
- Cross-account role assumption
- Service-specific permissions

### Usage Analytics & Monitoring

#### Usage Dashboard

![Usage Analytics Dashboard](/docs/assets/usage-analytics-dashboard.png)

**Real-time Metrics**:
- **Requests per minute**: Live request volume
- **Active Users**: Current concurrent users
- **Response Times**: Average and P95 latencies
- **Error Rates**: Failed requests and error types

**Historical Analytics**:
- **Usage Trends**: Daily/weekly/monthly patterns
- **Cost Analysis**: Token usage and estimated costs
- **Model Distribution**: Popular models and usage patterns
- **User Activity**: Individual user usage statistics

#### Usage Reports

**Generate Custom Reports**:
```
Report Parameters:
- Time Range: Last 30 days
- Users: All users / Specific users
- Models: All models / Specific models
- Metrics: Requests, Tokens, Costs, Response Times
- Format: PDF, Excel, CSV
```

**Automated Reports**:
- Daily usage summaries
- Weekly cost reports
- Monthly trend analysis
- Security incident reports

**Cost Management**:
- **Budget Alerts**: Notifications when usage exceeds thresholds
- **Cost Allocation**: Usage breakdown by user, project, or department
- **Forecasting**: Predicted usage and costs based on trends
- **Optimization Recommendations**: Suggestions for cost reduction

#### Performance Monitoring

**Service Health**:
- **Gateway Status**: Service availability and response times
- **Database Health**: Connection pool status and query performance
- **Cache Performance**: Redis hit rates and memory usage
- **External Dependencies**: SAP AI Core connectivity and latency

**Alerts and Notifications**:
```
Alert Types:
- High error rates (>5% in 5 minutes)
- Unusual usage patterns (10x normal volume)
- Failed authentication attempts (>10 in 1 minute)
- Service downtime
- Budget threshold exceeded
```

### Security Event Management

#### Security Dashboard

![Security Events Dashboard](/docs/assets/security-events-dashboard.png)

**Event Categories**:
- **Authentication Events**: Login successes/failures, token usage
- **Authorization Events**: Permission denials, role changes
- **Usage Anomalies**: Unusual patterns, volume spikes
- **System Events**: Configuration changes, service restarts

**Real-time Monitoring**:
- Live security event stream
- Automatic threat detection
- Geolocation tracking (for suspicious access)
- Device fingerprinting

#### Incident Response

**Automated Responses**:
- Temporary account lockout after failed attempts
- API key suspension for suspicious activity
- Rate limiting escalation
- Administrator notifications

**Manual Interventions**:
- Immediate API key revocation
- User account suspension
- IP address blocking
- Service isolation

**Audit Trail**:
- Complete event history with immutable logging
- Evidence collection for security incidents
- Compliance reporting (SOX, GDPR, etc.)
- Integration with SIEM systems

### Configuration Management

#### Gateway Configuration

**Real-time Config Updates**:
```json
{
  "model_substitutions": {
    "gpt-4o": "gpt-4o-azure",
    "claude-3-5-sonnet": "anthropic--claude-3-5-sonnet"
  },
  "rate_limits": {
    "default": "1000/hour",
    "premium": "5000/hour"
  },
  "caching": {
    "enabled": true,
    "ttl": 300
  }
}
```

**Configuration Validation**:
- JSON schema validation
- Dependency checking
- Rollback capabilities
- A/B testing support

**Environment Management**:
- Development/staging/production configurations
- Feature flag management
- Deployment coordination
- Configuration versioning

#### System Settings

**Authentication Settings**:
- OAuth2 provider configuration
- Session timeout settings
- Multi-factor authentication requirements
- Password policies

**Integration Settings**:
- SAP AI Core connection parameters
- External service endpoints
- Webhook configurations
- Monitoring integrations

### User & Role Management

#### User Administration

**User Listing**:
```
Username: john.doe@company.com
Name: John Doe
Role: API Key Manager
Status: Active
Last Login: 2025-01-28 14:30 UTC
API Keys: 3 active
Usage This Month: 15,234 tokens
```

**User Operations**:
- Edit user profile and contact information
- Change role assignments
- Suspend/activate accounts
- Reset passwords (if local authentication)
- View detailed activity history

#### Bulk User Management

**CSV Import/Export**:
- Bulk user creation from employee directories
- Export user lists for reporting
- Sync with external identity providers
- Automated user lifecycle management

### Administrative Tasks

#### System Maintenance

**Database Management**:
- View connection status and performance
- Execute maintenance queries
- Backup and restore operations
- Data retention policy enforcement

**Cache Management**:
- Clear cache entries
- View cache statistics
- Configure cache policies
- Monitor memory usage

**Log Management**:
- Search and filter system logs
- Download log files
- Configure log levels
- Integrate with external logging systems

#### Health Checks

**System Diagnostics**:
- Service connectivity tests
- Database health checks
- External API availability
- Performance benchmarks

---

*Next: Understand [user roles and permissions](chapter-7-roles.md) in SAIL-PROXY.*