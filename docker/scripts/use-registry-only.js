#!/usr/bin/env node

/**
 * Switch Docker Compose to registry-only mode
 *
 * This script removes docker-compose.override.yml to allow Docker to pull
 * pre-built images from the configured registry instead of building locally.
 *
 * Usage:
 *   node docker/scripts/use-registry-only.js
 *
 * After running this script:
 *   docker-compose pull    # Pull images from registry
 *   docker-compose up      # Start with registry images
 */

const fs = require('fs');
const path = require('path');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

// Paths
const scriptDir = __dirname;
const dockerDir = path.dirname(scriptDir);
const overrideFile = path.join(dockerDir, 'docker-compose.override.yml');
const envDockerFile = path.join(dockerDir, '.env.docker');

console.log(`${colors.blue}Switching to registry-only mode...${colors.reset}`);
console.log('');

// Check if override file exists
if (fs.existsSync(overrideFile)) {
  try {
    // Backup the override file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(dockerDir, `docker-compose.override.yml.backup.${timestamp}`);

    fs.copyFileSync(overrideFile, backupFile);
    console.log(`${colors.green}✓ Backed up existing override file to: ${path.basename(backupFile)}${colors.reset}`);

    // Remove override file
    fs.unlinkSync(overrideFile);
    console.log(`${colors.green}✓ Removed docker-compose.override.yml${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}✗ Failed to remove override file: ${error.message}${colors.reset}`);
    process.exit(1);
  }
} else {
  console.log(`${colors.yellow}No docker-compose.override.yml found (already in registry mode)${colors.reset}`);
}

console.log('');
console.log(`${colors.blue}Registry-only mode enabled!${colors.reset}`);
console.log('');
console.log('Docker will now pull images from the configured registry.');
console.log('');

// Check if .env.docker exists and show configuration
if (fs.existsSync(envDockerFile)) {
  console.log('Current registry configuration (from .env.docker):');

  try {
    const envContent = fs.readFileSync(envDockerFile, 'utf8');
    const dockerVars = envContent.split('\n')
      .filter(line => line.startsWith('DOCKER_'))
      .map(line => '  ' + line);

    dockerVars.forEach(line => console.log(line));
  } catch (error) {
    console.log(`  ${colors.yellow}Could not read .env.docker${colors.reset}`);
  }

  console.log('');
}

console.log('Next steps:');
console.log('  1. Pull images: docker-compose pull');
console.log('  2. Start services: docker-compose up');
console.log('  3. Or pull and start: docker-compose pull && docker-compose up');
console.log('');
console.log('Alternative: Use docker-compose.registry.yml for strict registry-only mode:');
console.log('  docker-compose -f docker-compose.yml -f docker-compose.registry.yml up');
console.log('');
console.log('To switch back to local build mode:');
console.log('  node docker/scripts/use-local-builds.js');
console.log('');
