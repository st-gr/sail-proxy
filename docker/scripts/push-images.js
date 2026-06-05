#!/usr/bin/env node

/**
 * Push Docker images to container registry
 *
 * This script:
 *   1. Extracts the version from package.json
 *   2. Pushes images with version tag
 *   3. Pushes images with 'latest' tag
 *
 * Usage:
 *   node docker/scripts/push-images.js [--service SERVICE_NAME] [--tag-only]
 *
 * Options:
 *   --service NAME   Push only specific service (gateway, admin, ollama, nginx)
 *   --tag-only       Only push version tag (skip 'latest' tag)
 *
 * Prerequisites:
 *   - Images must be built first (run build-and-tag.js)
 *   - Docker login to registry before pushing
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
let tagOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--service' && args[i + 1]) {
    service = args[i + 1];
    i++;
  } else if (args[i] === '--tag-only') {
    tagOnly = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Push Docker images to container registry

Usage:
  node docker/scripts/push-images.js [--service SERVICE_NAME] [--tag-only]

Options:
  --service NAME   Push only specific service (gateway, admin, ollama, nginx)
  --tag-only       Only push version tag (skip 'latest' tag)
  --help, -h       Show this help message

Prerequisites:
  - Images must be built first (run build-and-tag.js)
  - Docker login to registry before pushing

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

// Check if Docker is running
console.log(`${colors.blue}Checking Docker daemon...${colors.reset}`);
try {
  execSync('docker info', { stdio: 'ignore' });
} catch (error) {
  console.error(`${colors.red}Docker daemon is not running${colors.reset}`);
  process.exit(1);
}

// Services to push
const services = service ? [service] : ['gateway', 'admin', 'ollama', 'nginx'];

// Push images
console.log(`${colors.blue}Pushing Docker images to ${dockerRegistry}...${colors.reset}`);
console.log('');

const failedServices = [];

for (const svc of services) {
  console.log(`${colors.yellow}Pushing sail-proxy-${svc}...${colors.reset}`);

  const imageName = `${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:${dockerTag}`;
  const latestImage = `${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:latest`;

  // Check if image exists
  try {
    execSync(`docker image inspect ${imageName}`, { stdio: 'ignore' });
  } catch (error) {
    console.error(`${colors.red}✗ Image not found: ${imageName}${colors.reset}`);
    console.log(`${colors.yellow}  Run build-and-tag.js first to build the image${colors.reset}`);
    failedServices.push(svc);
    continue;
  }

  // Push version tag
  console.log(`${colors.blue}  Pushing ${dockerTag} tag...${colors.reset}`);
  try {
    execSync(`docker push ${imageName}`, { stdio: 'inherit' });
    console.log(`${colors.green}  ✓ Pushed ${imageName}${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}  ✗ Failed to push ${imageName}${colors.reset}`);
    failedServices.push(svc);
    continue;
  }

  // Push latest tag (unless --tag-only)
  if (!tagOnly) {
    console.log(`${colors.blue}  Pushing latest tag...${colors.reset}`);
    try {
      execSync(`docker push ${latestImage}`, { stdio: 'inherit' });
      console.log(`${colors.green}  ✓ Pushed ${latestImage}${colors.reset}`);
    } catch (error) {
      console.log(`${colors.yellow}  ⚠ Warning: Failed to push latest tag${colors.reset}`);
    }
  }

  console.log('');
}

// Summary
console.log(`${colors.green}======================================${colors.reset}`);

if (failedServices.length === 0) {
  console.log(`${colors.green}All images pushed successfully!${colors.reset}`);
  console.log(`${colors.green}======================================${colors.reset}`);
  console.log('');
  console.log('Pushed images:');
  for (const svc of services) {
    console.log(`  - ${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:${dockerTag}`);
    if (!tagOnly) {
      console.log(`  - ${dockerRegistry}/${dockerOrganization}/sail-proxy-${svc}:latest`);
    }
  }
  console.log('');
  console.log(`${colors.blue}Next steps:${colors.reset}`);
  console.log(`  - Pull images: docker pull ${dockerRegistry}/${dockerOrganization}/sail-proxy-gateway:${dockerTag}`);
  console.log('  - Deploy to Kyma: cd kyma && node scripts/setup-kyma.js');
  process.exit(0);
} else {
  console.log(`${colors.red}Some images failed to push${colors.reset}`);
  console.log(`${colors.red}======================================${colors.reset}`);
  console.log('');
  console.log('Failed services:');
  for (const svc of failedServices) {
    console.log(`  - ${svc}`);
  }
  console.log('');
  console.log(`${colors.yellow}Troubleshooting:${colors.reset}`);
  console.log(`  1. Login to registry first:`);
  console.log(`     docker login ${dockerRegistry} -u username -p token`);
  console.log('  2. Check image exists: docker images | grep sail-proxy');
  console.log(`  3. Verify registry permissions for ${dockerOrganization}`);
  process.exit(1);
}
