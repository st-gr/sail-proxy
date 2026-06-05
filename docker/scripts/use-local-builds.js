#!/usr/bin/env node

/**
 * Switch Docker Compose to local build mode
 *
 * This script creates docker-compose.override.yml to force Docker to build
 * images locally instead of pulling them from a registry.
 *
 * Usage:
 *   node docker/scripts/use-local-builds.js
 *
 * After running this script:
 *   docker-compose up --build    # Will build images locally
 */

const fs = require('fs');
const path = require('path');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  blue: '\x1b[34m'
};

// Paths
const scriptDir = __dirname;
const dockerDir = path.dirname(scriptDir);
const overrideFile = path.join(dockerDir, 'docker-compose.override.yml');

console.log(`${colors.blue}Switching to local build mode...${colors.reset}`);
console.log('');

// Create override file
const overrideContent = `# Docker Compose Override - Local Build Mode
#
# This file is automatically loaded by docker-compose and overrides settings
# in docker-compose.yml. It forces Docker to build images locally instead of
# pulling them from a registry.
#
# This is useful for:
#   - Local development with code changes
#   - Testing Dockerfile modifications
#   - Building custom images before pushing to registry
#
# To disable local builds and use registry images:
#   1. Rename or remove this file
#   2. Or use: docker-compose -f docker-compose.yml up (skip override)
#   3. Or use: node docker/scripts/use-registry-only.js
#
# To force local builds:
#   docker-compose up --build
#

services:
  gateway:
    pull_policy: build

  admin:
    pull_policy: build

  ollama:
    pull_policy: build

  nginx:
    pull_policy: build
`;

try {
  fs.writeFileSync(overrideFile, overrideContent);
  console.log(`${colors.green}✓ Created docker-compose.override.yml${colors.reset}`);
  console.log('');
  console.log(`${colors.blue}Local build mode enabled!${colors.reset}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Build images: docker-compose build');
  console.log('  2. Start services: docker-compose up');
  console.log('  3. Or build and start: docker-compose up --build');
  console.log('');
  console.log('To switch back to registry mode:');
  console.log('  node docker/scripts/use-registry-only.js');
  console.log('');
} catch (error) {
  console.error(`${colors.red}✗ Failed to create docker-compose.override.yml: ${error.message}${colors.reset}`);
  process.exit(1);
}
