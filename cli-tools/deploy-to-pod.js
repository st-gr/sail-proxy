#!/usr/bin/env node

/**
 * Deploy compiled gateway files to a running Kubernetes pod
 *
 * Takes one or more git commit IDs, determines the changed gateway files,
 * builds the TypeScript, copies the compiled JS to the running pod,
 * and prompts the user to push a config reload from the admin service.
 *
 * Usage:
 *   node cli-tools/deploy-to-pod.js <commit-id> [commit-id...]
 *   node cli-tools/deploy-to-pod.js HEAD~1..HEAD
 *   node cli-tools/deploy-to-pod.js --working   # deploy uncommitted changes
 *
 * Options:
 *   --namespace <ns>    Kubernetes namespace (default: sail-proxy)
 *   --container <name>  Container name (default: gateway)
 *   --selector <label>  Pod label selector (default: app=gateway)
 *   --dry-run           Show what would be copied without actually copying
 *   --skip-build        Skip the TypeScript build step
 *   --working           Deploy uncommitted working tree changes
 *   --cache-clear       Clear Node module cache via inspector (default: off)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// --- Configuration ---

const NAMESPACE_DEFAULT = 'sail-proxy';
const CONTAINER_DEFAULT = 'gateway';
const SELECTOR_DEFAULT = 'app=gateway';

// Map source paths to container destination paths
const PATH_MAPPINGS = [
  {
    // Gateway TypeScript source -> compiled JS in container
    srcPattern: /^services\/gateway\/src\/(.+)\.ts$/,
    distLocal: (match) => `services/gateway/dist/services/gateway/src/${match[1]}.js`,
    distContainer: (match) => `/app/services/gateway/dist/services/gateway/src/${match[1]}.js`,
    // Also copy .d.ts files
    extraFiles: (match) => [{
      local: `services/gateway/dist/services/gateway/src/${match[1]}.d.ts`,
      container: `/app/services/gateway/dist/services/gateway/src/${match[1]}.d.ts`,
    }],
  },
  {
    // Non-TS files in plugins dir (e.g., .system-prompt.txt)
    srcPattern: /^services\/gateway\/src\/plugins\/(.+\.(?:txt|json))$/,
    distLocal: (match) => `services/gateway/src/plugins/${match[1]}`,
    // Goes to both the dist plugins dir (for __dirname resolution) and source stays as-is
    distContainer: (match) => `/app/services/gateway/dist/services/gateway/src/plugins/${match[1]}`,
  },
  {
    // api_config.json files are managed via admin service, not file copy
    srcPattern: /^services\/(?:gateway|admin)\/api_config\.json$/,
    skip: true,
    reason: 'api_config.json is deployed via admin service config push',
  },
  {
    // Helm template for api_config
    srcPattern: /^npm-dist\/.*api_config\.template\.json$/,
    skip: true,
    reason: 'Helm template — not deployed to running pod',
  },
  {
    // Test files
    srcPattern: /^services\/gateway\/test\//,
    skip: true,
    reason: 'Test file — not deployed to pod',
  },
  {
    // Documentation files
    srcPattern: /\.md$/,
    skip: true,
    reason: 'Documentation file — not deployed to pod',
  },
];

// --- Helpers ---

function exec(cmd, opts = {}) {
  const result = execSync(cmd, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: getRepoRoot(),
    ...opts,
  });
  return result == null ? '' : result.trim();
}

function getRepoRoot() {
  return execSync('git rev-parse --show-toplevel', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function log(msg) { console.log(msg); }
function warn(msg) { console.log(`  [WARN] ${msg}`); }
function error(msg) { console.error(`  [ERROR] ${msg}`); }

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    namespace: NAMESPACE_DEFAULT,
    container: CONTAINER_DEFAULT,
    selector: SELECTOR_DEFAULT,
    dryRun: false,
    skipBuild: false,
    working: false,
    cacheClearing: false,
    commits: [],
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case '--namespace': opts.namespace = args[++i]; break;
      case '--container': opts.container = args[++i]; break;
      case '--selector': opts.selector = args[++i]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--skip-build': opts.skipBuild = true; break;
      case '--working': opts.working = true; break;
      case '--cache-clear': opts.cacheClearing = true; break;
      case '--no-cache-clear': opts.cacheClearing = false; break;
      case '--help': case '-h': printUsage(); process.exit(0);
      default:
        if (args[i].startsWith('-')) {
          error(`Unknown option: ${args[i]}`);
          process.exit(1);
        }
        opts.commits.push(args[i]);
    }
    i++;
  }

  if (!opts.working && opts.commits.length === 0) {
    error('No commit IDs provided. Use --working for uncommitted changes.');
    printUsage();
    process.exit(1);
  }

  return opts;
}

function printUsage() {
  console.log(`
Usage: node cli-tools/deploy-to-pod.js [options] <commit-id> [commit-id...]

Arguments:
  commit-id           Git commit ID(s) or range (e.g., HEAD~2..HEAD)

Options:
  --namespace <ns>    Kubernetes namespace (default: ${NAMESPACE_DEFAULT})
  --container <name>  Container name (default: ${CONTAINER_DEFAULT})
  --selector <label>  Pod label selector (default: ${SELECTOR_DEFAULT})
  --dry-run           Show what would be copied without copying
  --skip-build        Skip the TypeScript build step
  --working           Deploy uncommitted working tree changes
  --cache-clear       Clear Node module cache via inspector (default: off)
  --no-cache-clear    Skip module cache clearing (default)
  -h, --help          Show this help

Examples:
  node cli-tools/deploy-to-pod.js HEAD              # last commit
  node cli-tools/deploy-to-pod.js HEAD~3..HEAD       # last 3 commits
  node cli-tools/deploy-to-pod.js abc1234 def5678    # specific commits
  node cli-tools/deploy-to-pod.js --working          # uncommitted changes
`);
}

// --- Core Logic ---

/**
 * Get changed files from git commit(s)
 */
