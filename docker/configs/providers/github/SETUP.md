# GitHub Integration Setup Guide

## Prerequisites

### 1. GitHub OAuth App Setup

#### For GitHub.com:
1. **Navigate to Organization Settings:**
   ```
   GitHub.com → Your Org → Settings → Developer settings → OAuth Apps → New OAuth App
   ```

2. **OAuth App Configuration:**
   ```
   Application name: SAP LLM Gateway
   Homepage URL: https://gateway.company.com
   Authorization callback URL: https://auth.company.com/dex/callback
   # For local development: http://localhost:8080/dex/callback
   ```

3. **Save Client ID and Secret:**
   ```bash
   # Note down these values for setup-docker.js
   Client ID: abc123def456ghi789
   Client Secret: your-oauth-app-secret-here
   ```

#### For GitHub Enterprise Server:
1. **Navigate to Enterprise Settings:**
   ```
   GitHub Enterprise → Site admin → Management Console → Applications → OAuth Apps
   ```

2. **Same configuration as above** but with your enterprise domain

### 2. GitHub Organization and Team Setup

1. **Create Required Teams:**
   ```bash
   # In your GitHub organization, create teams:
   sap-llm-gateway/admins
   sap-llm-gateway/users
   # Note: setup-docker.js will ask for admin and user team names
   ```

2. **Add Team Members:**
   ```
   Organization → Teams → [Team Name] → Members → Add members
   ```

3. **Set Team Privacy:**
   ```
   Recommended: "Closed" teams for better security
   ```

## Deployment Steps

### 1. Run Interactive Setup

```bash
# Navigate to docker directory
cd docker

# Run the interactive setup script
node setup-docker.js

# Select option 2: GitHub OAuth
# Enter the values when prompted:
# - GitHub OAuth App Client ID: abc123def456ghi789
# - GitHub OAuth App Client Secret: your-oauth-app-secret-here
# - GitHub Organization name: your-org-name
# - Admin team name: admins (default)
# - User team name: users (default)
```

### 2. Deploy Services

```bash
# Rebuild nginx container (required for configuration changes)
docker-compose build nginx

# Start all services
docker-compose up -d

# Check Dex logs for GitHub connector initialization
docker-compose logs dex | grep -i github

# Verify oauth2-proxy can reach Dex
docker-compose logs oauth2-proxy | grep -i oidc
```

### 3. Grant OAuth App Organization Access

**IMPORTANT:** After creating the OAuth app, you must grant it access to your organization:

1. **First Authentication Attempt:**
   - Navigate to your application and try to log in
   - GitHub will ask you to authorize the OAuth app
   - **Look for the "Organization access" section**
   - If your organization shows "Request" next to it, click to request access

2. **Organization Admin Approval:**
   - An organization admin must approve the OAuth app access request
   - Admins can approve at: `https://github.com/organizations/YOUR-ORG/settings/oauth_application_policy`
   - Without this approval, you'll get **403 Forbidden** errors from Dex

3. **Verify Access Granted:**
   - Go to https://github.com/settings/applications
   - Find your OAuth app authorization
   - Confirm it shows "Organization access" granted for your org
   - If it shows "Request" or "Denied", the app won't be able to read team membership

### 4. Test Authentication Flow

1. **Access the application:**
   ```
   http://localhost:8080/admin/ (for local testing)
   ```

2. **GitHub OAuth Flow:**
   ```
   1. Redirected to oauth2-proxy authentication
   2. Redirected to Dex for GitHub authentication  
   3. GitHub asks for organization access permission
   4. Redirected back to application with team membership
   ```

3. **Verify Group Claims:**
   ```bash
   # Check that teams appear in logs as "org:team" format
   docker-compose logs admin | grep -i team
   ```

## Team Management

### Adding New Teams

1. **Re-run Setup Script:**
   ```bash
   node setup-docker.js
   # Select GitHub option and update team names
   ```

2. **Update Role Mapping in Admin Service:**
   ```bash
   # The admin service maps GitHub teams to internal roles:
   # "your-org:admins" → "admin" role
   # "your-org:users" → "user" role
   ```

3. **Restart Services:**
   ```bash
   docker-compose restart
   ```

### Team Permission Matrix

