---
title: SAIL-PROXY User Guide - Chapter 7
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-6-admin-cockpit.md) | [Content Table](README.md) | [Next Chapter >>](chapter-8-troubleshooting.md)

---

## Roles Overview

SAIL-PROXY implements a role-based access control (RBAC) system to manage user permissions and access levels. Understanding these roles helps administrators assign appropriate permissions and helps users understand their capabilities within the system.

**Note**: Role-based access control is available only in Docker deployments with the Admin Cockpit. CLI deployments use a single-user model with full access.

### Role Hierarchy

The SAIL-PROXY role system follows a hierarchical model where higher-level roles include all permissions of lower-level roles:

```
Administrator
    ├── API Key Manager
    │   ├── Power User
    │   │   ├── Regular User
    │   │   └── Read-Only User
    └── System Monitor
```

### Role Definitions

#### Administrator

**Full System Access**: Complete control over all SAIL-PROXY functions and configurations.

**Permissions**:
- **User Management**: Create, edit, suspend, and delete user accounts
- **Role Assignment**: Assign and modify user roles
- **System Configuration**: Modify gateway settings, model mappings, and system parameters
- **API Key Management**: Create, edit, revoke, and manage all API keys
- **AWS Credential Management**: Manage all AWS credential sets
- **Security Management**: View all security events, configure security policies
- **Usage Analytics**: Access all usage data and generate reports
- **System Administration**: Database management, cache control, system maintenance

**Typical Users**:
- IT administrators
- Platform owners
- Security officers
- System architects

**Assignment**: 
- First user to log in automatically becomes Administrator
- Additional Administrators can be assigned by existing Administrators

#### API Key Manager (user with admin role)

**API Key and Access Management**: Responsible for managing API keys and user access to AI models.

**Permissions**:
- **API Key Management**: Create, edit, and revoke API keys for their scope
- **Usage Monitoring**: View usage analytics for managed keys
- **User Support**: Assist users with access issues and key management
- **Model Access Control**: Configure which models users can access
- **Basic Security Events**: View security events related to managed keys

**Restrictions**:
- Cannot modify system configuration
- Cannot manage user roles (except assigning Regular User role)
- Cannot access global system administration functions
- Cannot manage AWS credentials (unless also Administrator)

**Typical Users**:
- Team leads
- Project managers
- Developer advocates
- IT support staff

#### Regular User

**Standard AI Access**: Standard access level for most users of the system.

**Permissions**:
- **Personal API Key Management**: Create and manage personal API keys (limited number)
- **AI Model Access**: Use assigned AI models through standard API endpoints
- **Personal Usage Tracking**: View own usage statistics and history
- **Basic Features**: Access to standard API features within rate limits

**Restrictions**:
- Limited number of API keys (typically 3-5)
- Cannot view other users' data
- Cannot manage AWS credentials
- Cannot access administrative functions
- Restricted model access based on assignments

**Typical Users**:
- Software developers
- Data scientists
- Business analysts
- Students/interns

#### Read-Only User

**View-Only Access**: Limited access for monitoring and reporting purposes.

**Permissions**:
- **Usage Visibility**: View usage statistics and reports (limited scope)
- **Documentation Access**: Access to API documentation and examples

**Restrictions**:
- Cannot create API keys
- Cannot make API requests to AI models
- Cannot modify any configurations
- Cannot access security events or administrative data

**Typical Users**:
- Managers and executives
- Auditors and compliance officers
- External consultants (limited access)
- Monitoring service accounts

#### System Monitor

**System Health and Monitoring**: Specialized role for monitoring system health and performance.

**Permissions**:
- **System Health Monitoring**: View system performance metrics and health status
- **Usage Analytics**: Access to aggregated usage statistics
- **Security Event Monitoring**: View security events and alerts
- **Performance Analysis**: Access to response time and error rate data
- **Alert Configuration**: Set up monitoring alerts and notifications

**Restrictions**:
- Cannot manage users or API keys
- Cannot modify system configuration
- Cannot access individual user data
- Read-only access to most functions

**Typical Users**:
- Operations teams
- Site reliability engineers
- Security operations center (SOC) analysts
- External monitoring services

### Permission Matrix

