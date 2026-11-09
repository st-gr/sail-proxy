# Production stage: Nginx with configurable templates
FROM nginx:alpine

# OCI provenance labels — connect the published image to its source repo on ghcr
LABEL org.opencontainers.image.source="https://github.com/st-gr/sail-proxy" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.description="SAIL-Proxy nginx edge — auth-aware routing for gateway and admin services"

# Upgrade every Alpine package to the current release of the image's Alpine branch: the nginx:alpine tag
# trails Alpine's security fixes (curl CVE-2026-92392 was still at 8.22.0 in the 2026-10-22 tag), and a
# named list missed each new one. nginx itself comes from nginx.org, whose repository is not configured
# in the image, so this never changes the nginx version.
RUN apk upgrade --no-cache

# Create necessary directories
RUN mkdir -p /etc/nginx/templates

# Copy template files
COPY nginx/templates/nginx.conf.tmpl /etc/nginx/templates/
COPY proxy_params /etc/nginx/proxy_params

# Copy entrypoint script
COPY nginx/entrypoint.sh /usr/local/bin/nginx-entrypoint.sh

# Set proper permissions
RUN chmod 644 /etc/nginx/templates/nginx.conf.tmpl \
    && chmod 644 /etc/nginx/proxy_params \
    && chmod +x /usr/local/bin/nginx-entrypoint.sh

# Create nginx user if it doesn't exist and set ownership
RUN chown -R nginx:nginx /etc/nginx/templates

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${NGINX_PORT:-8080}/health || exit 1

# Expose ports
EXPOSE 8080 443

# Use custom entrypoint that processes templates
ENTRYPOINT ["/usr/local/bin/nginx-entrypoint.sh"]