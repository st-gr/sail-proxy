#!/bin/bash

# SAP LLM Gateway Local Docker Setup - Interactive Configuration
# This script runs the enhanced interactive setup for local development

echo "🚀 SAP LLM Gateway - Local Docker Configuration"
echo "=============================================="
echo ""
echo "This script will configure authentication and services for local development."
echo "For advanced configuration options, run: node setup-docker.js"
echo ""

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo "Please install Node.js and try again."
    exit 1
fi

# Check if setup-docker.js exists
if [ ! -f "setup-docker.js" ]; then
    echo "❌ setup-docker.js not found in current directory."
    echo "Please run this script from the docker/ directory."
    exit 1
fi

echo "Running interactive setup..."
echo ""

# Run the interactive setup with local development preset
export AUTO_SELECT_LOCAL=true
export AUTO_USE_LOCALHOST=true

# Create a temporary input file for automated local setup
cat > /tmp/setup-input << 'EOF'
1
Y
EOF

# Run setup-docker.js with automated input for local development
node setup-docker.js < /tmp/setup-input

# Clean up temporary file
rm -f /tmp/setup-input

echo ""
echo "🎉 Local Docker configuration completed!"
echo ""
echo "Next steps:"
echo "1. Build containers: docker-compose build"
echo "2. Start services:   docker-compose up -d"
echo "3. Access admin UI:  http://localhost:8080/admin/"
echo ""
echo "Test users for local development:"
echo "  - admin@example.com / admin123 (admin access)"
echo "  - user@example.com / user123   (user access)"
echo ""