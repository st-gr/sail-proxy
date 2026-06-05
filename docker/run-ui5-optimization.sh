#!/bin/bash

# run-ui5-optimization.sh 
# Execute UI5 optimization in running admin container (BusyBox compatible)

set -e

CONTAINER_ID=$(docker ps --filter "name=admin" --format "{{.ID}}" | head -1)

if [ -z "$CONTAINER_ID" ]; then
    echo "❌ Admin container not found"
    exit 1
fi

echo "🔍 Running UI5 Resources Optimization in container $CONTAINER_ID"
echo

# Execute the optimization workflow
docker exec -it "$CONTAINER_ID" sh -c '
echo "=== UI5 RESOURCES OPTIMIZATION ==="
echo "Container: $(hostname)"
echo "Working directory: $(pwd)"
echo "Admin root: /app/services/admin"
echo

# Check if scripts exist
if [ ! -f "/tmp/ui5-scripts/analyze-ui5-resources.sh" ]; then
    echo "❌ Scripts not found. Run copy-scripts-to-container.sh first"
    exit 1
fi

cd /tmp/ui5-scripts

echo "📊 Step 1: Analyzing current duplication..."
echo "----------------------------------------"
./analyze-ui5-resources.sh

echo
echo "🔄 Step 2: Preview consolidation..."
echo "-----------------------------------"
./consolidate-ui5-resources.sh --dry-run

echo
echo "⚠️  Ready to perform actual consolidation..."
read -p "Continue? (y/N): " confirm

if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "❌ Aborted by user"
    exit 1
fi

echo
echo "🚀 Step 3: Performing consolidation..."
echo "--------------------------------------"
./consolidate-ui5-resources.sh

echo
echo "✅ Step 4: Verifying results..."
echo "-------------------------------"
./verify-consolidation.sh --test-http

echo
echo "🎉 UI5 optimization complete!"
echo "Check /app/services/admin/consolidation-report.txt for details"
'