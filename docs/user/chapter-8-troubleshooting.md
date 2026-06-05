---
title: SAIL-PROXY User Guide - Chapter 8
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-7-roles.md) | [Content Table](README.md) | [Next Chapter >>](chapter-9-faq.md)

---

## Troubleshooting

This chapter covers common issues, error messages, and their solutions when using SAIL-PROXY.

### Installation Issues

#### CLI Installation Problems

**Node.js Version Issues**:
```bash
# Error: Node.js version not supported
# Solution: Install Node.js 20 or higher
nvm install 20
nvm use 20
npm install -g @st-gr/sail-proxy
```

**Permission Errors During Installation**:
```bash
# Error: EACCES permission denied
# Solution: Use npm prefix or sudo (Linux/macOS)
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
npm install -g @st-gr/sail-proxy

# Alternative: Use sudo (not recommended)
sudo npm install -g @st-gr/sail-proxy
```

**Network/Proxy Issues**:
```bash
# Error: Network timeout or proxy blocking
# Solution: Configure npm proxy settings
npm config set proxy http://your-proxy:port
npm config set https-proxy http://your-proxy:port
npm config set registry https://registry.npmjs.org/
```

#### Docker Installation Problems

**Port Conflicts**:
```bash
# Error: Port already in use
# Solution: Check and kill processes using required ports
sudo lsof -i :8080 -i :3000 -i :4004 -i :5432 -i :6379
sudo kill -9 <process-id>

# Alternative: Change ports in docker-compose.yml
```

**Docker Permission Issues**:
```bash
# Error: Permission denied (daemon socket)
# Solution: Add user to docker group (Linux)
sudo usermod -aG docker $USER
newgrp docker
```

**SSL Certificate Problems**:
```bash
# Error: SSL certificate validation failed
# Solution: Check certificate files and domain configuration
ls -la ssl/cert.pem ssl/key.pem
openssl x509 -in ssl/cert.pem -text -noout
```

### Authentication & Authorization Issues

#### API Key Problems

**Invalid API Key Error**:
```json
{
  "error": {
    "message": "Invalid API key provided",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
```

**Solutions**:
```bash
# Verify API key format (should start with 'sp-proj-')
echo $API_KEY | grep "^sp-proj-"

# Test API key validity
curl -H "Authorization: Bearer $API_KEY" \
     http://localhost:3000/v1/models

# Create new API key if needed (CLI)
sail-proxy apikey create --name "replacement-key"

# Check API key in Admin Cockpit (Docker)
# Navigate to API Keys section and verify status
```

**API Key Suspended or Revoked**:
```json
{
  "error": {
    "message": "API key has been suspended",
    "type": "authentication_error", 
    "code": "api_key_suspended"
  }
}
```

**Solutions**:
- Check Admin Cockpit for key status
- Contact your API Key Manager or Administrator
- Verify no security violations triggered automatic suspension

#### Rate Limiting Issues

**Rate Limit Exceeded**:
```json
{
  "error": {
    "message": "Rate limit exceeded. Try again in 1 hour.",
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded"
  }
}
```

**Solutions**:
```bash
# Check current rate limits (CLI)
sail-proxy apikey list

# Monitor usage in real-time
sail-proxy logs --follow | grep "rate_limit"

# Request rate limit increase from Administrator
```

#### OAuth2 Authentication Issues (Docker)

**OAuth2 Login Failures**:
- **GitHub OAuth**: Verify organization membership if organization restriction is enabled
- **Okta SAML**: Check SAML configuration and user attributes
- **LDAP**: Verify LDAP connection and user DN format

**Session Expiry Issues**:
```bash
# Clear browser cookies for the domain
# Or restart OAuth2-proxy service
docker-compose restart oauth2-proxy
```

### Connection & Network Issues

#### SAP AI Core Connectivity

**OAuth Token Errors**:
```json
{
  "error": {
    "message": "Failed to refresh OAuth token",
    "type": "authentication_error",
    "code": "oauth_refresh_failed"
  }
}
```

**Solutions**:
```bash
# Verify SAP AI Core service key configuration
sail-proxy config show | grep oauth_url
sail-proxy config show | grep client_id

# Test OAuth connectivity
curl -X POST "$OAUTH_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET"

# Update service key if expired
sail-proxy config set oauth_url "new-url"
sail-proxy config set client_id "new-client-id"
sail-proxy config set client_secret "new-secret"
```

**Network Timeout Issues**:
```bash
# Test network connectivity to SAP AI Core
curl -v -m 30 "$OAUTH_URL"

# Check for proxy/firewall blocking
curl --proxy http://your-proxy:port "$OAUTH_URL"

# Increase timeout in configuration
# Docker: Modify environment variables in docker-compose.yml
# CLI: Currently uses default timeouts
```

#### Service Connectivity Issues

**Database Connection Problems** (Docker):
```bash
# Check PostgreSQL service status
docker-compose ps postgres
docker-compose logs postgres

# Test database connectivity
docker-compose exec postgres psql -U postgres -c "\l"

# Restart database if needed
docker-compose restart postgres
```

