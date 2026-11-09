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
  // A key may carry a major selector ("uuid@11", "@scope/lib@2"). When it targets the major a direct
  // dependency is declared at, it pins that dependency exactly like a bare-name key - npm rejects a
  // forwarded "uuid@11" against a direct "uuid": "^11.1.0" (EOVERRIDE). Other majors pass through.
  const majorOf = (range) => { const m = String(range).match(/\d+/); return m ? m[0] : null; };
  const directName = (key, deps) => {
    const at = key.indexOf('@', 1);
    const name = at === -1 ? key : key.slice(0, at);
    if (!Object.prototype.hasOwnProperty.call(deps, name)) return null;
    if (at !== -1 && majorOf(key.slice(at + 1)) !== majorOf(deps[name])) return null;
    return name;
  };
  for (const [key, version] of Object.entries(rootOverrides)) {
    if (key.includes('>')) continue;
    const direct = directName(key, dependencies);
    const optional = direct ? null : directName(key, optionalDependencies);
    if (direct) {
      dependencies[direct] = version;
      overrides[direct] = `$${direct}`;
      pinnedDirect++;
    } else if (optional) {
      optionalDependencies[optional] = version;
      overrides[optional] = `$${optional}`;
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