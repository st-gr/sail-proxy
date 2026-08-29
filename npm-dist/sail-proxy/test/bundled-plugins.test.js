#!/usr/bin/env node
/**
 * Deployment-parity check for the standalone CLI: the bundled gateway must
 * register its hook plugins.
 *
 * Regression guard. The CLI spawns the bundled gateway with `cwd =
 * bundled/gateway` (src/commands/server.ts, via getGatewayCwd()), while the
 * compiled plugins land in `bundled/gateway/services/gateway/src/plugins`.
 * While the loader resolved its plugins directory against `process.cwd()`, it
 * looked in `bundled/gateway/src/plugins`, created that empty, and logged
 * "Registered 0 plugin rules" — so pseudonymization and every other hook plugin
 * never ran in this deployment, while docker and local dev were fine.
 *
 * This runs the real bundled loader in-process, from the real spawn cwd, using
 * the CLI's own path helpers so it tracks any future change to the layout.
 *
 * Prerequisites: `npm run build:local && npm run bundle` (or at least
 * `bundle:gateway` + `bundle:install-prod-deps` + `bundle:gateway-aliases`).
 * Run with `npm test`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const pathsModule = path.join(packageRoot, 'dist', 'utils', 'paths.js');

if (!fs.existsSync(pathsModule)) {
  console.error(`Missing ${pathsModule}. Run "npm run build:local" first.`);
  process.exit(1);
}

const { getGatewayPath, getGatewayCwd } = require(pathsModule);

const gatewayEntry = getGatewayPath();
const gatewayCwd = getGatewayCwd();

if (!fs.existsSync(gatewayEntry)) {
  console.error(`Missing bundled gateway entry ${gatewayEntry}. Run "npm run bundle" first.`);
  process.exit(1);
}

// Exactly what the spawned gateway sees: same cwd, same NODE_ENV, and a config
// path that cannot touch the developer's ~/.sail-proxy.
const scratchConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-proxy-plugin-check-'));
process.env.NODE_ENV = 'production';
process.env.CONFIG_FILE_PATH = path.join(scratchConfigDir, 'api_config.json');
process.chdir(gatewayCwd);

const pluginLoaderPath = path.join(path.dirname(gatewayEntry), 'services', 'pluginLoader.js');
const pluginLoader = require(pluginLoaderPath);

let failed = false;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${name}`);
    console.error(`  ${error.message}`);
  }
}

const registry = pluginLoader.loadAll();
const ruleCount = Object.keys(registry).length;

check('the bundled gateway registers plugin rules from the CLI spawn cwd', () => {
  assert.ok(
    ruleCount > 0,
    `Registered ${ruleCount} plugin rules from cwd ${gatewayCwd}; expected more than 0. ` +
    'The loader is looking in the wrong directory again.'
  );
});

check('pseudonymizationPlugin is registered with its before hook', () => {
  assert.ok(
    pluginLoader.getRule('pseudonymizationPlugin', 'before'),
    'pseudonymizationPlugin/before is not in the registry; masking would silently not run.'
  );
});

check('nothing was created next to the spawn cwd', () => {
  const strayDir = path.join(gatewayCwd, 'src', 'plugins');
  assert.ok(
    !fs.existsSync(strayDir),
    `${strayDir} exists — the loader fell back to a cwd-relative path and created it empty.`
  );
});

fs.rmSync(scratchConfigDir, { recursive: true, force: true });

console.log(`\nRegistered ${ruleCount} plugin rules from ${gatewayCwd}`);
process.exit(failed ? 1 : 0);