**Cache/Redis Connection Issues**:
```bash
# Check Valkey/Redis service
docker-compose ps valkey
docker-compose logs valkey

# Test cache connectivity
docker-compose exec valkey valkey-cli ping

# Clear cache if corrupted
docker-compose exec valkey valkey-cli FLUSHALL
```

### Model & API Issues

#### Model Not Available

**Model Not Found Error**:
```json
{
  "error": {
    "message": "Model 'gpt-4o' not found",
    "type": "model_error",
    "code": "model_not_found"
  }
}
```

**Solutions**:
```bash
# List available models
curl -H "Authorization: Bearer $API_KEY" \
     http://localhost:3000/v1/models

# Check model substitution configuration
sail-proxy config show | grep model_substitutions

# Verify SAP AI Core model availability
# Contact SAP AI Core administrator if model should be available
```

#### Streaming Issues

**Streaming Connection Dropped**:
```bash
# Test streaming endpoint
curl -N -H "Authorization: Bearer $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-4o","messages":[{"role":"user","content":"test"}],"stream":true}' \
     http://localhost:3000/openai/v1/chat/completions
```

**Solutions**:
- Check network stability
- Verify proxy settings don't buffer streaming responses
- Test with streaming disabled first
- Check SAIL-PROXY logs for streaming errors

#### Tool Use / Function Calling Problems

**Tool Use Not Supported**:
```json
{
  "error": {
    "message": "Tools not supported for this model",
    "type": "invalid_request_error"
  }
}
```

**Solutions**:
- Verify model supports tool use (check model documentation)
- Test with a model known to support tools (e.g., `gpt-4o`, `claude-3-5-sonnet-20241022`)
- Check if tools are properly formatted in request

### Kyma Deployment Issues

#### ECONNRESET Errors with Kyma Deployments

**Symptoms**:
```
Error: socket hang up
Error: ECONNRESET
Connection was forcibly closed by the remote host
```

**Root Cause**: Istio Gateway in Kyma validates `Host` headers strictly for security. Requests with incorrect hostnames are rejected at the gateway level, causing TCP connection resets.

**❌ Common Mistakes**:
```bash
# Using localhost Host header (will fail)
curl --header 'host: localhost' 'https://your-kyma-domain.com/gateway/...'

# Using connection: Close header (PowerShell issues)
curl --header 'connection: Close' 'https://your-kyma-domain.com/gateway/...'

# Using localhost URLs for Kyma deployments
curl 'http://localhost:3000/...'  # Wrong for Kyma
```

**✅ Solutions**:
```bash
# Use correct Kyma domain without custom Host headers
curl -X POST 'https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/anthropic/v1/messages' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: your-api-key' \
  -d '{"model": "claude-3-5-sonnet", "messages": [{"role": "user", "content": "test"}]}'

# For environment variables (Claude Code, etc.)
export ANTHROPIC_BASE_URL="https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/anthropic"
```

**Diagnosis Steps**:
```bash
# 1. Verify your Kyma domain
kubectl get apirule -n sail-proxy

# 2. Test with correct domain
curl -X GET 'https://your-actual-kyma-domain.com/gateway/v1/models' \
  -H 'x-api-key: your-api-key'

# 3. Check APIRule status
kubectl describe apirule sail-proxy -n sail-proxy

# 4. Verify VirtualService hosts
kubectl get virtualservice -n sail-proxy -o yaml | grep -A5 hosts:
```

**Why This Happens**:
- Kyma uses Istio service mesh for security
- Istio Gateway only accepts requests with hostnames matching the APIRule configuration
- This prevents host header injection attacks
- Connection resets occur at the gateway level, before reaching the application

### Performance Issues

#### Slow Response Times

**Diagnose Performance Issues**:
```bash
# Monitor response times in real-time (CLI)
sail-proxy logs --follow | grep "response_time"

# Test direct connectivity to SAP AI Core
time curl "$OAUTH_URL"

# Check system resource usage
htop  # or Activity Monitor on macOS
docker stats  # For Docker deployment
```

**Optimization Solutions**:
- Enable caching in SAIL-PROXY configuration
- Use faster models for simple tasks (e.g., `claude-3-haiku`)
- Consider deploying SAIL-PROXY closer to your applications
- Check network latency to SAP AI Core endpoints

#### High Memory Usage

**Docker Memory Issues**:
```bash
# Check container memory usage
docker stats --no-stream

# Increase memory limits if needed (docker-compose.yml)
services:
  gateway:
    mem_limit: 2g
  admin:
    mem_limit: 1g
```

### Error Messages Reference

#### Common HTTP Status Codes

**400 Bad Request**:
- Malformed JSON in request body
- Missing required parameters
- Invalid parameter values

**401 Unauthorized**:
- Missing or invalid API key
- Expired authentication token
- Incorrect authorization header format

**403 Forbidden**:
- API key lacks permissions for requested resource
- Rate limit exceeded
- IP address not in allowlist

**404 Not Found**:
- Invalid endpoint URL
- Model not available
- Resource does not exist

