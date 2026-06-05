#!/usr/bin/env node

/**
 * Prepare package.json for npm pack/publish
 *
 * This script is ONLY for packaging, not for development builds.
 * It replaces workspace:* protocols with concrete versions from root package.json.
 *
 * Usage: node cli-tools/prepare-for-pack.js
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const rootPackageJsonPath = path.join(projectRoot, 'package.json');
const npmPackageJsonPath = path.join(projectRoot, 'npm-dist', 'sail-proxy', 'package.json');

function main() {
  // Read root version
  const rootPackage = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));
  const rootVersion = rootPackage.version;

  if (!rootVersion) {
    console.error('Error: No version found in root package.json');
    process.exit(1);
  }

  // Read npm package
  if (!fs.existsSync(npmPackageJsonPath)) {
    console.error('Error: npm-dist/sail-proxy/package.json not found');
    process.exit(1);
  }

  const npmPackage = JSON.parse(fs.readFileSync(npmPackageJsonPath, 'utf8'));
  let replaced = [];

  // Replace workspace protocols with concrete version
  if (npmPackage.dependencies) {
    for (const [depName, depVersion] of Object.entries(npmPackage.dependencies)) {
      if (depName.startsWith('@sap-llm-gateway/') && depVersion === 'workspace:*') {
        npmPackage.dependencies[depName] = rootVersion;
        replaced.push({ name: depName, from: 'workspace:*', to: rootVersion });
      }
    }
  }

  if (replaced.length === 0) {
    console.log('✅ No workspace protocols to replace');
    return;
  }

  // Write updated package.json
  fs.writeFileSync(npmPackageJsonPath, JSON.stringify(npmPackage, null, 2) + '\n', 'utf8');

  console.log('✅ Prepared for packing:');
  replaced.forEach(r => {
    console.log(`   - ${r.name}: ${r.from} → ${r.to}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
