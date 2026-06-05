#!/usr/bin/env node

/**
 * Cross-platform pre-commit checks
 *
 * This script runs all validation checks before a commit is allowed.
 * It uses pure Node.js (no grep/sed/awk) for cross-platform compatibility.
 *
 * Checks performed:
 * 0. api_config.json synchronization across gateway, admin, and npm-dist
 * 1. workspace:* protocol validation in npm-dist/sail-proxy/package.json
 * 2. PostgreSQL credentials validation in docker configuration files
 *
 * Usage: Automatically run by git pre-commit hook
 * Exit code: 0 if all checks pass, 1 if any check fails
 */

const { execSync } = require('child_process');
const path = require('path');

/**
 * Get list of files that are staged for commit
 * @returns {string[]} - Array of staged file paths
 */
function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim().split('\n').filter(Boolean);
  } catch (error) {
    // If git command fails, assume no staged files
    return [];
  }
}

function main() {
  const stagedFiles = getStagedFiles();

  if (stagedFiles.length === 0) {
    // No files staged, nothing to check
    process.exit(0);
  }

  // Check 0: api_config.json synchronization
  const apiConfigFiles = [
    'services/gateway/api_config.json',
    'services/admin/api_config.json',
    'npm-dist/sail-proxy/src/templates/api_config.template.json'
  ];

  if (stagedFiles.some(file => apiConfigFiles.includes(file))) {
    console.log('🔍 Synchronizing api_config.json files...');
    const syncApiConfig = require('./sync-api-config.js');
    try {
      syncApiConfig.main();
      console.log('✅ api_config.json files synchronized');
    } catch (error) {
      // sync-api-config.js will have already printed error messages
      process.exit(1);
    }
  }

  // Check 1: workspace:* protocol
  if (stagedFiles.includes('npm-dist/sail-proxy/package.json')) {
    console.log('🔍 Checking workspace:* protocol...');
    const checkWorkspace = require('./check-workspace-protocol.js');
    try {
      checkWorkspace.main();
      console.log('✅ workspace:* protocol verified');
    } catch (error) {
      // check-workspace-protocol.js will have already printed error messages
      process.exit(1);
    }
  }

  // Check 2: PostgreSQL credentials
  const dockerFiles = stagedFiles.filter(file =>
    file === 'docker/docker-compose.yml' ||
    (file.includes('docker/configs/') && file.includes('dex.config') && file.endsWith('.yaml'))
  );

  if (dockerFiles.length > 0) {
    console.log('🔍 Checking PostgreSQL credentials...');
    const checkPostgres = require('./check-postgres-credentials.js');
    checkPostgres.main();
    console.log('✅ PostgreSQL credentials verified');
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { main };