function getChangedFiles(opts) {
  const files = new Set();

  if (opts.working) {
    // Uncommitted changes (staged + unstaged)
    const staged = exec('git diff --cached --name-only');
    const unstaged = exec('git diff --name-only');
    for (const f of [...staged.split('\n'), ...unstaged.split('\n')]) {
      if (f.trim()) files.add(f.trim());
    }
  }

  for (const commitArg of opts.commits) {
    let output;
    if (commitArg.includes('..')) {
      // Range: HEAD~3..HEAD
      output = exec(`git diff --name-only ${commitArg}`);
    } else {
      // Single commit
      output = exec(`git diff-tree --no-commit-id --name-only -r ${commitArg}`);
    }
    for (const f of output.split('\n')) {
      if (f.trim()) files.add(f.trim());
    }
  }

  return [...files].sort();
}

/**
 * Map source files to container destinations
 */
function mapFiles(changedFiles) {
  const toCopy = [];
  const skipped = [];

  for (const file of changedFiles) {
    let matched = false;

    for (const mapping of PATH_MAPPINGS) {
      const match = file.match(mapping.srcPattern);
      if (!match) continue;
      matched = true;

      if (mapping.skip) {
        skipped.push({ file, reason: mapping.reason });
        break;
      }

      const localPath = mapping.distLocal(match);
      const containerPath = mapping.distContainer(match);
      toCopy.push({ source: file, local: localPath, container: containerPath });

      // Extra files (e.g., .d.ts alongside .js)
      if (mapping.extraFiles) {
        for (const extra of mapping.extraFiles(match)) {
          toCopy.push({ source: file, local: extra.local, container: extra.container, isExtra: true });
        }
      }
      break;
    }

    if (!matched) {
      skipped.push({ file, reason: 'No mapping rule for this file' });
    }
  }

  return { toCopy, skipped };
}

/**
 * Find the gateway pod name
 */
