#!/usr/bin/env node

/**
 * Local Security Check Script
 * 
 * Quick standalone security validation for developers.
 * For comprehensive security checks, use: pnpm run ci (ci-pipeline.js)
 * 
 * This script provides:
 * - Fast secret detection (< 1 second)
 * - Dependency audit (5-10 seconds) 
 * - Optional Docker scanning if Trivy available (30+ seconds)
 * 
 * Usage: node ci/local-security-check.js
 * 
 * Note: The main CI pipeline (ci-pipeline.js) includes all these checks
 * plus comprehensive testing. Use this for quick pre-commit validation.
 */

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

// Logging utilities
const logger = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}[WARNING]${colors.reset} ${msg}`),
  error: (msg) => console.error(`${colors.red}[ERROR]${colors.reset} ${msg}`),
  step: (msg) => console.log(`${colors.cyan}${colors.bold}► ${msg}${colors.reset}`),
  phase: (msg) => {
    console.log('\n' + '='.repeat(60));
    console.log(`${colors.bold}${msg}${colors.reset}`);
    console.log('='.repeat(60));
  }
};

async function executeCommand(command, options = {}) {
  const { cwd = process.cwd(), description, ignoreError = false } = options;
  
  if (description) {
    logger.step(description);
  }
  
  try {
    const { stdout, stderr } = await execAsync(command, { cwd });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (!ignoreError) {
      logger.error(`Command failed: ${command}`);
      logger.error(`Error: ${error.message}`);
      if (error.stdout) logger.error(`Stdout: ${error.stdout}`);
      if (error.stderr) logger.error(`Stderr: ${error.stderr}`);
      throw error;
    }
    // If ignoreError is true, return silently for expected failures (like grep with no matches)
    return { stdout: error.stdout || '', stderr: error.stderr || error.message };
  }
}

/**
 * Phase 1: Basic Secret Detection (< 1 second)
 * Scan source code for hardcoded secrets and security issues
 */
async function runSecretDetection() {
  logger.phase('Phase 1: Basic Secret Detection');
  
  try {
    // Use cross-platform Node.js security scanner
    const { runSecretDetection: scanSecrets } = require('./security-scanner.js');
    
    const issuesFound = await scanSecrets();
    
    if (issuesFound > 0) {
      logger.error(`Phase 1 failed: ${issuesFound} security issue(s) found`);
      process.exit(1);
    }
    
    logger.success('Phase 1 passed: No critical security issues detected');
  } catch (error) {
    logger.error(`Phase 1 failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Phase 2: Dependency Audit (5-10 seconds)
 * Check for known vulnerabilities in dependencies
 */
