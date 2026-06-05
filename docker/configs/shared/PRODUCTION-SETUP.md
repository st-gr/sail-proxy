# Production Setup Instructions

## Prerequisites

### For All Authentication Providers:

1. **Production Domain Setup:**
   ```bash
   # Ensure you have:
   # - Valid SSL certificates for your domain
   # - DNS records pointing to your server
   # - Firewall rules allowing HTTPS traffic (port 443)
   # - Load balancer configuration (if using multiple instances)
   ```

2. **External Database (Recommended):**
   ```bash
   # Set up external PostgreSQL for production:
   # - High availability configuration
   # - SSL connections enabled  
   # - Regular backup procedures
   # - Monitoring and alerting
   ```

### For GitHub OAuth Integration:

1. **GitHub OAuth App Setup:**
   ```
   GitHub.com → Your Org → Settings → Developer settings → OAuth Apps → New OAuth App
   
   Application name: SAP LLM Gateway
   Homepage URL: https://gateway.company.com
   Authorization callback URL: https://auth.company.com/dex/callback
   ```

2. **GitHub Organization Setup:**
   ```bash
   # Create required teams in your GitHub organization:
   # - sap-llm-gateway-admin (for admin access)
   # - sap-llm-gateway-user (for user access)
   # 
   # Configure team privacy settings:
   # - Set teams to "Closed" for better security
   # - Enable 2FA requirement for organization members
   ```

### For Okta SAML Integration:

1. **Okta Admin Console Setup:**
   ```
   Applications → Create App Integration → SAML 2.0
   
   App name: SAP LLM Gateway
   Single sign on URL: https://auth.company.com/dex/callback
   Audience URI: https://auth.company.com/dex
   ```

2. **Group Attribute Statements:**
   ```
   Name: groups
   Name format: Basic
   Filter: Matches regex .*
   Value: getFilteredGroups({"app.name": "SAP LLM Gateway"}, "group.name", 50)
   ```

3. **Create Required Groups:**
   ```
   Directory → Groups → Add Group
   
   Group Names:
   - sap-llm-gateway-admin
   - sap-llm-gateway-user
   
   Assign users to groups and groups to the SAML application
   ```

### For LDAP/Active Directory Integration:

1. **Create Service Account:**
   ```powershell
   # PowerShell on Domain Controller
   New-ADUser -Name "dex-service" -SamAccountName "dex-service" -Path "OU=Service Accounts,DC=company,DC=com"
   Set-ADAccountPassword -Identity "dex-service" -NewPassword (ConvertTo-SecureString "SecurePassword123!" -AsPlainText -Force)
   Enable-ADAccount -Identity "dex-service"
   ```

2. **Grant Read Permissions:**
   ```powershell
   # Grant read access to users and groups
   dsacls "OU=Users,DC=company,DC=com" /G "dex-service:GR"
   dsacls "OU=Security Groups,DC=company,DC=com" /G "dex-service:GR"
   ```

3. **Create Required Groups:**
   ```powershell
   New-ADGroup -Name "sap-llm-gateway-admin" -GroupScope Global -GroupCategory Security
   New-ADGroup -Name "sap-llm-gateway-user" -GroupScope Global -GroupCategory Security
   
   # Add users to groups
   Add-ADGroupMember -Identity "sap-llm-gateway-admin" -Members "admin.user"
   Add-ADGroupMember -Identity "sap-llm-gateway-user" -Members "regular.user"
   ```

4. **Test LDAP Connection:**
   ```bash
   ldapsearch -x -H ldaps://ad.company.com:636 \
     -D "cn=dex-service,ou=Service Accounts,dc=company,dc=com" \
     -W -b "ou=Users,dc=company,dc=com" "(sAMAccountName=testuser)"
   ```

## Deployment Steps

### 1. **Server Preparation**

```bash
# Install Docker and Docker Compose on production server
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Create application directory
sudo mkdir -p /opt/sap-llm-gateway
sudo chown $USER:$USER /opt/sap-llm-gateway
cd /opt/sap-llm-gateway
```

### 2. **Deploy Application Code**

```bash
# Clone or copy the docker deployment files
git clone <repository-url> .
cd docker

# Or copy files from development environment:
# scp -r docker/ user@production-server:/opt/sap-llm-gateway/
```

### 3. **Run Production Setup**

```bash
# Run the interactive setup script
node setup-docker.js

# Select your authentication provider (GitHub/Okta/LDAP)
# When prompted for deployment configuration:
# - Use localhost for development? N
# - Enter your domain: https://auth.company.com

# The script will:
# - Generate secure configuration files
# - Create cryptographically secure secrets
# - Configure proper SSL/HTTPS settings
# - Set up provider-specific authentication
```

### 4. **SSL Certificate Configuration**

```bash
# Option 1: Let's Encrypt (recommended)
sudo apt install certbot
sudo certbot certonly --standalone -d auth.company.com

# Copy certificates to nginx directory
sudo cp /etc/letsencrypt/live/auth.company.com/fullchain.pem ./ssl/
sudo cp /etc/letsencrypt/live/auth.company.com/privkey.pem ./ssl/
sudo chown $USER:$USER ./ssl/*

# Option 2: Custom certificates
# Place your SSL certificate and key in ./ssl/ directory:
# ./ssl/cert.pem (certificate chain)
# ./ssl/key.pem (private key)
```

### 5. **External Database Setup (Recommended)**

