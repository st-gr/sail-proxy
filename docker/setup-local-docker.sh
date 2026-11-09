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

# Guard: setup-docker.js --ci runs in unattended mode, which AUTO-DELETES any
# existing docker_postgres_data / docker_valkey_data volumes (setup-docker.js
# ~line 2431) — silent data loss on a re-run against a live local stack. A
# config-only helper must never do that, so refuse when those volumes exist.
# First-time setup (no volumes) proceeds normally.
existing_volumes=$(docker volume ls -q 2>/dev/null | grep -E '^docker_(postgres|valkey)_data$' || true)
if [ -n "$existing_volumes" ]; then
    echo "⚠️  Existing local-stack volumes detected:"
    echo "$existing_volumes" | sed 's/^/   - /'
    echo ""
    echo "Re-running --ci would DELETE these volumes and their data. This script"
    echo "won't do that silently. Choose one:"
    echo "  • Keep your data:   nothing to do — your existing .env config is still valid."
    echo "  • Start clean:      docker compose down -v   (removes the volumes), then re-run this script."
    exit 1
fi

echo "Running non-interactive setup (--ci: Local Development preset)..."
echo ""

# --ci is setup-docker.js's supported headless path: Local auth (hardcoded
# users), generated secrets, localhost URLs — exactly the local-development
# preset this wrapper is for, with no stdin prompts to feed.
node setup-docker.js --ci
setup_status=$?

if [ "$setup_status" -ne 0 ]; then
    echo ""
    echo "❌ Setup failed (setup-docker.js exited with $setup_status)."
    exit "$setup_status"
fi

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