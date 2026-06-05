# LDAP/Active Directory Integration Setup Guide

## Overview

This guide covers LDAP/Active Directory integration for the SAP LLM Gateway authentication system using Dex and oauth2-proxy. The setup supports two deployment modes:

1. **Local Test Server** - Docker-managed OpenLDAP with pre-configured test data
2. **External LDAP/AD** - Integration with existing enterprise LDAP or Active Directory servers

## Quick Start - Local Test Server

For testing LDAP integration, we provide a complete Docker environment with an OpenLDAP server pre-populated with test users and groups.

### 1. Run Interactive Setup

```bash
# Navigate to docker directory
cd docker

# Run the interactive setup script
node setup-docker.js

# Select option 3: LDAP/Active Directory
# Choose server type: local (default)
# The local server is pre-configured with test data
```

### 2. Deploy Services

```bash
# Build nginx container (required for configuration changes)
docker-compose build nginx

# Start services with LDAP test environment
docker-compose up -d

# The setup automatically includes OpenLDAP server and test data
# Check status of all services
docker-compose ps
```

### 3. Access Application

- **Main Application**: http://localhost:8080/admin/
- **LDAP Admin Interface**: http://localhost:8081 (optional, for browsing LDAP directory)

### 4. Test Users (Local Test Server)

All test users use password: `P@ssw0rd!`

| Username | Groups | Role Mapping |
|----------|--------|-------------|
| `admin` | sap-llm-gateway-admin, security-team | admin, admin |
| `alice` | sap-llm-gateway-admin, developers | admin, user |
| `user` | sap-llm-gateway-user | user |
| `bob` | sap-llm-gateway-user, developers | user, user |
| `charlie` | sap-llm-gateway-user | user |

> **Note:** These test users are only available when using the local test LDAP server.

### 5. Test Authentication Flow

1. Visit http://localhost:8080/admin/
2. Click "Log in with LDAP Directory"
3. Enter username (e.g., `admin`) and password `P@ssw0rd!`
4. View user groups and role mapping on the result page

## Quick Start - External LDAP/AD Server

For production deployments or integration with existing enterprise LDAP/Active Directory servers.

### 1. Run Interactive Setup for External Server

```bash
# Navigate to docker directory
cd docker

# Run the interactive setup script
node setup-docker.js

# Select option 3: LDAP/Active Directory
# Choose server type: external
# Enter your LDAP/AD server details:
# - LDAP server: ldap.company.com:636 (or your server:port)
# - Allow insecure connection: false (use SSL in production)
# - Bind DN: cn=dex-service,ou=Service Accounts,dc=company,dc=com
# - Bind password: your-service-account-password
# - User search base DN: ou=Users,dc=company,dc=com
# - User search filter: (objectClass=person) [default for AD]
# - Username attribute: sAMAccountName [default for AD]
# - Group search base DN: ou=Groups,dc=company,dc=com
# - Group search filter: (objectClass=group) [default for AD]
# - Group member attribute: member [default for AD]
```

### 2. Deploy External LDAP Configuration

```bash
# Build nginx container (required for configuration changes)
docker-compose build nginx

# Start services (no local LDAP server will be started)
docker-compose up -d

# Check status - note that ldap-server is not included
docker-compose ps
```

### 3. Test with Your Domain Users

- **Main Application**: http://localhost:8080/admin/
- Login with your domain credentials (e.g., john.doe / domain-password)
- Verify group membership and role assignment

## Architecture

The LDAP integration follows this flow:

### Local Test Server Mode
```
User → nginx:8080 → oauth2-proxy:4180 ← dex:5556 ← ldap-server:389 (Docker)
          ↓                              ↓
    admin:4004 (displays groups)  PostgreSQL:5432
```

### External LDAP/AD Mode
```
User → nginx:8080 → oauth2-proxy:4180 ← dex:5556 ← your-ldap.company.com:636
          ↓                              ↓
    admin:4004 (displays groups)  PostgreSQL:5432
```

## Local Test Environment Components

### 1. OpenLDAP Server (ldap-server:389)

- **Base DN**: `dc=example,dc=com`
- **Admin DN**: `cn=admin,dc=example,dc=com`
- **Admin Password**: `admin`
- **Users**: Located in `ou=people,dc=example,dc=com`
- **Groups**: Located in `ou=groups,dc=example,dc=com`

### 2. Generated Dex Configuration

The setup script generates a dex.config.yaml with LDAP connector:

