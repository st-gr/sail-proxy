#!/usr/bin/env node

/**
 * Build and tag Docker images for SAP LLM Gateway
 *
 * This script:
 *   1. Extracts the version from package.json
 *   2. Builds all Docker images with proper tags
 *   3. Tags images with both version and 'latest' tags
 *
 * Usage:
 *   node docker/scripts/build-and-tag.js [--no-cache] [--service SERVICE_NAME]
 *
 * Options:
 *   --no-cache       Build without using cache
 *   --service NAME   Build only specific service (gateway, admin, ollama, nginx)
 *
 * Environment variables:
 *   DOCKER_REGISTRY      Container registry (default: ghcr.io)
 *   DOCKER_ORGANIZATION  Registry organization (default: st-gr)
 *   DOCKER_TAG          Image version tag (default: from package.json)
 */

const { execSync } = require('child_process');
const path = require('path');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

// Paths
const scriptDir = __dirname;
const dockerDir = path.dirname(scriptDir);
const projectRoot = path.dirname(dockerDir);

// Default values
const dockerRegistry = process.env.DOCKER_REGISTRY || 'ghcr.io';
const dockerOrganization = process.env.DOCKER_ORGANIZATION || 'st-gr';

// Parse command line arguments
const args = process.argv.slice(2);
let noCache = false;
let service = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-cache') {
    noCache = true;
  } else if (args[i] === '--service' && args[i + 1]) {
    service = args[i + 1];
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Build and tag Docker images for SAP LLM Gateway

Usage:
  node docker/scripts/build-and-tag.js [--no-cache] [--service SERVICE_NAME]

Options:
  --no-cache       Build without using cache
  --service NAME   Build only specific service (gateway, admin, ollama, nginx)
  --help, -h       Show this help message

Environment variables:
  DOCKER_REGISTRY      Container registry (default: ghcr.io)
  DOCKER_ORGANIZATION  Registry organization (default: st-gr)
  DOCKER_TAG          Image version tag (default: from package.json)
`);
    process.exit(0);
  }
}

// Extract version from package.json
console.log(`${colors.blue}Extracting version from package.json...${colors.reset}`);
let version;

try {
  version = execSync('node ' + path.join(scriptDir, 'get-version.js'), {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();

  if (!version) {
    throw new Error('No version returned');
  }
} catch (error) {
  console.error(`${colors.red}Failed to extract version from package.json${colors.reset}`);
  process.exit(1);
}

const dockerTag = process.env.DOCKER_TAG || version;

console.log(`${colors.green}Version: ${dockerTag}${colors.reset}`);
console.log(`${colors.green}Registry: ${dockerRegistry}/${dockerOrganization}${colors.reset}`);
console.log('');

// Services to build
const services = service ? [service] : ['gateway', 'admin', 'ollama', 'nginx'];

// Build images
console.log(`${colors.blue}Building Docker images...${colors.reset}`);

const failedServices = [];

for (const svc of services) {
  console.log(`${colors.yellow}Building ${svc}...${colors.reset}`);

  try {
    // Build the service
    const buildCmd = `docker-compose build ${noCache ? '--no-cache' : ''} ${svc}`;

    execSync(buildCmd, {
      cwd: dockerDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        DOCKER_REGISTRY: dockerRegistry,
        DOCKER_ORGANIZATION: dockerOrganization,
        DOCKER_TAG: dockerTag
      }
    });

    console.log(`${colors.green}✓ ${svc} built successfully${colors.reset}`);

    // Get the built image name
    const imageName = `${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:${dockerTag}`;
    const latestImage = `${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:latest`;

    // Tag as latest
    console.log(`${colors.blue}Tagging ${svc} as latest...${colors.reset}`);

    try {
      execSync(`docker tag ${imageName} ${latestImage}`, {
        stdio: 'inherit'
      });
      console.log(`${colors.green}✓ Tagged ${svc} as latest${colors.reset}`);
    } catch (tagError) {
      console.log(`${colors.yellow}⚠ Warning: Could not tag ${svc} as latest${colors.reset}`);
    }
  } catch (error) {
    console.error(`${colors.red}✗ Failed to build ${svc}${colors.reset}`);
    failedServices.push(svc);
  }

  console.log('');
}

// Summary
console.log(`${colors.green}======================================${colors.reset}`);

if (failedServices.length === 0) {
  console.log(`${colors.green}All images built successfully!${colors.reset}`);
  console.log(`${colors.green}======================================${colors.reset}`);
  console.log('');
  console.log('Built images:');
  for (const svc of services) {
    console.log(`  - ${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:${dockerTag}`);
    console.log(`  - ${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:latest`);
  }
  console.log('');
  console.log(`${colors.blue}Next steps:${colors.reset}`);
  console.log('  - Test locally: docker-compose up');
  console.log('  - Push to registry: node docker/scripts/push-images.js');
  console.log('');
  process.exit(0);
} else {
  console.log(`${colors.red}Some images failed to build${colors.reset}`);
  console.log(`${colors.red}======================================${colors.reset}`);
  console.log('');
  console.log('Failed services:');
  for (const svc of failedServices) {
    console.log(`  - ${svc}`);
  }
  process.exit(1);
}
