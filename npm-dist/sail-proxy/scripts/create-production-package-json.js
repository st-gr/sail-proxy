#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

if (process.argv.length !== 4) {
  console.error('Usage: node create-production-package-json.js <input-package.json> <output-package.json>');
  process.exit(1);
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];

try {
  // Read the original package.json
  const originalPackage = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  
  // Read the root package.json to get the synchronized version
  const rootPackagePath = path.resolve(__dirname, '..', '..', '..', 'package.json');
  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf-8'));
  
  // Create production-only package.json with synchronized version
  const productionPackage = {
    name: originalPackage.name,
    version: rootPackage.version, // Use root version for consistency
    description: originalPackage.description,
    private: originalPackage.private,
    main: originalPackage.main,
    engines: originalPackage.engines,
    dependencies: originalPackage.dependencies || {},
    optionalDependencies: originalPackage.optionalDependencies || {},
    // Exclude devDependencies, scripts, and test-related fields
  };
  
  // Write the production package.json
  fs.writeFileSync(outputPath, JSON.stringify(productionPackage, null, 2));
  console.log(`Created production package.json: ${outputPath} (version: ${rootPackage.version})`);
} catch (error) {
  console.error(`Error creating production package.json: ${error.message}`);
  process.exit(1);
}