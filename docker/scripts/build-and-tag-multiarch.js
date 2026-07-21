#!/usr/bin/env node

/**
 * Multi-Architecture Docker Build Script for SAP LLM Gateway
 * 
 * This script builds and pushes multi-platform Docker images for all services
 * supporting both linux/amd64 and linux/arm64 architectures.
 *
 * Features:
 * - Interactive builder setup and validation
 * - Platform support verification 
 * - QEMU setup guidance for cross-compilation
 * - Same tag structure as single-arch builds
 * 
 * Usage:
 *   node docker/scripts/build-and-tag-multiarch.js [--no-cache] [--service SERVICE_NAME]
 *   pnpm docker:buildx [-- --service gateway]
 *
 * Prerequisites:
 *   - Docker with BuildKit support
 *   - QEMU binaries for cross-compilation (installed automatically on most systems)
 *   - Registry authentication (for --push)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// === Configuration ===========================================================

const scriptDir = __dirname;
const dockerDir = path.join(scriptDir, '..');
const projectRoot = path.join(dockerDir, '..');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

// === Utility Functions =======================================================

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function run(cmd, opts = {}) {
  if (opts.silent !== true) {
    log(`$ ${cmd}`, colors.cyan);
  }
  return execSync(cmd, { 
    encoding: 'utf8', 
    stdio: opts.silent ? 'pipe' : 'inherit',
    ...opts 
  });
}

function askUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}

// === Configuration Reading ===================================================

function getProjectConfig() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    
    return {
      version: pkg.version,
      dockerRegistry: process.env.DOCKER_REGISTRY || 'ghcr.io',
      dockerOrganization: process.env.DOCKER_ORGANIZATION || 'st-gr',
      dockerTag: process.env.DOCKER_TAG || pkg.version,
      platforms: process.env.DOCKER_PLATFORMS || 'linux/amd64,linux/arm64'
    };
  } catch (error) {
    log('❌ Failed to read project configuration from package.json', colors.red);
    log(`Error: ${error.message}`, colors.red);
    process.exit(1);
  }
}

// === Registry Authentication =================================================

// Registry authentication is now handled during the actual push phase
// No pre-authentication testing needed

function showLoginInstructions(registry) {
  log('', colors.reset);
  log('🔑 Registry Login Required:', colors.yellow);
  log(`   You need to authenticate with ${registry} before pushing multi-arch images.`, colors.yellow);
  log('', colors.reset);
  log('📋 Login Instructions:', colors.cyan);
  
  if (registry.includes('ghcr.io')) {
    log('   For GitHub Container Registry (ghcr.io):', colors.cyan);
    log('   1. Create a Personal Access Token with "write:packages" permission:', colors.cyan);
    log('      https://github.com/settings/tokens', colors.cyan);
    log('   2. Login to the registry:', colors.cyan);
    log(`      echo $GITHUB_TOKEN | docker login ${registry} -u YOUR_GITHUB_USERNAME --password-stdin`, colors.bold);
    log('   3. Alternative with explicit token:', colors.cyan);
    log(`      docker login ${registry} -u YOUR_USERNAME -p YOUR_TOKEN`, colors.bold);
  } else if (registry.includes('docker.io')) {
    log('   For Docker Hub:', colors.cyan);
    log(`      docker login ${registry}`, colors.bold);
  } else {
    log(`   For ${registry}:`, colors.cyan);
    log(`      docker login ${registry}`, colors.bold);
  }
  
  log('', colors.reset);
  log('   After logging in, run the build command again.', colors.yellow);
}

// === Builder Management ======================================================

function checkBuilderExists() {
  try {
    const output = run('docker buildx inspect sail-proxy-builder 2>/dev/null || echo "NOTFOUND"', { silent: true });
    return !output.includes('NOTFOUND') && !output.includes('no builder');
  } catch (error) {
    return false;
  }
}

// buildkitd config with a bounded GC policy (20 GB cap). Without it, BuildKit
// defaults to a disk-proportional cap (~73 GiB here) and the cache once grew
// to 67 GB unnoticed. Applied at builder creation only — see docker/buildkitd.toml.
const buildkitdConfigPath = path.join(dockerDir, 'buildkitd.toml');

function builderCreateCommand() {
  const configFlag = fs.existsSync(buildkitdConfigPath)
    ? ` --buildkitd-config "${buildkitdConfigPath}"`
    : '';
  return `docker buildx create --name sail-proxy-builder --driver docker-container${configFlag} --use --bootstrap`;
}

async function createBuilder() {
  const answer = await askUser(`${colors.yellow}Docker builder 'sail-proxy-builder' not found. Create it? (y/n): ${colors.reset}`);

  if (answer !== 'y' && answer !== 'yes') {
    log('❌ Multi-arch builds require a buildx builder. Exiting.', colors.red);
    process.exit(1);
  }

  log('🔧 Creating multi-arch Docker builder (with bounded cache GC policy)...', colors.blue);

  try {
    run(builderCreateCommand());
    log('✅ Builder created successfully', colors.green);
  } catch (error) {
    log('❌ Failed to create builder', colors.red);
    log('This may happen if Docker Desktop is not running or BuildKit is not available.', colors.yellow);
    process.exit(1);
  }
}

// === Cache Guardrail =========================================================
// Belt & suspenders against unbounded cache growth:
//  - warn loudly if the builder is running WITHOUT the bounded GC policy
//    (e.g. created before buildkitd.toml existed), and
//  - if the cache has grown past the hard threshold anyway, prune it down
//    before building. GC policy "should" prevent that, but a silent 67 GB
//    accumulation already happened once — never trust, always verify.
const CACHE_WARN_GB = 25;   // prune trigger (> GC cap of 20 GB = GC not working)
const CACHE_PRUNE_TARGET = '20GB';

function parseSizeToGB(sizeStr) {
  // docker buildx du prints sizes like "67.62GB", "488.3MB", "1.234kB", "0B"
  const m = String(sizeStr).trim().match(/^([\d.]+)\s*(B|kB|KB|MB|GB|TB)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const factor = { B: 1e-9, KB: 1e-6, MB: 1e-3, GB: 1, TB: 1e3 }[unit];
  return factor === undefined ? null : n * factor;
}

function enforceCacheBounds() {
  // 1. Detect a builder still running BuildKit's oversized default GC policy.
  try {
    const inspect = run('docker buildx inspect sail-proxy-builder', { silent: true });
    const caps = [...inspect.matchAll(/Max Used Space:\s*([\d.]+\s*[A-Za-z]+)/g)]
      .map((m) => parseSizeToGB(m[1].replace(/\s+/g, '').replace(/GiB/i, 'GB').replace(/MiB/i, 'MB')))
      .filter((v) => v !== null);
    if (caps.length === 0 || caps.some((gb) => gb > 30)) {
      log('⚠️  Builder "sail-proxy-builder" is NOT using the bounded cache GC policy', colors.yellow);
      log('   Its cache can silently grow to ~70+ GB. Recreate it with:', colors.yellow);
      log('     docker buildx rm sail-proxy-builder', colors.bold);
      log(`     ${builderCreateCommand()}`, colors.bold);
    }
  } catch (error) {
    log(`⚠️  Could not inspect builder GC policy: ${error.message}`, colors.yellow);
  }

  // 2. Hard threshold check: prune if the cache outgrew the GC cap anyway.
  try {
    const du = run('docker buildx du --builder sail-proxy-builder 2>/dev/null | tail -2', { silent: true });
    const totalMatch = du.match(/Total:\s*([\d.]+\s*[A-Za-z]+)/);
    if (!totalMatch) return;
    const totalGB = parseSizeToGB(totalMatch[1].replace(/\s+/g, ''));
    if (totalGB === null) return;
    log(`📦 Builder cache size: ${totalMatch[1].trim()}`, colors.cyan);
    if (totalGB > CACHE_WARN_GB) {
      log(`🚨 Builder cache is ${totalMatch[1].trim()} (> ${CACHE_WARN_GB} GB) — GC policy is not holding.`, colors.red);
      log(`   Pruning down to ${CACHE_PRUNE_TARGET} before building...`, colors.yellow);
      run(`docker buildx prune --builder sail-proxy-builder --max-used-space ${CACHE_PRUNE_TARGET} --force`);
      log('✅ Cache pruned', colors.green);
    }
  } catch (error) {
    log(`⚠️  Cache size check failed (continuing): ${error.message}`, colors.yellow);
  }
}

function validateBuilderPlatforms() {
  try {
    log('🔍 Validating builder platform support...', colors.blue);
    const output = run('docker buildx inspect sail-proxy-builder', { silent: true });
    
    // Extract platforms line
    const platformsMatch = output.match(/Platforms:\s*(.+)/m);
    if (!platformsMatch) {
      log('❌ Could not determine builder platforms', colors.red);
      log('Builder inspect output:', colors.yellow);
      log(output, colors.yellow);
      process.exit(1);
    }
    
    const platforms = platformsMatch[1].trim();
    log(`📋 Available platforms: ${platforms}`, colors.cyan);
    
    const hasAmd64 = platforms.includes('linux/amd64');
    const hasArm64 = platforms.includes('linux/arm64');
    
    if (!hasAmd64) {
      log('❌ Builder does not support linux/amd64', colors.red);
      process.exit(1);
    }
    
    if (!hasArm64) {
      log('⚠️  Builder does not support linux/arm64', colors.yellow);
      log('', colors.reset);
      log('To enable ARM64 cross-compilation, run:', colors.yellow);
      log('  sudo docker run --privileged --rm tonistiigi/binfmt --install arm64,arm', colors.bold);
      log('', colors.reset);
      log('Then restart the builder:', colors.yellow);
      log('  docker buildx rm sail-proxy-builder', colors.bold);
      log(`  ${builderCreateCommand()}`, colors.bold);
      log('', colors.reset);
      process.exit(1);
    }
    
    log('✅ Builder supports both linux/amd64 and linux/arm64', colors.green);
    return true;
    
  } catch (error) {
    log('❌ Failed to validate builder platforms', colors.red);
    log(`Error: ${error.message}`, colors.red);
    process.exit(1);
  }
}

// === Service Configuration ===================================================

function getServiceConfig() {
  // Map service names to their build contexts and Dockerfiles
  // Based on the docker-compose.yml configuration
  return {
    gateway: {
      context: projectRoot,  // docker-compose uses context: ..
      dockerfile: path.join(dockerDir, 'gateway.Dockerfile')
    },
    admin: {
      context: projectRoot,  // docker-compose uses context: ..
      dockerfile: path.join(dockerDir, 'admin.Dockerfile')  
    },
    ollama: {
      context: projectRoot,  // docker-compose uses context: ..
      dockerfile: path.join(dockerDir, 'ollama.Dockerfile')
    },
    nginx: {
      context: dockerDir,    // docker-compose uses context: .
      dockerfile: path.join(dockerDir, 'nginx', 'Dockerfile')
    }
  };
}

// === Build Functions =========================================================

function buildService(serviceName, config, projectConfig, noCache = false, buildOnly = false) {
  const serviceConfig = config[serviceName];
  if (!serviceConfig) {
    log(`❌ Unknown service: ${serviceName}`, colors.red);
    process.exit(1);
  }
  
  const imageBase = `${projectConfig.dockerRegistry}/${projectConfig.dockerOrganization}/sail-proxy-${serviceName}`;
  const versionTag = `${imageBase}:${projectConfig.dockerTag}`;
  const latestTag = `${imageBase}:latest`;
  
  log(`🏗️  Building ${serviceName} for ${projectConfig.platforms}`, colors.blue);
  log(`   Image: ${versionTag}`, colors.cyan);
  log(`   Context: ${serviceConfig.context}`, colors.cyan);
  log(`   Dockerfile: ${serviceConfig.dockerfile}`, colors.cyan);
  
  const buildArgs = [
    'docker', 'buildx', 'build',
    '--builder', 'sail-proxy-builder',
    '--platform', projectConfig.platforms,
    '-f', serviceConfig.dockerfile,
    '-t', versionTag,
    '-t', latestTag
  ];
  
  if (noCache) {
    buildArgs.push('--no-cache');
  }
  
  if (buildOnly) {
    // Build only mode - don't push
    buildArgs.push('--load'); // This only works for single platform builds
    log(`   Mode: Build only (no push)`, colors.yellow);
  } else {
    // Default mode - build and push (required for multi-arch)
    buildArgs.push('--push');
    log(`   Mode: Build and push to registry`, colors.cyan);
  }
  
  buildArgs.push(serviceConfig.context);
  
  try {
    run(buildArgs.join(' '));
    
    if (buildOnly) {
      log(`✅ ${serviceName} built successfully (local only)`, colors.green);
    } else {
      log(`✅ ${serviceName} built and pushed successfully`, colors.green);
    }
    return { success: true, pushed: !buildOnly };
  } catch (error) {
    // Check if this was a push authentication error
    const errorOutput = error.message || '';
    
    if (!buildOnly && (errorOutput.includes('denied') || errorOutput.includes('unauthorized') || 
        errorOutput.includes('authentication required') || errorOutput.includes('create_package'))) {
      
      log(`❌ ${serviceName} build succeeded but push failed - authentication required`, colors.red);
      log('', colors.reset);
      
      // Provide specific guidance based on error
      if (errorOutput.includes('create_package')) {
        log('💡 GitHub Container Registry: Missing "write:packages" permission', colors.yellow);
      } else if (errorOutput.includes('denied') || errorOutput.includes('unauthorized')) {
        log('💡 Registry Access: Authentication or permission denied', colors.yellow);
      }
      
      log('', colors.reset);
      log('🔧 Solutions:', colors.cyan);
      log('   1. Login and retry:', colors.cyan);
      showLoginInstructions(projectConfig.dockerRegistry);
      log('', colors.reset);
      log('   2. Or build without pushing:', colors.cyan);
      log(`      pnpm docker:buildx -- --build-only`, colors.bold);
      log('', colors.reset);
      log('   3. Or manually push after login:', colors.cyan);
      log(`      docker buildx build --builder sail-proxy-builder --platform ${projectConfig.platforms} -f ${serviceConfig.dockerfile} -t ${versionTag} -t ${latestTag} --push ${serviceConfig.context}`, colors.bold);
      
      return { success: false, pushed: false, authError: true };
    } else {
      log(`❌ Failed to build ${serviceName}`, colors.red);
      return { success: false, pushed: false, authError: false };
    }
  }
}

// === Main Function ===========================================================

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let noCache = false;
  let targetService = null;
  let buildOnly = false;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-cache') {
      noCache = true;
    } else if (args[i] === '--build-only') {
      buildOnly = true;
    } else if (args[i] === '--service' && args[i + 1]) {
      targetService = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Multi-Architecture Docker Build Script

Usage:
  node docker/scripts/build-and-tag-multiarch.js [options]

Options:
  --no-cache       Build without using cache
  --build-only     Build images locally without pushing to registry
  --service NAME   Build only specific service (gateway, admin, ollama, nginx)
  --help, -h       Show this help message

Environment Variables:
  DOCKER_REGISTRY      Container registry (default: ghcr.io)
  DOCKER_ORGANIZATION  Registry organization (default: st-gr)  
  DOCKER_TAG          Image version tag (default: from package.json)
  DOCKER_PLATFORMS    Target platforms (default: linux/amd64,linux/arm64)

Examples:
  pnpm docker:buildx                          # Build and push all services
  pnpm docker:buildx -- --build-only         # Build locally without pushing
  pnpm docker:buildx -- --service gateway    # Build and push gateway only
  pnpm docker:buildx -- --no-cache           # Force rebuild without cache
  DOCKER_TAG=0.9.0 pnpm docker:buildx       # Use specific version tag
`);
      process.exit(0);
    }
  }
  
  // Load configuration
  const projectConfig = getProjectConfig();
  const serviceConfig = getServiceConfig();
  const allServices = Object.keys(serviceConfig);
  const services = targetService ? [targetService] : allServices;
  
  // Validate target service
  if (targetService && !allServices.includes(targetService)) {
    log(`❌ Unknown service: ${targetService}`, colors.red);
    log(`Available services: ${allServices.join(', ')}`, colors.yellow);
    process.exit(1);
  }
  
  // Display configuration
  log(`${colors.bold}SAP LLM Gateway - Multi-Architecture Build${colors.reset}`);
  log('================================================');
  log(`Registry:  ${projectConfig.dockerRegistry}/${projectConfig.dockerOrganization}`, colors.cyan);
  log(`Tag:       ${projectConfig.dockerTag}`, colors.cyan);
  log(`Platforms: ${projectConfig.platforms}`, colors.cyan);
  log(`Services:  ${services.join(', ')}`, colors.cyan);
  log(`No Cache:  ${noCache}`, colors.cyan);
  log(`Build Mode: ${buildOnly ? 'Local only (no push)' : 'Build and push'}`, colors.cyan);
  log('');
  
  // Handle build-only mode limitations
  if (buildOnly && projectConfig.platforms.includes(',')) {
    log('⚠️  Warning: --build-only with multi-platform builds', colors.yellow);
    log('   Multi-platform builds cannot be loaded locally', colors.yellow);
    log('   Switching to single platform build for local development', colors.yellow);
    projectConfig.platforms = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    log(`   Platform: ${projectConfig.platforms}`, colors.cyan);
    log('');
  }
  
  // Step 1: Ensure builder exists
  if (!checkBuilderExists()) {
    await createBuilder();
  } else {
    log('✅ Builder "sail-proxy-builder" exists', colors.green);
  }
  
  // Step 2: Switch to the builder and validate platforms
  run('docker buildx use sail-proxy-builder');
  validateBuilderPlatforms();

  // Step 2b: Cache guardrail — warn if GC policy is unbounded, prune if oversized
  enforceCacheBounds();

  // Step 3: No registry authentication check - handled during push
  if (!buildOnly) {
    log('');
    log('💡 Registry authentication will be verified during push', colors.yellow);
    log('   If push fails, use --build-only flag or login first', colors.yellow);
  }
  
  // Step 4: Build services
  log('');
  log('🚀 Starting multi-architecture builds...', colors.blue);
  log('');
  
  // Build time warning
  log('⏱️  Build Time Estimate:', colors.yellow);
  log('   Multi-architecture builds can take significant time:', colors.yellow);
  log('   • Linux VM: ~2.5+ hours (cross-compilation overhead)', colors.yellow);
  log('   • Apple Silicon: ~45-90 minutes (native ARM64 + emulation)', colors.yellow);
  log('   • Intel/AMD64: ~60-120 minutes (native AMD64 + emulation)', colors.yellow);
  log('   • Single service: ~15-30 minutes per service', colors.yellow);
  log('', colors.reset);
  log('💡 Tips to reduce build time:', colors.cyan);
  log('   • Use --service NAME to build only specific services', colors.cyan);
  log('   • Consider --build-only for local development', colors.cyan);
  log('   • Docker layer caching helps on subsequent builds', colors.cyan);
  log('');
  
  const results = [];
  for (const service of services) {
    const result = buildService(service, serviceConfig, projectConfig, noCache, buildOnly);
    results.push({ service, ...result });
    log(''); // Add spacing between services
    
    // If we hit an auth error, stop and provide guidance
    if (result.authError) {
      log('🛑 Build stopped due to authentication error', colors.red);
      log('   Please resolve authentication and retry', colors.yellow);
      process.exit(1);
    }
  }
  
  // Step 5: Summary
  log('===============================================', colors.bold);
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  if (failed.length === 0) {
    log(`✅ All ${successful.length} services built successfully!`, colors.green);
    log('');
    log('Built images:', colors.cyan);
    for (const service of services) {
      const imageBase = `${projectConfig.dockerRegistry}/${projectConfig.dockerOrganization}/sail-proxy-${service}`;
      log(`  - ${imageBase}:${projectConfig.dockerTag}`, colors.cyan);
      log(`  - ${imageBase}:latest`, colors.cyan);
    }
    log('');
    log('🎯 Images are now available for both AMD64 and ARM64 architectures', colors.green);
    log('   Docker will automatically select the correct architecture when pulling', colors.green);
    log('');
    log('Next steps:', colors.yellow);
    log('  - Use registry mode: docker-compose -f docker-compose.yml -f docker-compose.registry.yml up', colors.cyan);
    log('  - Or update .env.docker with new tag and run: docker-compose pull && docker-compose up', colors.cyan);
    
  } else {
    log(`❌ ${failed.length} services failed to build`, colors.red);
    log('');
    log('Failed services:', colors.red);
    failed.forEach(r => log(`  - ${r.service}`, colors.red));
    
    if (successful.length > 0) {
      log('');
      log('Successful services:', colors.green);
      successful.forEach(r => log(`  - ${r.service}`, colors.green));
    }
    
    process.exit(1);
  }
}

// === Entry Point =============================================================

if (require.main === module) {
  main().catch(error => {
    log(`❌ Unexpected error: ${error.message}`, colors.red);
    process.exit(1);
  });
}

module.exports = { main, getProjectConfig, checkBuilderExists };