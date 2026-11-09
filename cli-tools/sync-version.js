#!/usr/bin/env node

/**
 * Sync version numbers from project root package.json to:
 * 1. All lib packages (libs/*)
 * 2. All service packages (services/{gateway,admin,ollama})
 * 3. docker/package.json
 * 4. npm-dist/sail-proxy package
 * 5. services/{gateway,admin}/package.docker.json (the Docker image manifests)
 * 6. info.version of the OpenAPI documents in openapi/ (three YAML files, line-level; admin-odata.json, JSON)
 *
 * NOTE: This does NOT touch workspace:* protocols - those are for development
 * and should only be replaced during packaging (see prepare-for-pack.js).
 *
 * Usage: node cli-tools/sync-version.js [--check-only]
 * Options:
 *   --check-only  Only check if versions are synchronized, don't update
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const rootPackageJsonPath = path.join(projectRoot, 'package.json');

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

function collectTargetPackages() {
  const targets = [];

  // npm-dist/sail-proxy
  const npmPath = path.join(projectRoot, 'npm-dist', 'sail-proxy', 'package.json');
  if (fs.existsSync(npmPath)) targets.push(npmPath);

  // libs/*
  const libsDir = path.join(projectRoot, 'libs');
  if (fs.existsSync(libsDir)) {
    fs.readdirSync(libsDir).forEach(name => {
      const p = path.join(libsDir, name, 'package.json');
      if (fs.existsSync(p)) targets.push(p);
    });
  }

  // services/{gateway,admin,ollama}
  for (const svc of ['gateway', 'admin', 'ollama']) {
    const p = path.join(projectRoot, 'services', svc, 'package.json');
    if (fs.existsSync(p)) targets.push(p);
  }

  // docker/package.json
  const dockerPkg = path.join(projectRoot, 'docker', 'package.json');
  if (fs.existsSync(dockerPkg)) targets.push(dockerPkg);

  // services/{gateway,admin}/package.docker.json - the manifests the images are
  // built from; left out, every image reported 1.0.0 whatever the release was.
  for (const svc of ['gateway', 'admin']) {
    const p = path.join(projectRoot, 'services', svc, 'package.docker.json');
    if (fs.existsSync(p)) targets.push(p);
  }

  return targets;
}

const OPENAPI_YAML_FILES = ['gateway.yaml', 'admin-rest.yaml', 'ollama.yaml'];
const OPENAPI_JSON_FILES = ['admin-odata.json'];

/**
 * The `version:` line of a YAML document's top-level `info:` block. Matched by line so the hand-written
 * formatting stays untouched; a missing line is an error, never a silent skip.
 */
function findYamlInfoVersion(text, filePath) {
  const lines = text.split('\n');
  const infoAt = lines.findIndex(line => /^info:\s*$/.test(line));
  if (infoAt === -1) throw new Error(`${getRelativePath(filePath)}: no top-level "info:" block`);
  for (let i = infoAt + 1; i < lines.length && (lines[i] === '' || /^\s/.test(lines[i])); i++) {
    const match = /^(\s+version:\s*)(['"]?)([^'"\s#]+)\2(\s*(#.*)?)$/.exec(lines[i]);
    if (match) return { lines, index: i, match };
  }
  throw new Error(`${getRelativePath(filePath)}: no "version:" line inside the "info:" block`);
}

/** Each OpenAPI document with its current info.version and a function that rewrites the file to a new one. */
function collectOpenApiTargets() {
  const dir = path.join(projectRoot, 'openapi');
  const targets = [];
  for (const name of OPENAPI_YAML_FILES) {
    const filePath = path.join(dir, name);
    const text = fs.readFileSync(filePath, 'utf8');
    const { lines, index, match } = findYamlInfoVersion(text, filePath);
    targets.push({
      path: filePath,
      version: match[3],
      write(version) {
        lines[index] = `${match[1]}${match[2]}${version}${match[2]}${match[4]}`;
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
      },
    });
  }
  for (const name of OPENAPI_JSON_FILES) {
    const filePath = path.join(dir, name);
    const doc = readJsonFile(filePath);
    if (!doc.info || typeof doc.info.version !== 'string') {
      throw new Error(`${getRelativePath(filePath)}: no info.version`);
    }
    targets.push({
      path: filePath,
      version: doc.info.version,
      write(version) {
        doc.info.version = version;
        writeJsonFile(filePath, doc);
      },
    });
  }
  return targets;
}

async function main() {
  const checkOnly = process.argv.includes('--check-only');
  const stage = process.argv.includes('--stage');

  const rootPackage = readJsonFile(rootPackageJsonPath);
  const rootVersion = rootPackage.version;

  if (!rootVersion) {
    console.error('Error: No version found in root package.json');
    process.exit(1);
  }

  console.log(`Source of truth: Root package version = ${rootVersion}\n`);

  const issues = [];
  const updates = [];

  for (const targetPath of collectTargetPackages()) {
    const pkg = readJsonFile(targetPath);
    if (pkg.version !== rootVersion) {
      issues.push(`${getRelativePath(targetPath)}: ${pkg.version} ≠ ${rootVersion}`);
      if (!checkOnly) updates.push({ path: targetPath, package: pkg });
    }
  }

  const openApiUpdates = [];
  for (const target of collectOpenApiTargets()) {
    if (target.version !== rootVersion) {
      issues.push(`${getRelativePath(target.path)}: info.version ${target.version} ≠ ${rootVersion}`);
      if (!checkOnly) openApiUpdates.push(target);
    }
  }

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

  console.log('Applying fixes...\n');

  const writtenPaths = [];
  for (const update of updates) {
    const oldVersion = update.package.version;
    update.package.version = rootVersion;
    writeJsonFile(update.path, update.package);
    writtenPaths.push(update.path);
    console.log(`✅ ${getRelativePath(update.path)}`);
    console.log(`   - version: ${oldVersion} → ${rootVersion}`);
  }

  for (const target of openApiUpdates) {
    const oldVersion = target.version;
    target.write(rootVersion);
    writtenPaths.push(target.path);
    console.log(`✅ ${getRelativePath(target.path)}`);
    console.log(`   - info.version: ${oldVersion} → ${rootVersion}`);
  }

  if (stage && writtenPaths.length > 0) {
    const res = spawnSync('git', ['add', '--', ...writtenPaths], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    if (res.status !== 0) {
      console.error('⚠️  git add failed; commit may not include synced files');
      process.exit(res.status || 1);
    }
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
