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
  
  // Forward root pnpm.overrides into the bundled package.json so npm install
  // --production (which has no pnpm context) still pins the CVE-patched
  // versions. For a DIRECT dependency the version is pinned inline AND an
  // override "$<name>" is added: npm rejects any other override value for a
  // direct dependency (EOVERRIDE), and without one the copies other packages
  // bring along keep their own ranges - express 4.22.0 shipped its own
  // qs@6.14.2 (three advisories) beside the pinned qs@6.16.0. For transitive
  // deps a plain `overrides` entry is added.
  // Drop pnpm-specific parent>child syntax — those target dev-only chains.
  const rootOverrides = (rootPackage.pnpm && rootPackage.pnpm.overrides) || {};
  const dependencies = { ...(originalPackage.dependencies || {}) };
  const optionalDependencies = { ...(originalPackage.optionalDependencies || {}) };
  const overrides = {};
  let pinnedDirect = 0;
  let pinnedTransitive = 0;
  for (const [key, version] of Object.entries(rootOverrides)) {
    if (key.includes('>')) continue;
    if (Object.prototype.hasOwnProperty.call(dependencies, key)) {
      dependencies[key] = version;
      overrides[key] = `$${key}`;
      pinnedDirect++;
    } else if (Object.prototype.hasOwnProperty.call(optionalDependencies, key)) {
      optionalDependencies[key] = version;
      overrides[key] = `$${key}`;
      pinnedDirect++;
    } else {
      overrides[key] = version;
      pinnedTransitive++;
    }
  }

  // Create production-only package.json with synchronized version
  const productionPackage = {
    name: originalPackage.name,
    version: rootPackage.version, // Use root version for consistency
    description: originalPackage.description,
    private: originalPackage.private,
    main: originalPackage.main,
    engines: originalPackage.engines,
    dependencies,
    optionalDependencies,
    overrides,
    // Exclude devDependencies, scripts, and test-related fields
  };

  // Write the production package.json
  fs.writeFileSync(outputPath, JSON.stringify(productionPackage, null, 2));
  console.log(
    `Created production package.json: ${outputPath} (version: ${rootPackage.version}, ` +
    `${pinnedDirect} direct deps pinned, ${pinnedTransitive} transitive overrides forwarded)`
  );
} catch (error) {
  console.error(`Error creating production package.json: ${error.message}`);
  process.exit(1);
}