| GitHub Team | Internal Role | Permissions |
|-------------|---------------|-------------|
| `your-org:admins` | admin | Full system access, user management |
| `your-org:users` | user | Basic LLM queries, limited access |

## Production Considerations

### Security Best Practices

1. **Team Visibility:**
   ```
   Set teams to "Closed" rather than "Public" for better security
   Only team maintainers should be able to add/remove members
   ```

2. **OAuth App Security:**
   ```bash
   # Use environment variables, never hardcode secrets
   # Rotate OAuth app secrets regularly using setup-docker.js
   # Monitor OAuth app access logs in GitHub
   ```

3. **Organization Settings:**
   ```
   Enable two-factor authentication requirement
   Set up SAML SSO if available
   Configure IP allow lists if needed
   ```

### Docker-Specific Configuration

1. **Environment Files:**
   ```bash
   # Generated by setup-docker.js:
   # .env.auth - Contains OAuth2 configuration
   # dex.config.yaml - Contains GitHub connector configuration
   ```

2. **Container Networking:**
   ```bash
   # All services communicate on internal Docker network
   # Only nginx (port 8080) is exposed to host
   # Dex runs on internal port 5556
   # oauth2-proxy runs on internal port 4180
   ```

3. **SSL/TLS Configuration:**
   ```bash
   # For production, update BASE_URL in setup-docker.js
   # Configure proper SSL certificates in nginx.conf
   # Update GitHub OAuth app callback URL to HTTPS
   ```

### Monitoring and Logging

1. **GitHub Audit Logs:**
   ```
   Monitor organization audit logs for team membership changes
   Set up webhooks for real-time team updates
   ```

2. **Application Monitoring:**
   ```bash
   # Monitor authentication failures
   docker-compose logs oauth2-proxy | grep -i "auth.*fail"
   
   # Track team-based access patterns
   docker-compose logs admin | grep -i "group.*access"
   ```

### Scaling Considerations

1. **Multiple Organizations:**
   ```yaml
   # Manual configuration in dex.config.yaml for multiple orgs:
   orgs:
   - name: primary-org
     teams: ["admins", "users"]
   - name: contractor-org  
     teams: ["contractors"]
   ```

2. **Configuration Management:**
   ```bash
   # Use setup-docker.js for consistent configuration
   # Version control the configs/providers/github/ templates
   # Backup .env.auth and dex.config.yaml for disaster recovery
   ```

## Common Issues and Troubleshooting

### 403 Forbidden Error from Dex

**Symptoms:**
- Dex logs show: `"failed to authenticate","err":"github: unexpected return status: \"403 Forbidden\""`
- Authentication fails after GitHub redirect

**Causes and Solutions:**

1. **OAuth App Not Granted Organization Access** (Most Common)
   - Solution: Follow step 3 above to grant organization access
   - Check: https://github.com/settings/applications shows organization access

2. **Incorrect Team Names**
   - GitHub team names cannot contain forward slashes (`/`)
   - Use hyphens instead: `sap-llm-gateway-admins` not `sap-llm-gateway/admins`
   - Re-run `node setup-docker.js` with correct team names

3. **User Not a Member of Configured Teams**
   - Verify your GitHub user is actually a member of the required teams
   - Check: https://github.com/orgs/YOUR-ORG/teams

4. **Organization Has OAuth App Restrictions**
   - Check: https://github.com/organizations/YOUR-ORG/settings/oauth_application_policy
   - Ensure your OAuth app is in the approved list

### Redirect to Wrong URL After Authentication

**Symptoms:**
- After successful auth, redirected to `/app/shell/` instead of `/admin/app/shell/`
- Error: "This site can't be reached"

**Solution:**
- This is an nginx configuration issue that's been fixed
- Rebuild nginx container: `docker-compose build nginx`
- Restart services: `docker-compose down && docker-compose up -d`

## Testing Team-Based Authorization

### 1. Test Admin Access
```bash
# User in your-org:admins team should have admin role
# Access http://localhost:8080/admin/
# Should see full admin interface
```

### 2. Test User Access  
```bash
# User in your-org:users team should have user role
# Access http://localhost:8080/admin/
# Should see limited user interface
```

### 3. Test Access Denial
```bash
# User not in any configured team
# Should be denied access after GitHub authentication
```

This GitHub integration provides dynamic, organization-based access control that scales with your development teams using Docker deployment!