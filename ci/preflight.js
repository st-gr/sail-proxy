#!/usr/bin/env node

/**
 * CI Pipeline Pre-flight Check
 * 
 * This script runs before the main CI pipeline to ensure all prerequisites are met.
 * It only uses Node.js built-in modules to avoid dependency issues.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Simple logging without external dependencies
const log = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  warning: (msg) => console.log(`⚠️  ${msg}`)
};

/**
 * Check if we're in the right directory
 */
function checkWorkingDirectory() {
  log.info('Checking working directory...');
  
  const requiredFiles = ['package.json', 'pnpm-workspace.yaml', 'ci/ci-pipeline.js'];
  const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));
  
  if (missingFiles.length > 0) {
    log.error(`Missing required files: ${missingFiles.join(', ')}`);
    log.error('Please run this command from the project root directory');
    process.exit(1);
  }
  
  log.success('Working directory is correct');
}

/**
 * Check Node.js version
 */
function checkNodeVersion() {
  log.info('Checking Node.js version...');
  
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.substring(1).split('.')[0]);
  
  if (majorVersion < 18) {
    log.error(`Node.js ${majorVersion} is not supported. Please use Node.js 18 or higher.`);
    process.exit(1);
  }
  
  log.success(`Node.js ${nodeVersion} is compatible`);
}

/**
 * Check if pnpm is available
 */
function checkPnpm() {
  log.info('Checking pnpm availability...');
  
  try {
    const pnpmVersion = execSync('pnpm --version', { encoding: 'utf8' }).trim();
    log.success(`pnpm ${pnpmVersion} is available`);
  } catch (error) {
    log.error('pnpm is not installed or not in PATH');
    log.error('Please install pnpm: npm install -g pnpm');
    process.exit(1);
  }
}

/**
 * Check Docker availability
 */
function checkDocker() {
  log.info('Checking Docker availability...');
  
  try {
    execSync('docker --version', { stdio: 'pipe' });
    log.success('Docker is available');
  } catch (error) {
    log.warning('Docker is not available - some CI steps may fail');
    log.warning('Please install Docker for full CI pipeline functionality');
  }
}

/**
 * Check if dependencies need to be installed
 */
function checkDependencies() {
  log.info('Checking dependencies...');
  
  try {
    require.resolve('axios');
    log.success('Dependencies are already installed');
    return false; // No need to install
  } catch (error) {
    log.info('Dependencies need to be installed');
    return true; // Need to install
  }
}

/**
 * Install dependencies
 */
function installDependencies() {
  log.info('Installing dependencies...');
  
  try {
    execSync('pnpm install --frozen-lockfile', { stdio: 'inherit' });
    log.success('Dependencies installed successfully');
  } catch (error) {
    log.error('Failed to install dependencies');
    log.error(error.message);
    process.exit(1);
  }
}

/**
 * Validate environment variables
 */
function validateEnvironment() {
  log.info('Validating environment...');
  
  // Check SAP_AI_CORE_SERVICE_KEY
  const serviceKey = process.env.SAP_AI_CORE_SERVICE_KEY;
  if (!serviceKey) {
    log.error('SAP_AI_CORE_SERVICE_KEY environment variable is required');
    log.error('Please set it to valid SAP AI Core service credentials (JSON format)');
    process.exit(1);
  }
  
  try {
    const parsed = JSON.parse(serviceKey);
    const requiredFields = ['clientid', 'clientsecret', 'url', 'identityzone', 'identityzoneid'];
    const missing = requiredFields.filter(field => !parsed[field]);
    
    if (missing.length > 0) {
      log.error(`SAP_AI_CORE_SERVICE_KEY is missing required fields: ${missing.join(', ')}`);
      process.exit(1);
    }
    
    // Security check
    if (parsed.clientid === 'test-client' || parsed.clientsecret === 'test-secret') {
      log.error('SAP_AI_CORE_SERVICE_KEY contains sample/default values');
      log.error('Real SAP AI Core credentials are required');
      process.exit(1);
    }
    
    log.success('SAP_AI_CORE_SERVICE_KEY is valid');
  } catch (error) {
    log.error('SAP_AI_CORE_SERVICE_KEY is not valid JSON');
    process.exit(1);
  }
}

/**
 * Main pre-flight check
 */
function main() {
  console.log('🚀 SAP LLM Gateway CI Pre-flight Check\n');
  
  checkWorkingDirectory();
  checkNodeVersion();
  checkPnpm();
  checkDocker();
  
  const needsInstall = checkDependencies();
  if (needsInstall) {
    installDependencies();
  }
  
  validateEnvironment();
  
  log.success('🎉 Pre-flight checks completed successfully!');
  log.info('Starting main CI pipeline...\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    log.error(`Pre-flight check failed: ${error.message}`);
    process.exit(1);
  }
}