```bash
# Update docker-compose.yml for external database:
# Comment out the postgres service
# Update dex.config.yaml with external database connection

# Example external database configuration in dex.config.yaml:
storage:
  type: postgres
  config:
    host: db.company.com
    port: 5432
    database: sap_llm_gateway
    user: dex_user
    password: secure-database-password
    ssl:
      mode: require
```

### 6. **Deploy Services**

```bash
# Build containers with production configuration
docker-compose build --no-cache

# Start services in production mode
docker-compose up -d

# Verify all services are healthy
docker-compose ps
docker-compose logs --tail=50
```

### 7. **Verify Deployment**

```bash
# Test health endpoints
curl https://auth.company.com/health

# Test authentication flow
# 1. Navigate to https://auth.company.com/admin/
# 2. Complete authentication with your chosen provider
# 3. Verify proper group/role mapping
# 4. Test admin vs user access levels
```

## Production Configuration

### 1. **Environment Variables**

The setup script generates secure production configuration:

```bash
# Generated .env.auth includes:
# - HTTPS-only cookie settings
# - Cryptographically secure secrets
# - Provider-specific configurations
# - Proper CORS and origin restrictions

# Additional production environment variables:
export NODE_ENV=production
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
```

### 2. **Nginx Production Configuration**

The generated nginx.conf includes production security features:

```nginx
# SSL/TLS configuration
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256;
ssl_prefer_server_ciphers on;

# Security headers
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";
add_header X-Frame-Options DENY;
add_header X-Content-Type-Options nosniff;
add_header X-XSS-Protection "1; mode=block";
add_header Content-Security-Policy "default-src 'self'";

# Rate limiting
limit_req_zone $binary_remote_addr zone=auth:10m rate=10r/s;
limit_req zone=auth burst=20 nodelay;
```

### 3. **Docker Compose Production Overrides**

Create `docker-compose.prod.yml` for production-specific settings:

```yaml
version: '3.8'
services:
  nginx:
    restart: always
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    deploy:
      resources:
        limits:
          memory: 256M
        reservations:
          memory: 128M

  dex:
    restart: always
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  oauth2-proxy:
    restart: always
    logging:
      driver: "json-file"
      options:
        max-size: "10m" 
        max-file: "3"

  admin:
    restart: always
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  gateway:
    restart: always
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

## Monitoring and Maintenance

### 1. **Health Monitoring**

```bash
# Set up monitoring for all services
# Health check endpoints:
# - https://auth.company.com/health (nginx)
# - https://auth.company.com/dex/.well-known/openid_configuration (dex)
# - Internal service health checks via Docker

# Example monitoring script:
#!/bin/bash
curl -f https://auth.company.com/health || alert_admin "Nginx health check failed"
docker-compose ps --filter "status=running" | grep -q "healthy" || alert_admin "Unhealthy containers detected"
```

### 2. **Log Management**

```bash
# Set up log rotation and centralized logging
# Configure log shipping to SIEM or log management platform
# Set up alerts for authentication failures and errors

# View aggregated logs:
docker-compose logs --follow --tail=100

# Filter for authentication events:
docker-compose logs | grep -i "auth\|login\|token"
```

### 3. **Backup Procedures**

```bash
# Backup configuration files
tar -czf backup-$(date +%Y%m%d).tar.gz \
  docker-compose.yml \
  .env.auth \
  dex.config.yaml \
  nginx.conf \
  njs/ \
  ssl/

# Backup external database (if using external PostgreSQL)
pg_dump -h db.company.com -U dex_user sap_llm_gateway > backup-db-$(date +%Y%m%d).sql

# Store backups securely off-site
```

### 4. **Security Updates**

```bash
# Regular update procedure:
# 1. Update base container images
docker-compose pull

# 2. Rebuild containers with latest security patches
docker-compose build --no-cache --pull

# 3. Test in staging environment first
# 4. Deploy to production with rolling update
docker-compose up -d --no-deps --build service-name

# 5. Verify functionality after updates
```

## Scaling and High Availability

### 1. **Load Balancer Configuration**

```nginx
# Example nginx load balancer configuration
upstream sap_llm_gateway {
    server auth1.company.com:443 max_fails=3 fail_timeout=30s;
    server auth2.company.com:443 max_fails=3 fail_timeout=30s;
    server auth3.company.com:443 backup;
}

server {
    listen 443 ssl http2;
    server_name auth.company.com;
    
    location / {
        proxy_pass https://sap_llm_gateway;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 2. **Database High Availability**

```bash
# Configure PostgreSQL high availability:
# - Master-slave replication
# - Connection pooling (PgBouncer)
# - Automated failover
# - Regular backup and point-in-time recovery
```

### 3. **Session Affinity**

```bash
# For SAML flows, configure session affinity in load balancer
# Use consistent hashing based on session ID or client IP
# Ensure SAML state is maintained during authentication flow
```

## Disaster Recovery

### 1. **Recovery Procedures**

```bash
# Complete disaster recovery procedure:
# 1. Restore from backup
tar -xzf backup-latest.tar.gz

# 2. Restore database
psql -h db.company.com -U dex_user -d sap_llm_gateway < backup-db-latest.sql

# 3. Update DNS if server changed
# 4. Deploy application
docker-compose up -d

# 5. Verify authentication flows work
# 6. Update monitoring and alerting
```

### 2. **Backup Validation**

```bash
# Regular backup testing procedure:
# 1. Deploy backup to staging environment
# 2. Test all authentication providers
# 3. Verify user access and role mappings
# 4. Test admin functionality
# 5. Document any issues found
```

This production setup guide ensures your SAP LLM Gateway authentication system is deployed securely and reliably with the Docker architecture!