#!/usr/bin/env node

/**
 * Sync version numbers from project root package.json to:
 * 1. All lib packages (libs/*)
 * 2. npm-dist/sail-proxy package
 *
 * This ensures all packages use a single source of truth for versioning.
 * NOTE: This does NOT touch workspace:* protocols - those are for development
 * and should only be replaced during packaging (see prepare-for-pack.js).
 *
 * Usage: node cli-tools/sync-version.js [--check-only]
 * Options:
 *   --check-only  Only check if versions are synchronized, don't update
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const rootPackageJsonPath = path.join(projectRoot, 'package.json');
const npmPackageJsonPath = path.join(projectRoot, 'npm-dist', 'sail-proxy', 'package.json');

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Error reading ${filePath}: ${error.message}`);
    process.exit(1);
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error(`Error writing ${filePath}: ${error.message}`);
    process.exit(1);
  }
}

function getRelativePath(filePath) {
  return path.relative(projectRoot, filePath);
}

async function main() {
  const checkOnly = process.argv.includes('--check-only');

  // Read root package.json
  const rootPackage = readJsonFile(rootPackageJsonPath);
  const rootVersion = rootPackage.version;

  if (!rootVersion) {
    console.error('Error: No version found in root package.json');
    process.exit(1);
  }

  console.log(`Source of truth: Root package version = ${rootVersion}\n`);

  const issues = [];
  const updates = [];

  // Check npm-dist package
  if (fs.existsSync(npmPackageJsonPath)) {
    const npmPackage = readJsonFile(npmPackageJsonPath);
    const npmVersion = npmPackage.version;

    if (npmVersion !== rootVersion) {
      issues.push(`npm-dist/sail-proxy: ${npmVersion} ≠ ${rootVersion}`);
      if (!checkOnly) {
        updates.push({ path: npmPackageJsonPath, package: npmPackage });
      }
    }
  }

  // Check all lib packages
  const libPackages = fs.readdirSync(path.join(projectRoot, 'libs'))
    .filter(name => {
      const pkgPath = path.join(projectRoot, 'libs', name, 'package.json');
      return fs.existsSync(pkgPath);
    })
    .map(name => path.join(projectRoot, 'libs', name, 'package.json'));

  for (const libPath of libPackages) {
    const libPackage = readJsonFile(libPath);
    const libVersion = libPackage.version;

    if (libVersion !== rootVersion) {
      issues.push(`${getRelativePath(libPath)}: ${libVersion} ≠ ${rootVersion}`);
      if (!checkOnly) {
        updates.push({ path: libPath, package: libPackage });
      }
    }
  }

  // Report findings
  if (issues.length === 0) {
    console.log('✅ All versions are synchronized');
    process.exit(0);
  }

  console.log('Issues found:');
  issues.forEach(issue => console.log(`  ❌ ${issue}`));
  console.log('');

  if (checkOnly) {
    console.log('Run without --check-only to fix these issues');
    process.exit(1);
  }

  // Apply updates (only version numbers, never touch workspace:*)
  console.log('Applying fixes...\n');

  for (const update of updates) {
    const oldVersion = update.package.version;
    update.package.version = rootVersion;

    writeJsonFile(update.path, update.package);

    console.log(`✅ ${getRelativePath(update.path)}`);
    console.log(`   - version: ${oldVersion} → ${rootVersion}`);
  }

  console.log('\n✅ All package versions synchronized to ' + rootVersion);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}

module.exports = { main };
