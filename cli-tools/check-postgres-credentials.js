#!/usr/bin/env node

/**
 * Check and auto-fix PostgreSQL credentials in docker config files
 *
 * This script ensures that PostgreSQL credentials in docker configuration
 * files are set to safe defaults (admin_user/admin_password) before committing.
 * This prevents accidental leakage of production credentials into git history.
 *
 * Files checked:
 * - docker/docker-compose.yml
 * - docker/configs/providers/[provider]/dex.config[suffix].yaml
 *
 * Usage: node cli-tools/check-postgres-credentials.js
 * Exit code: 0 (always succeeds after auto-fix)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_USER = 'admin_user';
const DEFAULT_PASSWORD = 'admin_password';

const FILES_TO_CHECK = [
  'docker/docker-compose.yml',
  'docker/configs/providers/ldap/dex.config.yaml',
  'docker/configs/providers/ldap/dex.config.external.yaml',
  'docker/configs/providers/github/dex.config.yaml',
  'docker/configs/providers/local/dex.config.yaml',
  'docker/configs/providers/okta/dex.config.yaml'
];

/**
 * Check a file for non-default PostgreSQL credentials and fix them
 * @param {string} filePath - Relative path to file from project root
 * @returns {boolean} - True if file was modified, false otherwise
 */
function checkAndFixFile(filePath) {
  const projectRoot = path.resolve(__dirname, '..');
  const fullPath = path.join(projectRoot, filePath);

  if (!fs.existsSync(fullPath)) {
    return false;
  }

  let content = fs.readFileSync(fullPath, 'utf8');
  let modified = false;

  // For docker-compose.yml
  // Format: POSTGRES_USER=value or POSTGRES_PASSWORD=value
  if (filePath.includes('docker-compose.yml')) {
    const newContent = content
      .replace(
        /(- POSTGRES_USER=)(?!admin_user\s*$).*/gm,
        `$1${DEFAULT_USER}`
      )
      .replace(
        /(- POSTGRES_PASSWORD=)(?!admin_password\s*$).*/gm,
        `$1${DEFAULT_PASSWORD}`
      );

    if (newContent !== content) {
      content = newContent;
      modified = true;
    }
  }

  // For dex.config.yaml files (in postgres section)
  // Format: user: value or password: value (with indentation)
  if (filePath.includes('dex.config') && filePath.endsWith('.yaml')) {
    const newContent = content
      .replace(
        /^(\s+user:\s+)(?!admin_user\s*$).*/gm,
        `$1${DEFAULT_USER}`
      )
      .replace(
        /^(\s+password:\s+)(?!admin_password\s*$).*/gm,
        `$1${DEFAULT_PASSWORD}`
      );

    if (newContent !== content) {
      content = newContent;
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(fullPath, content, 'utf8');
    // Re-stage the file
    try {
      execSync(`git add "${filePath}"`, { cwd: projectRoot, stdio: 'pipe' });
    } catch (error) {
      // Ignore errors - file might not be in git or git might not be available
    }
    return true;
  }

  return false;
}

function main() {
  let fixedFiles = [];

  for (const file of FILES_TO_CHECK) {
    const wasFixed = checkAndFixFile(file);
    if (wasFixed) {
      fixedFiles.push(file);
    }
  }

  if (fixedFiles.length > 0) {
    console.log('🔒 Auto-fixed PostgreSQL credentials to defaults:');
    fixedFiles.forEach(file => console.log(`   - ${file}`));
    console.log('\n✅ Safe defaults restored. Commit will proceed.');
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { main };
