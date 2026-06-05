#!/bin/sh

# JWKS Cache Population Script
# This script fetches JWKS from Dex and populates nginx shared memory cache
# It should be run after Dex is available but before nginx starts handling requests

echo "Starting JWKS cache population..."

# Wait for Dex to be available
echo "Waiting for Dex to be available..."
until wget -q --spider http://dex:5556/dex/.well-known/openid-configuration 2>/dev/null; do
    echo "Waiting for Dex..."
    sleep 2
done

echo "Dex is available, fetching JWKS..."

# Fetch JWKS from Dex
JWKS_RESPONSE=$(wget -q -O- http://dex:5556/dex/keys 2>/dev/null)

if [ $? -eq 0 ] && [ -n "$JWKS_RESPONSE" ]; then
    echo "JWKS fetched successfully"
    echo "JWKS content: $JWKS_RESPONSE"
    
    # Write JWKS to a file for nginx init script to read
    echo "$JWKS_RESPONSE" > /tmp/jwks.json
    echo "JWKS written to /tmp/jwks.json"
else
    echo "Failed to fetch JWKS from Dex"
    exit 1
fi

echo "JWKS cache population completed"