#!/usr/bin/env node

/**
 * Restore workspace:* protocol for internal dependencies in npm-dist/sail-proxy
 *
 * This surgically restores ONLY the dependency protocol, without touching:
 * - Version numbers
 * - Other dependencies
 * - Any other package.json fields
 *
 * Usage: node cli-tools/restore-workspace-protocol.js
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const npmPackageJsonPath = path.join(projectRoot, 'npm-dist', 'sail-proxy', 'package.json');

function main() {
  if (!fs.existsSync(npmPackageJsonPath)) {
    console.error('Error: npm-dist/sail-proxy/package.json not found');
    process.exit(1);
  }

  // Read package.json
  const packageJson = JSON.parse(fs.readFileSync(npmPackageJsonPath, 'utf8'));

  let restored = [];

  // Restore workspace protocol for internal dependencies
  if (packageJson.dependencies) {
    for (const [depName, depVersion] of Object.entries(packageJson.dependencies)) {
      // Only restore @sap-llm-gateway internal dependencies
      if (depName.startsWith('@sap-llm-gateway/') && depVersion !== 'workspace:*') {
        packageJson.dependencies[depName] = 'workspace:*';
        restored.push({ name: depName, from: depVersion, to: 'workspace:*' });
      }
    }
  }

  if (restored.length === 0) {
    console.log('✅ Workspace protocols are already correct');
    return;
  }

  // Write back surgically - only dependencies changed
  fs.writeFileSync(npmPackageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');

  console.log('✅ Restored workspace protocols:');
  restored.forEach(r => {
    console.log(`   - ${r.name}: ${r.from} → ${r.to}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
