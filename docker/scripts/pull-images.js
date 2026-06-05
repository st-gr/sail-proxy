#!/usr/bin/env node

/**
 * Pull Docker images from container registry
 *
 * This script:
 *   1. Extracts the version from package.json (or uses specified version)
 *   2. Pulls all required images from the registry
 *
 * Usage:
 *   node docker/scripts/pull-images.js [--service SERVICE_NAME] [--version VERSION] [--latest]
 *
 * Options:
 *   --service NAME     Pull only specific service (gateway, admin, ollama, nginx)
 *   --version VERSION  Pull specific version (default: from package.json)
 *   --latest           Pull 'latest' tag instead of version tag
 *
 * Prerequisites:
 *   - Docker login to registry (if pulling from private registry)
 *
 *   Login Examples:
 *     GitHub Container Registry (ghcr.io):
 *       docker login ghcr.io -u your-github-username -p ghp_yourGitHubPersonalAccessToken
 *
 *     Docker Hub (docker.io):
 *       docker login docker.io -u your-docker-username -p your-docker-password
 *
 *     Custom Registry:
 *       docker login your-registry.com -u username -p token
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
let service = null;
let specifiedVersion = null;
let useLatest = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--service' && args[i + 1]) {
    service = args[i + 1];
    i++;
  } else if (args[i] === '--version' && args[i + 1]) {
    specifiedVersion = args[i + 1];
    i++;
  } else if (args[i] === '--latest') {
    useLatest = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Pull Docker images from container registry

Usage:
  node docker/scripts/pull-images.js [--service SERVICE_NAME] [--version VERSION] [--latest]

Options:
  --service NAME     Pull only specific service (gateway, admin, ollama, nginx)
  --version VERSION  Pull specific version (default: from package.json)
  --latest           Pull 'latest' tag instead of version tag
  --help, -h         Show this help message

Prerequisites:
  - Docker login to registry (if pulling from private registry)

  Login Examples:
    GitHub Container Registry (ghcr.io):
      docker login ghcr.io -u your-github-username -p ghp_yourGitHubPersonalAccessToken

    Docker Hub (docker.io):
      docker login docker.io -u your-docker-username -p your-docker-password

    Custom Registry:
      docker login your-registry.com -u username -p token

Environment variables:
  DOCKER_REGISTRY      Container registry (default: ghcr.io)
  DOCKER_ORGANIZATION  Registry organization (default: st-gr)
  DOCKER_TAG          Image version tag (default: from package.json)
`);
    process.exit(0);
  }
}

// Determine version
let dockerTag;

if (useLatest) {
  dockerTag = 'latest';
  console.log(`${colors.blue}Using 'latest' tag${colors.reset}`);
} else if (specifiedVersion) {
  dockerTag = specifiedVersion;
  console.log(`${colors.blue}Using specified version: ${dockerTag}${colors.reset}`);
} else {
  // Extract version from package.json
  console.log(`${colors.blue}Extracting version from package.json...${colors.reset}`);

  try {
    const version = execSync('node ' + path.join(scriptDir, 'get-version.js'), {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (!version) {
      throw new Error('No version returned');
    }

    dockerTag = process.env.DOCKER_TAG || version;
    console.log(`${colors.green}Version: ${dockerTag}${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}Failed to extract version from package.json${colors.reset}`);
    process.exit(1);
  }
}

console.log(`${colors.green}Registry: ${dockerRegistry}/${dockerOrganization}${colors.reset}`);
console.log('');

// Services to pull
const services = service ? [service] : ['gateway', 'admin', 'ollama', 'nginx'];

// Pull images
console.log(`${colors.blue}Pulling Docker images from ${dockerRegistry}...${colors.reset}`);
console.log('');

const failedServices = [];

for (const svc of services) {
  const imageName = `${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:${dockerTag}`;

  console.log(`${colors.yellow}Pulling ${imageName}...${colors.reset}`);

  try {
    execSync(`docker pull ${imageName}`, { stdio: 'inherit' });
    console.log(`${colors.green}✓ Pulled ${imageName}${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}✗ Failed to pull ${imageName}${colors.reset}`);
    failedServices.push(svc);
  }

  console.log('');
}

// Summary
console.log(`${colors.green}======================================${colors.reset}`);

if (failedServices.length === 0) {
  console.log(`${colors.green}All images pulled successfully!${colors.reset}`);
  console.log(`${colors.green}======================================${colors.reset}`);
  console.log('');
  console.log('Pulled images:');
  for (const svc of services) {
    console.log(`  - ${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:${dockerTag}`);
  }
  console.log('');
  console.log(`${colors.blue}Next steps:${colors.reset}`);
  console.log('  - Start services: cd docker && docker-compose up');
  console.log('  - Or use registry-only mode: docker-compose -f docker-compose.yml -f docker-compose.registry.yml up');
  process.exit(0);
} else {
  console.log(`${colors.red}Some images failed to pull${colors.reset}`);
  console.log(`${colors.red}======================================${colors.reset}`);
  console.log('');
  console.log('Failed services:');
  for (const svc of failedServices) {
    console.log(`  - ${svc}`);
  }
  console.log('');
  console.log(`${colors.yellow}Troubleshooting:${colors.reset}`);
  console.log('  1. Verify images exist in registry');
  console.log(`  2. Login to registry (if private):`);
  console.log(`     docker login ${dockerRegistry} -u username -p token`);
  console.log(`  3. Verify version tag: ${dockerTag}`);
  console.log('  4. Check network connectivity');
  process.exit(1);
}
