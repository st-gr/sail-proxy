#!/usr/bin/env node

/**
 * Extract version from package.json
 * Usage: node docker/scripts/get-version.js
 * Output: version string (e.g., "1.0.0")
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../..');
const packageJsonPath = path.join(projectRoot, 'package.json');

try {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  if (!packageJson.version) {
    console.error('Error: No version found in package.json');
    process.exit(1);
  }

  // Output only the version string (no extra output for script usage)
  console.log(packageJson.version);
  process.exit(0);
} catch (error) {
  console.error(`Error reading package.json: ${error.message}`);
  process.exit(1);
}
