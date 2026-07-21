# Production stage: Nginx with configurable templates
FROM nginx:alpine

# OCI provenance labels — connect the published image to its source repo on ghcr
LABEL org.opencontainers.image.source="https://github.com/st-gr/sail-proxy" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.description="SAIL-Proxy nginx edge — auth-aware routing for gateway and admin services"

# Install nginx-module-njs for JavaScript support and update libexpat for security
RUN apk add --no-cache nginx-module-njs && \
    apk upgrade --no-cache libexpat

# Create necessary directories
RUN mkdir -p /etc/nginx/njs /etc/nginx/templates/njs

# Copy template files
COPY nginx/templates/nginx.conf.tmpl /etc/nginx/templates/
COPY nginx/templates/njs/jwt.js.tmpl /etc/nginx/templates/njs/
COPY proxy_params /etc/nginx/proxy_params

# Copy entrypoint script
COPY nginx/entrypoint.sh /usr/local/bin/nginx-entrypoint.sh

# Set proper permissions
RUN chmod 644 /etc/nginx/templates/nginx.conf.tmpl \
    && chmod 644 /etc/nginx/templates/njs/jwt.js.tmpl \
    && chmod 644 /etc/nginx/proxy_params \
    && chmod +x /usr/local/bin/nginx-entrypoint.sh

# Create nginx user if it doesn't exist and set ownership
RUN chown -R nginx:nginx /etc/nginx/njs /etc/nginx/templates

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${NGINX_PORT:-8080}/health || exit 1

# Expose ports
EXPOSE 8080 443

# Use custom entrypoint that processes templates
ENTRYPOINT ["/usr/local/bin/nginx-entrypoint.sh"]