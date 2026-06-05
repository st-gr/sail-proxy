# Production Security Hardening Guide

## 🔒 Security Improvements for Docker Deployment

### 1. **Secret Management**
- ✅ Environment-based secret management via setup-docker.js
- ✅ No hardcoded secrets in docker-compose.yml or configuration files
- ✅ Cryptographically secure secret generation
- ✅ Proper separation of development vs production secrets

### 2. **Dex Security Hardening**
- ✅ Restricted `allowedOrigins` from `*` to specific URLs
- ✅ Production-appropriate logging level (info)
- ✅ PostgreSQL storage for production persistence
- ✅ HTTPS configuration templates available
- ✅ Explicit OAuth2 grant types specification

### 3. **OAuth2-Proxy Security**
- ✅ Cryptographically secure cookie secrets
- ✅ Configurable cookie expiration and security settings
- ✅ Email domain restrictions
- ✅ Proper reverse proxy header configuration
- ✅ Reduced request logging for production privacy

### 4. **Nginx Security**
- ✅ JWT signature validation with JWKS verification
- ✅ Comprehensive security headers (XSS, CSRF, etc.)
- ✅ SSL/TLS configuration support
- ✅ Rate limiting and access control
- ✅ Proper upstream proxy configuration

### 5. **Container Security**
- ✅ Non-root user execution where possible
- ✅ Read-only volume mounts for configuration
- ✅ Network isolation with dedicated Docker network
- ✅ Health checks for all services
- ✅ Resource limits and restart policies

## 🚀 Production Deployment Checklist

### Before Production:

1. **Run Setup Script for Production**
   ```bash
   cd docker
   node setup-docker.js
   
   # Select your auth provider
   # When prompted for BASE_URL, use your production domain:
   # https://auth.company.com instead of http://localhost:8080
   ```

2. **SSL/TLS Certificate Configuration**
   ```bash
   # Add SSL certificates to nginx configuration
   # Update nginx.conf with proper SSL settings:
   
   server {
       listen 443 ssl http2;
       server_name auth.company.com;
       
       ssl_certificate /etc/nginx/ssl/cert.pem;
       ssl_private_key /etc/nginx/ssl/key.pem;
       ssl_protocols TLSv1.2 TLSv1.3;
       ssl_ciphers ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256;
   }
   ```

3. **Environment Security**
   ```bash
   # Generated .env.auth includes secure defaults:
   # - Cryptographically secure cookie secrets
   # - HTTPS-only cookies (when BASE_URL uses HTTPS)
   # - Proper CORS and origin restrictions
   # - Secure JWT issuer configuration
   ```

4. **Database Security**
   ```bash
   # For production, use external PostgreSQL with:
   # - SSL connections enabled
   # - Strong database passwords
   # - Network isolation
   # - Regular backups
   
   # Update docker-compose.yml or use external database:
   services:
     postgres:
       environment:
         POSTGRES_SSL_MODE: require
         POSTGRES_PASSWORD: strong-production-password
   ```

### Provider-Specific Security:

#### GitHub OAuth Security:
```bash
# In GitHub OAuth App settings:
# - Use HTTPS callback URLs only
# - Restrict to specific organizations
# - Enable 2FA requirement for org members
# - Monitor OAuth app access logs
# - Rotate client secrets regularly
```

#### Okta SAML Security:
```bash
# In Okta SAML app configuration:
# - Use HTTPS for all URLs
# - Enable signature validation (done automatically)
# - Configure proper attribute mappings
# - Restrict group assignments
# - Monitor authentication logs
# - Certificate rotation planning
```

#### LDAP/AD Security:
```bash
# For LDAP integration:
# - Use LDAPS (port 636) for production
# - Service account with minimal permissions
# - Network segmentation for LDAP servers
# - Regular password rotation
# - Monitor bind account usage
```

## 🛡️ Security Monitoring