function findPod(namespace, selector) {
  try {
    const output = exec(
      `kubectl get pods -n ${namespace} -l ${selector} --field-selector=status.phase=Running -o jsonpath="{.items[0].metadata.name}"`,
      { cwd: undefined }
    );
    if (!output || output === '{}') {
      error(`No running pod found with selector ${selector} in namespace ${namespace}`);
      process.exit(1);
    }
    return output;
  } catch (e) {
    error(`kubectl failed: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Build gateway TypeScript
 */
function buildGateway() {
  log('\n[2/5] Building gateway TypeScript...');
  try {
    exec('pnpm build:gateway', { stdio: 'inherit' });
    log('  Build successful');
  } catch (e) {
    error('Build failed');
    process.exit(1);
  }
}

/**
 * Copy files to the pod
 */
function copyFiles(toCopy, namespace, podName, container, repoRoot, dryRun) {
  log(`\n[4/5] Copying ${toCopy.length} files to ${podName}...`);
  let copied = 0;
  let failed = 0;

  for (const entry of toCopy) {
    const localAbsolute = path.join(repoRoot, entry.local);

    if (!fs.existsSync(localAbsolute)) {
      if (!entry.isExtra) {
        warn(`Local file not found: ${entry.local}`);
        failed++;
      }
      continue;
    }

    const label = entry.isExtra ? '  (extra)' : '';
    if (dryRun) {
      log(`  [DRY-RUN] ${entry.local} -> ${entry.container}${label}`);
      copied++;
      continue;
    }

    try {
      // Use relative path with cwd to avoid Windows drive letter colon (C:\)
      // which kubectl cp misinterprets as a pod:path separator
      execSync(
        `kubectl cp "${entry.local}" "${namespace}/${podName}:${entry.container}" -c ${container}`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', cwd: repoRoot }
      );
      log(`  OK: ${path.basename(entry.local)}${label}`);
      copied++;
    } catch (e) {
      error(`Failed to copy ${entry.local}: ${e.stderr || e.message}`);
      failed++;
    }
  }

  return { copied, failed };
}

/**
 * Enable Node inspector on PID 1 (SIGUSR1) and clear Module._cache
 * for all gateway modules in the running process
 */
function clearModuleCache(namespace, podName, container, dryRun) {
  log('\n[5/5] Clearing module cache in running Node process...');

  if (dryRun) {
    log('  [DRY-RUN] Would send SIGUSR1 and clear Module._cache');
    return true;
  }

  // Send SIGUSR1 to enable inspector
  try {
    execSync(
      `kubectl exec -n ${namespace} ${podName} -c ${container} -- kill -USR1 1`,
      { stdio: 'pipe', encoding: 'utf8' }
    );
  } catch (e) {
    warn(`SIGUSR1 failed: ${e.message}`);
    return false;
  }

  // Write the cache-clearing script to the container
  const script = `
var http = require("http");
var crypto = require("crypto");
http.get("http://127.0.0.1:9229/json", function(res) {
  var data = "";
  res.on("data", function(c) { data += c; });
  res.on("end", function() {
    var targets = JSON.parse(data);
    if (!targets.length) { console.log("No inspector targets"); process.exit(1); }
    var wsUrl = new URL(targets[0].webSocketDebuggerUrl);
    var key = crypto.randomBytes(16).toString("base64");
    var req = http.request({
      hostname: wsUrl.hostname, port: wsUrl.port, path: wsUrl.pathname,
      headers: { "Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" }
    });
    req.on("upgrade", function(_, socket) {
      var expr = JSON.stringify({
        id: 1, method: "Runtime.evaluate",
        params: { expression: "var c=0;for(var k of Object.keys(require.cache)){if(k.indexOf('/services/gateway/')>=0&&k.indexOf('node_modules')<0){delete require.cache[k];c++;}};JSON.stringify({cleared:c})" }
      });
      var payload = Buffer.from(expr);
      var mask = crypto.randomBytes(4);
      var header;
      if (payload.length < 126) {
        header = Buffer.alloc(6); header[0] = 0x81; header[1] = 0x80 | payload.length; mask.copy(header, 2);
      } else {
        header = Buffer.alloc(8); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); mask.copy(header, 4);
      }
      var masked = Buffer.alloc(payload.length);
      for (var i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, masked]));
      socket.on("data", function(buf) {
        var offset = 2; var len = buf[1] & 0x7f;
        if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
        else if (len === 127) { offset = 10; }
        try {
          var body = buf.slice(offset, offset + len).toString();
          var resp = JSON.parse(body);
          if (resp.id === 1) {
            if (resp.result && resp.result.result) {
              console.log(resp.result.result.value || JSON.stringify(resp.result));
            }
            socket.end();
            process.exit(0);
          }
        } catch(e) {}
      });
      setTimeout(function() { console.log("Timeout"); socket.end(); process.exit(1); }, 5000);
    });
    req.on("error", function(e) { console.error("Connection error:", e.message); process.exit(1); });
    req.end();
  });
}).on("error", function(e) { console.error("Inspector not available:", e.message); process.exit(1); });
`.trim();

  // Write script to container
  try {
    execSync(
      `kubectl exec -n ${namespace} ${podName} -c ${container} -- sh -c 'cat > /tmp/_clear_cache.js'`,
      { input: script, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' }
    );
  } catch (e) {
    warn(`Failed to write cache-clearing script: ${e.message}`);
    return false;
  }

  // Execute it
  try {
    const output = execSync(
      `kubectl exec -n ${namespace} ${podName} -c ${container} -- node /tmp/_clear_cache.js`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000 }
    );
    log(`  ${output.trim()}`);
    return true;
  } catch (e) {
    warn(`Cache clearing failed: ${e.stderr || e.message}`);
    warn('The files are on disk but the running process still uses old code.');
    warn('A config push from admin will reload plugins but not service files.');
    return false;
  }
}

// --- Main ---

function main() {
  const opts = parseArgs();
  const repoRoot = getRepoRoot();

  log('=== Gateway Pod Deployer ===\n');

  // Step 1: Determine changed files
  log('[1/5] Analyzing changed files...');
  const changedFiles = getChangedFiles(opts);
  if (changedFiles.length === 0) {
    log('  No changed files found.');
    process.exit(0);
  }

  const { toCopy, skipped } = mapFiles(changedFiles);

  log(`  ${changedFiles.length} changed files found:`);
  for (const entry of toCopy) {
    if (!entry.isExtra) log(`    + ${entry.source}`);
  }
  for (const entry of skipped) {
    log(`    - ${entry.file} (${entry.reason})`);
  }

  if (toCopy.length === 0) {
    log('\n  No deployable files to copy.');
    process.exit(0);
  }

  log(`\n  ${toCopy.length} file(s) to copy (including .d.ts extras)`);

  // Step 2: Build
  if (!opts.skipBuild) {
    buildGateway();
  } else {
    log('\n[2/5] Skipping build (--skip-build)');
  }

  // Step 3: Find pod
  log('\n[3/5] Finding gateway pod...');
  const podName = findPod(opts.namespace, opts.selector);
  log(`  Pod: ${podName} (namespace: ${opts.namespace}, container: ${opts.container})`);

  // Step 4: Copy files
  const { copied, failed } = copyFiles(toCopy, opts.namespace, podName, opts.container, repoRoot, opts.dryRun);

  if (failed > 0) {
    error(`${failed} file(s) failed to copy`);
  }
  log(`  ${copied} file(s) ${opts.dryRun ? 'would be ' : ''}copied`);

  if (opts.dryRun) {
    log('\n[DRY-RUN] No changes made.');
    process.exit(0);
  }

  // Step 5: Clear module cache (optional)
  let cacheCleared = false;
  if (opts.cacheClearing) {
    cacheCleared = clearModuleCache(opts.namespace, podName, opts.container, opts.dryRun);
  } else {
    log('\n[5/5] Skipping module cache clear (use --cache-clear to enable)');
  }

  // Summary
  log('\n=== Deployment Summary ===');
  log(`  Files copied: ${copied}`);
  if (opts.cacheClearing) {
    log(`  Module cache cleared: ${cacheCleared ? 'yes' : 'FAILED'}`);
  } else {
    log('  Module cache clear: skipped');
  }

  if (!opts.cacheClearing || cacheCleared) {
    log('\n  Next step: push a config reload from the admin service.');
    log('  This triggers the gateway to re-require all modules from disk');
    log('  and reload plugins with the updated code.\n');
  } else {
    log('\n>>> IMPORTANT: The module cache could not be cleared. <<<');
    log('    Files are on disk but the running process uses old code.');
    log('    Options:');
    log('    1. Push a config from admin (reloads plugins only, not services)');
    log('    2. Restart the pod: kubectl rollout restart deployment/gateway -n ' + opts.namespace);
    log('       (this will wipe files — you\'ll need to re-run this script after restart)\n');
  }
}

main();