**429 Too Many Requests**:
- Rate limit exceeded
- Too many concurrent requests
- Quota exceeded

**500 Internal Server Error**:
- SAIL-PROXY service error
- Database connection failed
- SAP AI Core service unavailable

**502 Bad Gateway**:
- SAP AI Core service unavailable
- Network connectivity issues
- Proxy configuration problems

**504 Gateway Timeout**:
- Request timeout to SAP AI Core
- Network latency issues
- Large response processing timeout

### Docker-Specific Issues

#### Dex Authentication Failure: Password Authentication Failed

**Error Message**:
```
dex-1  | failed to initialize storage: failed to perform migrations:
dex-1  | creating migration table: pq: password authentication failed for user "admin_user"
```

**Cause**: Existing Docker volumes contain old database credentials that don't match the new configuration. This typically occurs when:
- Re-running the setup script with different Postgres credentials
- Switching between different configurations
- Docker volumes persist from previous deployments

**Solution**:
```bash
# Stop all services
docker-compose down

# Remove database volumes (WARNING: This deletes all data)
docker volume rm docker_postgres_data docker_valkey_data

# Re-run setup if needed
cd docker
node setup-docker.js

# Start services with fresh database
docker-compose up -d
```

**Prevention**:
- The setup script automatically detects this condition and prompts to delete volumes
- If preserving data, use identical username/password when re-running setup
- Note the database credentials displayed after setup completion

#### Rancher Desktop WSL2 File Mount Issues

**Error Message**:
```
Error: EISDIR: illegal operation on a directory, read
```

**Cause**: Rancher Desktop on WSL2 has a known bug where single file volume mounts are incorrectly mounted as directories.

**Solution**:
- **Option 1**: Run `docker-compose` commands from Windows PowerShell or CMD instead of WSL2
- **Option 2**: Use directory mounts instead of individual file mounts
- **Option 3**: Switch to Docker Desktop for Windows

**Reference**: See [Rancher Desktop Issue #5632](https://github.com/rancher-sandbox/rancher-desktop/issues/5632)

The setup script automatically detects this condition and displays a warning.

#### 502 Bad Gateway Errors

This is a common issue in Docker deployments. Solutions from project documentation:

**Check Service Status**:
```bash
# Verify all services are running
docker-compose ps

# Check service logs
docker-compose logs nginx
docker-compose logs gateway
docker-compose logs admin
```

**Fix Network Issues**:
```bash
# Restart networking
docker-compose down
docker network prune -f
docker-compose up -d
```

**Rebuild Images** (if configuration changed):
```bash
# Warning: Admin image takes longest to build
docker-compose down
docker volume rm docker_postgres_data docker_valkey_data
docker-compose build --no-cache
docker-compose up -d
```

#### Container Startup Issues

**Service Dependencies**:
```bash
# Services may start before dependencies are ready
# Wait for services to be healthy
docker-compose ps
# Look for "healthy" status on all services

# Check startup order in docker-compose.yml
# Verify depends_on and healthcheck configurations
```

### Diagnostic Commands

#### Comprehensive Health Check

**CLI Deployment**:
```bash
# Service status
sail-proxy status

# Configuration check
sail-proxy config show

# Recent logs
sail-proxy logs --tail 50

# API connectivity test
curl -H "Authorization: Bearer $(sail-proxy config get api_key)" \
     http://localhost:3000/v1/models
```

**Docker Deployment**:
```bash
# Service health
docker-compose ps
docker-compose logs --tail 50

# Database connectivity
docker-compose exec postgres psql -U postgres -c "SELECT version();"

# Cache connectivity
docker-compose exec valkey valkey-cli ping

# API test
curl -H "Authorization: Bearer your-api-key" \
     http://localhost:8080/api/v1/models
```

#### Log Analysis

**Important Log Patterns to Look For**:
```bash
# Authentication failures
grep "authentication_error" logs/

# Rate limiting events
grep "rate_limit" logs/

# Model errors
grep "model_error" logs/

# Performance issues
grep "response_time" logs/ | awk '{print $NF}' | sort -n

# Security events
grep "security_event" logs/
```

### Getting Help

#### Log Collection for Support

**Collect Diagnostic Information**:
```bash
# CLI deployment
sail-proxy status > diagnostic_info.txt
sail-proxy config show >> diagnostic_info.txt
sail-proxy logs --tail 200 >> diagnostic_info.txt

# Docker deployment
docker-compose ps > diagnostic_info.txt
docker-compose logs --tail 200 >> diagnostic_info.txt
```

**Security Note**: Remove sensitive information (API keys, passwords) before sharing diagnostic logs.

#### Support Channels

1. **Check Documentation**: Review [FAQ](chapter-9-faq.md) for common questions
2. **GitHub Issues**: Report bugs or feature requests
3. **Enterprise Support**: Contact your organization's SAIL-PROXY administrator
4. **Community Forums**: Engage with other users and contributors

---

*Next: Check the [FAQ](chapter-9-faq.md) for quick answers to common questions.*