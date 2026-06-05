#!/bin/sh

# Custom nginx entrypoint that populates JWKS cache before starting nginx

echo "Starting SAP LLM Gateway Nginx with JWT authentication..."

# Run the original nginx entrypoint in the background to set up configs
/docker-entrypoint.sh echo "Configuration setup complete" > /dev/null 2>&1

# Populate JWKS cache
echo "Populating JWKS cache..."
/usr/local/bin/populate-jwks.sh

# If JWKS was populated successfully, try to pre-load it into nginx shared memory
# Note: This is a best-effort attempt - the actual loading will happen when nginx starts
if [ -f /tmp/jwks.json ]; then
    echo "JWKS file available for nginx shared memory cache"
else
    echo "Warning: JWKS not available - will use development bypass mode"
fi

# Start nginx in foreground
echo "Starting nginx..."
exec nginx -g "daemon off;"