```yaml
connectors:
- type: ldap
  id: ldap-directory
  name: LDAP Directory
  config:
    host: ldap-server:389
    insecureNoSSL: true
    bindDN: cn=admin,dc=example,dc=com
    bindPW: admin
    
    userSearch:
      baseDN: ou=people,dc=example,dc=com
      filter: "(objectClass=inetOrgPerson)"
      username: uid
      idAttr: uid
      emailAttr: mail
      nameAttr: displayName
      preferredUsernameAttr: uid
    
    groupSearch:
      baseDN: ou=groups,dc=example,dc=com
      filter: "(objectClass=groupOfUniqueNames)"
      nameAttr: cn
      userMatchers:
      - userAttr: DN
        groupAttr: uniqueMember
```

### 3. Docker Compose Override

The LDAP provider includes a docker-compose.override.yml that adds:

```yaml
services:
  ldap-server:
    image: osixia/openldap:1.5.0
    ports:
      - "389:389"
    volumes:
      - ./configs/providers/ldap/ldap-server:/container/service/slapd/assets/config/bootstrap/ldif/custom

  ldap-admin:
    image: osixia/phpldapadmin:latest
    ports:
      - "8081:443"
    environment:
      - PHPLDAPADMIN_LDAP_HOSTS=ldap-server
```

## Production Active Directory Setup

### Prerequisites

Before configuring production LDAP, gather this information:

**Required Information:**
- **LDAP Server**: Hostname/IP and port (e.g., `ldap.company.com:636`)
- **Domain**: Active Directory domain (e.g., `company.com`)
- **Base DN**: Base Distinguished Name (e.g., `dc=company,dc=com`)
- **Service Account**: DN and password for Dex to bind with
- **User Base DN**: Where users are stored (e.g., `ou=Users,dc=company,dc=com`)
- **Group Base DN**: Where groups are stored (e.g., `ou=Groups,dc=company,dc=com`)
- **Security Groups**: Names of AD groups to grant access

### 1. Active Directory Setup

```powershell
# Create Security Groups
New-ADGroup -Name "sap-llm-gateway-admin" -GroupScope Global -GroupCategory Security
New-ADGroup -Name "sap-llm-gateway-user" -GroupScope Global -GroupCategory Security

# Add Users to Groups
Add-ADGroupMember -Identity "sap-llm-gateway-admin" -Members "john.doe","admin.user"
Add-ADGroupMember -Identity "sap-llm-gateway-user" -Members "regular.user","jane.smith"

# Create Service Account
New-ADUser -Name "dex-service" -UserPrincipalName "dex-service@company.com" -Enabled $true
# Set password and configure as service account
```

### 2. Production Configuration

Run setup-docker.js with production values:

```bash
# Run setup script for production
node setup-docker.js

# Select option 3: LDAP/Active Directory
# Enter production values:
# - LDAP server: ldap.company.com:636
# - Base DN: dc=company,dc=com
# - Bind DN: cn=dex-service,ou=Service Accounts,dc=company,dc=com
# - Bind password: your-service-account-password
# - User search base: ou=Users,dc=company,dc=com
# - Group search base: ou=Groups,dc=company,dc=com

# Update BASE_URL for production
# Enter: https://auth.company.com instead of localhost
```

### 3. Production Security Updates

After running setup script, manually update the generated dex.config.yaml for production security:

```yaml
# Update for production in dex.config.yaml
web:
  https: 0.0.0.0:5556
  tlsCert: /etc/dex/tls.crt
  tlsKey: /etc/dex/tls.key
  allowedOrigins: ["https://auth.company.com"]

connectors:
- type: ldap
  config:
    # Use secure LDAP
    host: ldap.company.com:636
    insecureNoSSL: false
    insecureSkipVerify: false
    
    # Active Directory user search
    userSearch:
      filter: "(objectClass=person)"
      username: sAMAccountName
      idAttr: sAMAccountName
      emailAttr: mail
      nameAttr: displayName
      preferredUsernameAttr: sAMAccountName
    
    # Active Directory group search
    groupSearch:
      filter: "(objectClass=group)"
      userMatchers:
      - userAttr: DN
        groupAttr: member
      nameAttr: cn
```

## Testing and Troubleshooting

### 1. Test LDAP Connection

```bash
# For test environment, test service account bind
docker-compose exec ldap-server ldapsearch -x -H ldap://localhost:389 \
  -D "cn=admin,dc=example,dc=com" \
  -w "admin" \
  -b "dc=example,dc=com" \
  "(objectClass=person)"

# Test user search
docker-compose exec ldap-server ldapsearch -x -H ldap://localhost:389 \
  -D "cn=admin,dc=example,dc=com" \
  -w "admin" \
  -b "ou=people,dc=example,dc=com" \
  "(uid=admin)"

# Test group membership
docker-compose exec ldap-server ldapsearch -x -H ldap://localhost:389 \
  -D "cn=admin,dc=example,dc=com" \
  -w "admin" \
  -b "ou=groups,dc=example,dc=com" \
  "(cn=sap-llm-gateway-admin)"
```