| Function | Admin | API Key Mgr | Power User | Regular User | Read-Only | Monitor |
|----------|-------|-------------|------------|--------------|-----------|---------|
| **User Management** |
| Create/Edit Users | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Assign Roles | ✅ | Limited¹ | ❌ | ❌ | ❌ | ❌ |
| View User List | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **API Key Management** |
| Create Own Keys | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Manage Others' Keys | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Set Rate Limits | ✅ | ✅ | Limited² | ❌ | ❌ | ❌ |
| **System Configuration** |
| Gateway Config | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Model Mappings | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Security Policies | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Usage & Analytics** |
| Own Usage | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Team Usage | ✅ | ✅ | ✅ | ❌ | Limited³ | ✅ |
| Global Analytics | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **AI Model Access** |
| All Models | ✅ | Config⁴ | Config⁴ | Config⁴ | ❌ | ❌ |
| Streaming | ✅ | Config⁴ | Config⁴ | Config⁴ | ❌ | ❌ |
| Tool Use | ✅ | Config⁴ | Config⁴ | Config⁴ | ❌ | ❌ |

**Footnotes**:
1. Can assign Regular User role only
2. Within predefined limits set by Admin
3. Read-only access to aggregated data
4. Based on individual configuration by Admin/API Key Manager

### Role Assignment Workflow

#### Initial Setup

1. **First User Registration**:
   ```
   User: admin@company.com logs in via OAuth2
   → Automatically assigned Administrator role
   → Can now manage the system and assign roles
   ```

2. **Adding Team Members**:
   ```
   Administrator adds users:
   - john.doe@company.com → API Key Manager (team lead)
   - jane.smith@company.com → Power User (senior developer)
   - bob.wilson@company.com → Regular User (developer)
   - mary.jones@company.com → Read-Only User (manager)
   ```

#### Role Change Process

**By Administrator**:
1. Navigate to User Management in Admin Cockpit
2. Select user to modify
3. Choose new role from dropdown
4. Confirm role change
5. User's permissions update immediately

**Role Change Notifications**:
- Email notification to affected user
- Audit log entry created
- Existing API keys maintain current permissions until next use

### Best Practices for Role Assignment

#### Security Principles

**Principle of Least Privilege**:
- Start with the lowest role that meets user needs
- Escalate permissions only when necessary
- Regular review of role assignments

**Separation of Duties**:
- Don't assign Administrator role to regular users
- Limit number of Administrators (recommend 2-3 maximum)
- Use API Key Manager for delegated administration

#### Organizational Alignment

**Development Teams**:
```
Team Structure → Recommended Roles
├── Engineering Manager → API Key Manager
├── Senior Developers → Power User
├── Junior Developers → Regular User
├── Product Manager → Read-Only User
└── DevOps Engineer → System Monitor + Power User
```

**Enterprise Deployment**:
```
Organization → Role Distribution
├── IT Department → Administrator (1-2 people)
├── Team Leads → API Key Manager (3-5 people)
├── Developers → Power User / Regular User (50-200 people)
├── Management → Read-Only User (10-20 people)
└── Operations → System Monitor (2-3 people)
```

### Role-Based Feature Access

#### CLI vs Docker Deployment Differences

**CLI Deployment**:
- Single-user model (equivalent to Administrator role)
- All features available through command line
- No web-based role management
- Suitable for individual developers

**Docker Deployment**:
- Multi-user with role-based access control
- Web-based Admin Cockpit
- Enterprise authentication integration
- Suitable for teams and organizations

#### Feature Availability by Role

**API Access Features**:
- All roles (except Read-Only) can make AI API requests
- Rate limits and model access controlled by role
- Streaming and tool use based on configuration

**Administrative Features**:
- User management: Administrator only
- API key management: Administrator and API Key Manager
- System configuration: Administrator only
- Monitoring: Administrator, API Key Manager, System Monitor

### Troubleshooting Role Issues

#### Common Role-Related Problems

**Access Denied Errors**:
```bash
# Check current user role
curl -H "Authorization: Bearer api-key" \
     http://localhost:3000/admin/api/user/profile

# Response includes current role and permissions
```

**Permission Escalation Requests**:
1. Contact Administrator or API Key Manager
2. Provide business justification for increased permissions
3. Follow organization's access request process
4. Consider temporary role assignment for specific projects

**Role Assignment Conflicts**:
- Multiple administrators should coordinate role changes
- Use audit logs to track role change history
- Implement approval workflow for sensitive role assignments

---

*Next: Learn how to [troubleshoot common issues](chapter-8-troubleshooting.md) with SAIL-PROXY.*