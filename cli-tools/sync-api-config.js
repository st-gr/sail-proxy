#!/usr/bin/env node

/**
 * Synchronize api_config.json files across the project
 *
 * This script ensures that three api_config.json files remain identical:
 * 1. services/gateway/api_config.json (SOURCE OF TRUTH)
 * 2. services/admin/api_config.json
 * 3. npm-dist/sail-proxy/src/templates/api_config.template.json
 *
 * Usage: Automatically run by git pre-commit hook when any of these files are staged
 * Exit code: 0 if sync successful, 1 if any error occurs
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Define the three files that must remain in sync
const SOURCE_FILE = 'services/gateway/api_config.json';
const TARGET_FILES = [
  'services/admin/api_config.json',
  'npm-dist/sail-proxy/src/templates/api_config.template.json'
];

const ALL_FILES = [SOURCE_FILE, ...TARGET_FILES];

/**
 * Get the repository root directory
 * @returns {string} - Absolute path to repository root
 */
function getRepoRoot() {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return root;
  } catch (error) {
    console.error('❌ Error: Not in a git repository');
    process.exit(1);
  }
}

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
    return [];
  }
}

/**
 * Check if any api_config files are staged
 * @param {string[]} stagedFiles - Array of staged file paths
 * @returns {boolean} - True if any api_config files are staged
 */
function hasApiConfigStaged(stagedFiles) {
  return stagedFiles.some(file => ALL_FILES.includes(file));
}

/**
 * Sync api_config files from source to targets
 */
function syncApiConfigFiles() {
  const repoRoot = getRepoRoot();
  const sourcePath = path.join(repoRoot, SOURCE_FILE);

  // Verify source file exists
  if (!fs.existsSync(sourcePath)) {
    console.error(`❌ Error: Source file not found: ${SOURCE_FILE}`);
    process.exit(1);
  }

  // Read source file
  let sourceContent;
  try {
    sourceContent = fs.readFileSync(sourcePath, 'utf8');
  } catch (error) {
    console.error(`❌ Error reading source file ${SOURCE_FILE}: ${error.message}`);
    process.exit(1);
  }

  // Sync to each target file
  let syncedFiles = [];
  for (const targetFile of TARGET_FILES) {
    const targetPath = path.join(repoRoot, targetFile);

    try {
      // Create directory if it doesn't exist
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Write content to target file
      fs.writeFileSync(targetPath, sourceContent, 'utf8');
      syncedFiles.push(targetFile);

      console.log(`  ✓ Synced: ${targetFile}`);
    } catch (error) {
      console.error(`❌ Error writing to ${targetFile}: ${error.message}`);
      process.exit(1);
    }
  }

  // Stage the synced files
  if (syncedFiles.length > 0) {
    try {
      for (const file of syncedFiles) {
        execSync(`git add "${file}"`, {
          cwd: repoRoot,
          stdio: 'ignore'
        });
      }
      console.log(`  ✓ Staged ${syncedFiles.length} synced file(s)`);
    } catch (error) {
      console.error('❌ Error staging synced files:', error.message);
      process.exit(1);
    }
  }
}

function main() {
  const stagedFiles = getStagedFiles();

  if (!hasApiConfigStaged(stagedFiles)) {
    // No api_config files staged, nothing to do
    return;
  }

  console.log('📋 api_config.json files detected in commit');
  console.log(`   Source: ${SOURCE_FILE}`);
  console.log('   Syncing to targets...');

  syncApiConfigFiles();
}

if (require.main === module) {
  main();
}

module.exports = { main };