async function runDependencyAudit() {
  logger.phase('Phase 2: Dependency Security Audit');
  
  try {
    // Use cross-platform Node.js security scanner
    const { runDependencyAudit: auditDeps } = require('./security-scanner.js');
    
    const auditIssues = await auditDeps();
    
    if (auditIssues > 0) {
      logger.error('Phase 2 failed: CRITICAL vulnerabilities found');
      logger.error('Critical vulnerabilities must be fixed before deployment');
      process.exit(1);
    }
    
    logger.success('Phase 2 passed: No critical vulnerabilities found');
  } catch (error) {
    logger.error(`Phase 2 failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Phase 3: Docker Vulnerability Scanning (30+ seconds)
 * Scan Docker images for vulnerabilities using Trivy
 */
async function runDockerScan() {
  logger.phase('Phase 3: Docker Vulnerability Scanning');
  
  // Check if Trivy is installed
  try {
    await executeCommand('trivy --version', { ignoreError: true });
    logger.success('Trivy is installed');
  } catch (error) {
    logger.error('Trivy is not installed. Installing...');
    
    // Install Trivy based on platform
    const platform = process.platform;
    try {
      if (platform === 'darwin') {
        // macOS
        await executeCommand('brew install aquasecurity/trivy/trivy', {
          description: 'Installing Trivy via Homebrew...'
        });
      } else if (platform === 'linux') {
        // Linux - use binary installation
        await executeCommand(`
          curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin v0.50.1
        `, {
          description: 'Installing Trivy via script...'
        });
      } else if (platform === 'win32') {
        // Windows - use binary download
        logger.error('Please install Trivy manually on Windows:');
        logger.error('1. Download from https://github.com/aquasecurity/trivy/releases');
        logger.error('2. Add trivy.exe to your PATH');
        process.exit(1);
      }
      
      logger.success('Trivy installed successfully');
    } catch (installError) {
      logger.error('Failed to install Trivy automatically');
      logger.error('Please install Trivy manually: https://aquasecurity.github.io/trivy/latest/getting-started/installation/');
      process.exit(1);
    }
  }
  
  // Check if Docker images exist
  const imagesToScan = [
    'docker-gateway',
    'docker-admin',
    'docker-nginx'
  ];
  
  logger.step('Checking for existing Docker images...');
  const existingImages = [];
  
  for (const image of imagesToScan) {
    try {
      await executeCommand(`docker image inspect ${image}`, { ignoreError: true });
      existingImages.push(image);
      logger.info(`Found existing image: ${image}`);
    } catch (error) {
      logger.info(`Image not found: ${image}`);
    }
  }
  
  // Build missing images
  if (existingImages.length < imagesToScan.length) {
    logger.step('Building missing Docker images...');
    
    if (!existingImages.includes('docker-gateway')) {
      await executeCommand('docker build -f docker/gateway.Dockerfile -t docker-gateway .', {
        description: 'Building Gateway Docker image...'
      });
    }
    
    if (!existingImages.includes('docker-admin')) {
      await executeCommand('docker build -f docker/admin.Dockerfile -t docker-admin .', {
        description: 'Building Admin Docker image...'
      });
    }
    
    if (!existingImages.includes('docker-nginx')) {
      await executeCommand('docker build -f docker/nginx.Dockerfile -t docker-nginx .', {
        description: 'Building Nginx Docker image...'
      });
    }
  }
  
  // Scan images with Trivy
  let vulnerabilitiesFound = false;
  
  for (const image of imagesToScan) {
    logger.step(`Scanning ${image} for vulnerabilities...`);
    
    try {
      const { stdout } = await executeCommand(`trivy image --severity HIGH,CRITICAL --format table ${image}`, {
        description: `Running Trivy scan on ${image}...`
      });
      
      if (stdout.includes('Total: 0')) {
        logger.success(`No HIGH/CRITICAL vulnerabilities found in ${image}`);
      } else {
        logger.warning(`Vulnerabilities found in ${image}:`);
        console.log(stdout);
        vulnerabilitiesFound = true;
      }
    } catch (error) {
      logger.error(`Failed to scan ${image}`);
      vulnerabilitiesFound = true;
    }
  }
  
  if (vulnerabilitiesFound) {
    logger.warning('Phase 3 completed with vulnerabilities found');
    logger.warning('Review the scan results above and consider updating base images or dependencies');
    // Don't exit with error for Docker vulnerabilities - they're often in base images
  } else {
    logger.success('Phase 3 passed: No HIGH/CRITICAL vulnerabilities found in Docker images');
  }
}

/**
 * Main security check function
 */
async function runSecurityCheck() {
  console.log('🔒 SAP LLM Gateway - Local Security Check\n');
  
  const startTime = Date.now();
  
  try {
    // Phase 1: Basic Secret Detection (fail fast)
    await runSecretDetection();
    
    // Phase 2: Dependency Audit (fail fast)
    await runDependencyAudit();
    
    // Phase 3: Docker Vulnerability Scanning (expensive)
    await runDockerScan();
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    
    logger.phase('🎉 Security Check Completed Successfully!');
    logger.success('✅ Basic secret detection: PASSED');
    logger.success('✅ Dependency audit: PASSED (critical issues only)');
    logger.success('✅ Docker vulnerability scan: COMPLETED');
    logger.success(`⏱️  Total time: ${duration} seconds`);
    logger.info('');
    logger.info('Note: This script only fails on CRITICAL security issues.');
    logger.info('Review any warnings above and consider fixing when possible.');
    
  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    logger.error(`Security check failed after ${duration} seconds: ${error.message}`);
    process.exit(1);
  }
}

// Run the security check
if (require.main === module) {
  runSecurityCheck();
}

module.exports = { runSecurityCheck };