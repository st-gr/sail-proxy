#!/bin/bash
# Test script for the configurable Nginx image

set -e

echo "Testing Configurable Nginx Image"
echo "================================"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo -e "\n1. Building the Nginx image..."
docker build -f nginx/Dockerfile -t test-nginx-configurable:latest . || {
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
}
echo -e "${GREEN}✓ Build successful${NC}"

# nginx resolves its upstreams when it starts: outside the stack, point their names at localhost.
STUB_HOSTS="--add-host oauth2-proxy:127.0.0.1 --add-host dex:127.0.0.1 --add-host admin:127.0.0.1 --add-host gateway:127.0.0.1"
FAILURES=0

echo -e "\n2. Testing with default configuration..."
docker run --rm -d \
    --name test-nginx-default $STUB_HOSTS \
    -p 8081:8080 \
    test-nginx-configurable:latest || {
    echo -e "${RED}✗ Failed to start with default config${NC}"
    exit 1
}

sleep 2

# Test health endpoint
if curl -f http://localhost:8081/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Default configuration works${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"; FAILURES=$((FAILURES+1))
    docker logs test-nginx-default
fi

docker stop test-nginx-default

echo -e "\n3. Testing with custom configuration..."
docker run --rm -d \
    --name test-nginx-custom $STUB_HOSTS \
    -p 8082:9090 \
    -e NGINX_PORT=9090 \
    -e BASE_URL=https://test.example.com \
    -e SERVER_NAME=test.example.com \
    test-nginx-configurable:latest || {
    echo -e "${RED}✗ Failed to start with custom config${NC}"
    exit 1
}

sleep 2

# Test health endpoint on custom port
if curl -f http://localhost:8082/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Custom configuration works${NC}"
else
    echo -e "${RED}✗ Health check failed on custom port${NC}"; FAILURES=$((FAILURES+1))
    docker logs test-nginx-custom
fi

echo -e "\n4. Verifying configuration was applied..."
docker exec test-nginx-custom cat /etc/nginx/nginx.conf | grep -q "test.example.com" && \
    echo -e "${GREEN}✓ Custom BASE_URL applied${NC}" || \
    { echo -e "${RED}✗ Custom BASE_URL not found${NC}"; FAILURES=$((FAILURES+1)); }

docker exec test-nginx-custom cat /etc/nginx/nginx.conf | grep -q "location = /_cookie_auth" && \
    echo -e "${GREEN}✓ Sign-in decided by oauth2-proxy (/_cookie_auth)${NC}" || \
    { echo -e "${RED}✗ /_cookie_auth not found${NC}"; FAILURES=$((FAILURES+1)); }

docker stop test-nginx-custom

echo -e "\n5. Testing volume mode..."
# Create temporary config files
# A folder under the checkout (Colima and Docker Desktop share the home folder, not /tmp).
TMP_DIR="$SCRIPT_DIR/.nginx-test"
mkdir -p "$TMP_DIR"
cat > "$TMP_DIR/nginx.conf" << 'EOF'
events { worker_connections 1024; }
http {
    server {
        listen 8080;
        location /health { return 200 "OK"; }
    }
}
EOF

docker run --rm -d \
    --name test-nginx-volume \
    -p 8083:8080 \
    -e CONFIG_MODE=volume \
    -v "$TMP_DIR/nginx.conf:/etc/nginx/nginx.conf" \
    test-nginx-configurable:latest || {
    echo -e "${RED}✗ Failed to start in volume mode${NC}"
    exit 1
}

sleep 2

if curl -f http://localhost:8083/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Volume mode works${NC}"
else
    echo -e "${RED}✗ Volume mode health check failed${NC}"; FAILURES=$((FAILURES+1))
    docker logs test-nginx-volume
fi

docker stop test-nginx-volume
rm -rf "$TMP_DIR"

if [ "$FAILURES" -ne 0 ]; then echo -e "\n${RED}${FAILURES} check(s) failed${NC}"; exit 1; fi
echo -e "\n${GREEN}All tests passed!${NC}"
echo -e "\nThe Nginx image can now be tagged and pushed to a registry:"
echo "  docker tag test-nginx-configurable:latest ghcr.io/your-org/nginx:latest"
echo "  docker push ghcr.io/your-org/nginx:latest"