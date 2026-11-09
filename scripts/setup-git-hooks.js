#!/usr/bin/env node

/**
 * Setup git hooks for the repository
 * Cross-platform (Windows, macOS, Linux)
 * Run this after cloning: node scripts/setup-git-hooks.js
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const hooksDir = path.join(repoRoot, '.git', 'hooks');

// Pre-commit hook content
// Uses Node.js for cross-platform compatibility (no grep/sed/awk)
const preCommitHook = `#!/bin/sh
#
# Pre-commit hook for cross-platform validation
# Uses Node.js for all file operations (works on Windows, macOS, Linux)
#
# Checks performed:
# 0. api_config.json synchronization across gateway, admin, and npm-dist
# 1. workspace:* protocol in npm-dist/sail-proxy/package.json
# 2. PostgreSQL credentials in docker configuration files
#

node cli-tools/pre-commit-checks.js
exit $?
`;

function main() {
  console.log('Setting up git hooks...\n');

  // Check if .git/hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    console.error('❌ Error: .git/hooks directory not found');
    console.error('   Are you in the repository root?');
    process.exit(1);
  }

  // Write pre-commit hook
  const preCommitPath = path.join(hooksDir, 'pre-commit');
  try {
    fs.writeFileSync(preCommitPath, preCommitHook, { mode: 0o755 });
    console.log('✅ Installed pre-commit hook');
  } catch (error) {
    console.error(`❌ Failed to install pre-commit hook: ${error.message}`);
    process.exit(1);
  }

  console.log('\n✅ Git hooks installed successfully!\n');
  console.log('Installed hooks:');
  console.log('  - pre-commit: Cross-platform validation checks');
  console.log('\nThe hook will:');
  console.log('  • Run automatically before each commit');
  console.log('  • Auto-sync api_config.json files (gateway → admin & npm-dist)');
  console.log('  • Check workspace:* protocol in npm-dist/sail-proxy/package.json');
  console.log('  • Auto-fix PostgreSQL credentials to safe defaults in docker configs');
  console.log('  • Works on Windows, macOS, and Linux');
}

if (require.main === module) {
  main();
}
