#!/bin/bash

# copy-scripts-to-container.sh
# Copy UI5 optimization scripts to running admin container

set -e

# Find the admin container ID
CONTAINER_ID=$(docker ps --filter "name=admin" --format "{{.ID}}" | head -1)

if [ -z "$CONTAINER_ID" ]; then
    echo "❌ Admin container not found. Make sure it's running:"
    echo "   docker-compose up -d admin"
    exit 1
fi

echo "📦 Found admin container: $CONTAINER_ID"

# Create scripts directory in container
docker exec "$CONTAINER_ID" mkdir -p /tmp/ui5-scripts

# Copy all scripts
docker cp docker/scripts/analyze-ui5-resources.sh "$CONTAINER_ID":/tmp/ui5-scripts/
docker cp docker/scripts/consolidate-ui5-resources.sh "$CONTAINER_ID":/tmp/ui5-scripts/
docker cp docker/scripts/verify-consolidation.sh "$CONTAINER_ID":/tmp/ui5-scripts/
docker cp docker/scripts/README.md "$CONTAINER_ID":/tmp/ui5-scripts/

# Make scripts executable
docker exec "$CONTAINER_ID" chmod +x /tmp/ui5-scripts/*.sh

echo "✅ Scripts copied to container at /tmp/ui5-scripts/"
echo
echo "🚀 To run the scripts:"
echo "   docker exec -it $CONTAINER_ID sh"
echo "   cd /tmp/ui5-scripts"
echo "   ./analyze-ui5-resources.sh"