### 1. **Authentication Monitoring**
```bash
# Monitor authentication failures
docker-compose logs oauth2-proxy | grep -i "auth.*fail"

# Monitor JWT validation errors
docker-compose logs nginx | grep -i "jwt.*error"

# Track group-based access patterns
docker-compose logs admin | grep -i "role.*mapping"
```

### 2. **Container Security Monitoring**
```bash
# Monitor container health
docker-compose ps
docker stats

# Check for security updates
docker images --format "table {{.Repository}}:{{.Tag}}\t{{.CreatedAt}}"

# Scan for vulnerabilities (if using security scanning tools)
# docker scan nginx:alpine
```

### 3. **Log Management**
```bash
# Centralize logs for production
# Configure log shipping to SIEM/log management system
# Set up alerts for authentication anomalies
# Implement log rotation and retention policies
```

## 🔧 Security Configuration Templates

### 1. **Production nginx.conf Security Headers**
```nginx
# Already included in generated nginx.conf:
add_header X-Frame-Options DENY;
add_header X-Content-Type-Options nosniff;
add_header X-XSS-Protection "1; mode=block";
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";
add_header Content-Security-Policy "default-src 'self'";
add_header Referrer-Policy "strict-origin-when-cross-origin";
```

### 2. **Production Docker Compose Security**
```yaml
# Security enhancements for production:
version: '3.8'
services:
  nginx:
    user: "101:101"  # nginx user
    read_only: true
    tmpfs:
      - /var/cache/nginx
      - /var/run
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETGID
      - SETUID

  dex:
    user: "65534:65534"  # nobody user
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL

  oauth2-proxy:
    user: "65534:65534"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
```

### 3. **Network Security**
```yaml
# Network isolation
networks:
  sap-llm-network:
    driver: bridge
    internal: false  # Only nginx needs external access
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

## 🚨 Security Incident Response

### 1. **Authentication Breach Response**
```bash
# Immediate actions:
# 1. Rotate OAuth2 client secrets
node setup-docker.js  # Re-run setup to generate new secrets

# 2. Invalidate all user sessions
docker-compose restart oauth2-proxy dex

# 3. Review authentication logs
docker-compose logs --since=24h | grep -i "auth\|login\|token"

# 4. Update provider credentials (GitHub/Okta/LDAP)
```

### 2. **Container Compromise Response**
```bash
# Stop affected services
docker-compose stop

# Investigate container state
docker-compose logs --since=1h > incident-logs.txt

# Rebuild from clean images
docker-compose down
docker-compose pull
docker-compose build --no-cache
docker-compose up -d
```

## 📋 Regular Security Maintenance

### Weekly Tasks:
- [ ] Review authentication logs for anomalies
- [ ] Check container health and resource usage
- [ ] Verify SSL certificate expiration dates
- [ ] Review user group memberships

### Monthly Tasks:
- [ ] Update container base images
- [ ] Rotate OAuth2 proxy secrets
- [ ] Review and test backup procedures
- [ ] Security scan container images
- [ ] Review access logs and patterns

### Quarterly Tasks:
- [ ] Rotate provider client secrets (GitHub/Okta)
- [ ] Review and update security policies
- [ ] Test incident response procedures
- [ ] Security assessment and penetration testing
- [ ] Update documentation and runbooks

## 🔍 Security Validation

### 1. **Authentication Flow Testing**
```bash
# Test each provider authentication flow
# Verify JWT token validation
# Confirm group-based access control
# Test session timeout and refresh
```

### 2. **Security Scanner Integration**
```bash
# Container vulnerability scanning
# Dependency vulnerability scanning
# SSL/TLS configuration validation
# Security header verification
```

### 3. **Penetration Testing Checklist**
- [ ] Authentication bypass attempts
- [ ] Session management vulnerabilities
- [ ] JWT token manipulation
- [ ] CSRF protection validation
- [ ] XSS prevention verification
- [ ] Authorization bypass testing

This security hardening guide ensures your Docker-deployed SAP LLM Gateway authentication system meets enterprise security standards!