### 2. View Service Logs

```bash
# Check Dex LDAP connector logs
docker-compose logs dex | grep -i ldap

# Check oauth2-proxy authentication
docker-compose logs oauth2-proxy | grep -i auth

# Check LDAP server status (test environment)
docker-compose logs ldap-server

# View all service health
docker-compose ps
```

### 3. Common Issues

**LDAP Bind Errors:**
```bash
# Check service logs for authentication failures
docker-compose logs dex | grep -i "bind.*error"

# Common causes:
# - Wrong bind DN or password
# - Network connectivity issues
# - LDAP server not accepting connections
# - Firewall blocking port 389/636
```

**Group Retrieval Issues:**
```bash
# Check group search configuration
docker-compose logs dex | grep -i "group.*search"

# Common causes:
# - Wrong group base DN
# - Incorrect group filter
# - User not member of expected groups
# - Group attribute mapping issues
```

**SSL/TLS Issues:**
```bash
# For production with LDAPS:
# - Ensure proper certificate chain
# - Mount CA certificates if using custom CA
# - Set insecureSkipVerify: false
# - Use proper LDAPS port (636)
```

### 4. LDAP Admin Interface

The test environment includes phpLDAPadmin at http://localhost:8081:

- **Login DN**: `cn=admin,dc=example,dc=com`
- **Password**: `admin`

Use this to browse the LDAP directory structure and verify user/group data.

## Group Management

### Adding New Groups

1. **Re-run Setup Script:**
   ```bash
   node setup-docker.js
   # Update group base DN or add new groups in LDAP directory
   ```

2. **Update Role Mapping in Admin Service:**
   ```bash
   # The admin service maps LDAP groups to internal roles:
   # "sap-llm-gateway-admin" → "admin" role
   # "sap-llm-gateway-user" → "user" role
   ```

3. **Restart Services:**
   ```bash
   docker-compose restart
   ```

### Group Permission Matrix

| LDAP Group | Internal Role | Permissions |
|------------|---------------|-------------|
| `sap-llm-gateway-admin` | admin | Full system access, user management |
| `sap-llm-gateway-user` | user | Basic LLM queries, limited access |

## Security Best Practices

### 1. Service Account Security

- Use dedicated service account with minimal permissions
- Regular password rotation
- Monitor service account usage
- Restrict bind DN to read-only access

### 2. Network Security

- Use LDAPS (port 636) in production
- Implement firewall rules for LDAP traffic
- Network segmentation for LDAP servers
- VPN or private network connectivity

### 3. Configuration Security

- Store LDAP passwords in environment variables (handled by setup script)
- Use TLS certificates for Dex HTTPS
- Implement proper CORS and origin restrictions
- Regular security audits of LDAP filters

## Docker-Specific Configuration

### 1. Generated Files

The setup script creates:

```bash
# dex.config.yaml - Contains LDAP connector configuration
# .env.auth - Contains OAuth2 configuration
# docker-compose.override.yml - Adds LDAP server for testing
```

### 2. Container Networking

```bash
# Test environment includes:
# - ldap-server:389 (OpenLDAP server)
# - ldap-admin:443 (phpLDAPadmin interface)
# - All services communicate on internal Docker network
# - Only nginx (8080) and ldap-admin (8081) exposed to host
```

### 3. Volume Mounts

```bash
# Test data is mounted from:
# ./configs/providers/ldap/ldap-server/bootstrap/01-test-data.ldif
# This populates the LDAP directory with test users and groups
```

## Deployment Commands

### Local Test Environment
```bash
# Setup with local LDAP server
node setup-docker.js  # Select LDAP → local
docker-compose build nginx
docker-compose up -d

# Optional: Start LDAP admin interface
docker-compose --profile ldap-admin up -d

# Test with pre-configured users (admin/P@ssw0rd!)
curl http://localhost:8080/admin/
```

### External LDAP/AD Deployment
```bash
# Setup with external LDAP server
node setup-docker.js  # Select LDAP → external
# Enter your LDAP server details
docker-compose build nginx
docker-compose up -d  # No local LDAP server started

# Test with your domain users
curl http://localhost:8080/admin/
```

### Health Check
```bash
curl http://localhost:8080/health
```

### Stop Services
```bash
docker-compose down
```

This LDAP integration provides enterprise-grade authentication with comprehensive group-based authorization using the unified Docker deployment architecture!