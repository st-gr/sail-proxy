# Configurable Nginx Image for SAP LLM Gateway

This document describes the new configurable Nginx image that can be built once and deployed across multiple environments and authentication providers without rebuilding.

## Overview

The Nginx container is now fully configurable through environment variables, allowing you to:
- Build once, deploy anywhere
- Push a single image to ghcr.io or any container registry
- Configure different authentication providers at runtime
- Support both Docker Compose and Kubernetes deployments
- Use either environment variables or mounted configuration files

## Architecture

### Directory Structure
```
docker/nginx/
├── Dockerfile                    # Main Dockerfile for the configurable image
├── entrypoint.sh                # Smart entrypoint that processes templates
├── templates/                   # Configuration templates
│   ├── nginx.conf.tmpl         # Nginx configuration template
│   └── njs/
│       └── jwt.js.tmpl         # JWT validation JavaScript template
├── .env.example                # Example environment variables
└── .env.production             # Production environment example
```

### Configuration Modes

The image supports two configuration modes:

1. **Template Mode** (default): Generate configuration from environment variables
2. **Volume Mode**: Use pre-generated configuration files mounted as volumes

## Environment Variables

### Basic Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| `NGINX_PORT` | `8080` | Port Nginx listens on |
| `SERVER_NAME` | `localhost` | Server name for Nginx |
| `BASE_URL` | `http://localhost:8080` | Base URL of your deployment |

### JWT Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_ISSUER_URL` | `${BASE_URL}/dex` | JWT token issuer URL |
| `JWT_AUDIENCE` | `oauth2-proxy` | Expected JWT audience |
| `LOGOUT_REDIRECT_URL` | `${BASE_URL}/admin/app/shell/` | URL to redirect after logout |

### Service Discovery
| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH2_PROXY_HOST` | `oauth2-proxy` | OAuth2 proxy hostname |
| `OAUTH2_PROXY_PORT` | `4180` | OAuth2 proxy port |
| `DEX_HOST` | `dex` | Dex OIDC provider hostname |
| `DEX_PORT` | `5556` | Dex OIDC provider port |
| `ADMIN_HOST` | `admin` | Admin service hostname |
| `ADMIN_PORT` | `4004` | Admin service port |
| `GATEWAY_HOST` | `gateway` | Gateway service hostname |
| `GATEWAY_PORT` | `3000` | Gateway service port |

### JWKS Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| `JWKS_ENDPOINT` | `http://${DEX_HOST}:${DEX_PORT}/dex/keys` | JWKS endpoint URL |
| `ENABLE_JWKS_CACHE` | `true` | Enable JWKS caching |

### Configuration Mode
| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_MODE` | `template` | Configuration mode: `template` or `volume` |

## Usage Examples

### Docker Compose

```yaml
nginx:
  image: ghcr.io/your-org/sap-llm-gateway-nginx:latest
  ports:
    - "8080:8080"
  environment:
    - BASE_URL=https://your-domain.com
    - JWT_ISSUER_URL=https://your-domain.com/dex
    - NGINX_PORT=8080
    - CONFIG_MODE=template
```

### Kubernetes with ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
data:
  BASE_URL: "https://your-domain.com"
  JWT_ISSUER_URL: "https://your-domain.com/dex"
  OAUTH2_PROXY_HOST: "oauth2-proxy-service"
  DEX_HOST: "dex-service"
  ADMIN_HOST: "admin-service"
  GATEWAY_HOST: "gateway-service"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
      - name: nginx
        image: ghcr.io/your-org/sap-llm-gateway-nginx:latest
        envFrom:
        - configMapRef:
            name: nginx-config
```

### Kubernetes with Volume Mounts

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-files
data:
  nginx.conf: |
    # Your complete nginx.conf
  jwt.js: |
    // Your JWT validation script
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
      - name: nginx
        image: ghcr.io/your-org/sap-llm-gateway-nginx:latest
        env:
        - name: CONFIG_MODE
          value: "volume"
        volumeMounts:
        - name: nginx-config
          mountPath: /etc/nginx/nginx.conf
          subPath: nginx.conf
        - name: nginx-config
          mountPath: /etc/nginx/njs/jwt.js
          subPath: jwt.js
      volumes:
      - name: nginx-config
        configMap:
          name: nginx-files
```

## Building the Image

```bash
# From the docker directory
docker build -f nginx/Dockerfile -t sap-llm-gateway-nginx:latest .

# Tag for registry
docker tag sap-llm-gateway-nginx:latest ghcr.io/your-org/sap-llm-gateway-nginx:latest

# Push to registry
docker push ghcr.io/your-org/sap-llm-gateway-nginx:latest
```

## Testing

### Local Testing with Docker

```bash
# Run with default configuration
docker run -p 8080:8080 \
  -e BASE_URL=http://localhost:8080 \
  sap-llm-gateway-nginx:latest

# Run with custom configuration
docker run -p 8080:8080 \
  -e BASE_URL=https://test.example.com \
  -e JWT_ISSUER_URL=https://test.example.com/auth \
  -e OAUTH2_PROXY_HOST=auth-proxy \
  sap-llm-gateway-nginx:latest
```

### Verify Configuration

```bash
# Check if Nginx started correctly
docker exec <container-id> nginx -t

# View generated configuration
docker exec <container-id> cat /etc/nginx/nginx.conf
docker exec <container-id> cat /etc/nginx/njs/jwt.js
```

## Migration from Old Setup

To migrate from the old setup where configuration was baked into the image:

1. **Stop using setup-docker.js for Nginx configuration** - The setup script is no longer needed for Nginx
2. **Update docker-compose.yml** to use environment variables instead of rebuilding
3. **Set provider-specific values** through environment variables:
   - For GitHub: Set appropriate JWT issuer and audience
   - For LDAP: Configure with your LDAP provider's OIDC endpoint
   - For Okta: Use Okta's SAML/OIDC endpoints

## Troubleshooting

### Configuration Not Applied

Check the container logs:
```bash
docker logs <container-id>
```

Verify environment variables are set:
```bash
docker exec <container-id> env | grep -E '(BASE_URL|JWT_|NGINX_)'
```

### JWKS Cache Issues

If JWT validation fails:
1. Check if JWKS endpoint is accessible from the container
2. Verify `ENABLE_JWKS_CACHE` is set to `true`
3. Check `/tmp/jwks.json` exists in the container

### Template Processing Errors

If you see "envsubst: not found":
- The Alpine image should include `envsubst` by default
- Verify the Dockerfile hasn't been modified

## Best Practices

1. **Use environment variables for dynamic values** - Avoid hardcoding URLs
2. **Set CONFIG_MODE explicitly** - Don't rely on defaults in production
3. **Test configuration locally** before deploying to production
4. **Use secrets management** for sensitive values in Kubernetes
5. **Version your images** - Use semantic versioning for the Nginx image

## Security Considerations

1. **Don't expose internal service names** - Use proper service discovery
2. **Validate JWT tokens properly** - Ensure JWKS cache is working
3. **Use HTTPS in production** - Set BASE_URL with https://
4. **Restrict internal endpoints** - The configuration maintains IP-based restrictions for internal services

## Future Enhancements

- Support for additional authentication providers
- Automatic JWKS refresh without container restart
- Health check improvements
- Prometheus metrics endpoint
- Support for multiple JWT issuers