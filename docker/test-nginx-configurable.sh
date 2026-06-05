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

echo -e "\n2. Testing with default configuration..."
docker run --rm -d \
    --name test-nginx-default \
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
    echo -e "${RED}✗ Health check failed${NC}"
    docker logs test-nginx-default
fi

docker stop test-nginx-default

echo -e "\n3. Testing with custom configuration..."
docker run --rm -d \
    --name test-nginx-custom \
    -p 8082:9090 \
    -e NGINX_PORT=9090 \
    -e BASE_URL=https://test.example.com \
    -e JWT_ISSUER_URL=https://test.example.com/auth \
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
    echo -e "${RED}✗ Health check failed on custom port${NC}"
    docker logs test-nginx-custom
fi

echo -e "\n4. Verifying configuration was applied..."
docker exec test-nginx-custom cat /etc/nginx/nginx.conf | grep -q "test.example.com" && \
    echo -e "${GREEN}✓ Custom BASE_URL applied${NC}" || \
    echo -e "${RED}✗ Custom BASE_URL not found${NC}"

docker exec test-nginx-custom cat /etc/nginx/njs/jwt.js | grep -q "https://test.example.com/auth" && \
    echo -e "${GREEN}✓ Custom JWT_ISSUER_URL applied${NC}" || \
    echo -e "${RED}✗ Custom JWT_ISSUER_URL not found${NC}"

docker stop test-nginx-custom

echo -e "\n5. Testing volume mode..."
# Create temporary config files
mkdir -p /tmp/nginx-test/njs
cat > /tmp/nginx-test/nginx.conf << 'EOF'
events { worker_connections 1024; }
http {
    server {
        listen 8080;
        location /health { return 200 "OK"; }
    }
}
EOF

cat > /tmp/nginx-test/njs/jwt.js << 'EOF'
// Test JWT file
export default { user: function() { return "test"; } };
EOF

docker run --rm -d \
    --name test-nginx-volume \
    -p 8083:8080 \
    -e CONFIG_MODE=volume \
    -v /tmp/nginx-test/nginx.conf:/etc/nginx/nginx.conf \
    -v /tmp/nginx-test/njs/jwt.js:/etc/nginx/njs/jwt.js \
    test-nginx-configurable:latest || {
    echo -e "${RED}✗ Failed to start in volume mode${NC}"
    exit 1
}

sleep 2

if curl -f http://localhost:8083/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Volume mode works${NC}"
else
    echo -e "${RED}✗ Volume mode health check failed${NC}"
    docker logs test-nginx-volume
fi

docker stop test-nginx-volume
rm -rf /tmp/nginx-test

echo -e "\n${GREEN}All tests passed!${NC}"
echo -e "\nThe Nginx image can now be tagged and pushed to a registry:"
echo "  docker tag test-nginx-configurable:latest ghcr.io/your-org/nginx:latest"
echo "  docker push ghcr.io/your-org/nginx:latest"