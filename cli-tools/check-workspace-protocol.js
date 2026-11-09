#!/usr/bin/env node

/**
 * Check that package.json has workspace:* protocol (not concrete versions)
 *
 * This is a safety check to ensure you don't accidentally commit concrete versions.
 * Run this before committing.
 *
 * Usage: node cli-tools/check-workspace-protocol.js
 * Exit code: 0 if OK, 1 if workspace:* is missing
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const npmPackageJsonPath = path.join(projectRoot, 'npm-dist', 'sail-proxy', 'package.json');

function main() {
  if (!fs.existsSync(npmPackageJsonPath)) {
    console.error('❌ Error: npm-dist/sail-proxy/package.json not found');
    process.exit(1);
  }

  const packageJson = JSON.parse(fs.readFileSync(npmPackageJsonPath, 'utf8'));
  const issues = [];

  if (packageJson.dependencies) {
    for (const [depName, depVersion] of Object.entries(packageJson.dependencies)) {
      if (depName.startsWith('@sap-llm-gateway/') && depVersion !== 'workspace:*') {
        issues.push(`${depName}: has "${depVersion}" but should be "workspace:*"`);
      }
    }
  }

  if (issues.length === 0) {
    console.log('✅ All @sap-llm-gateway dependencies use workspace:* protocol');
    process.exit(0);
  }

  console.error('❌ Found concrete versions (should be workspace:*):');
  issues.forEach(issue => console.error(`   - ${issue}`));
  console.error('\n⚠️  Run: npm run restore-workspace');
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
