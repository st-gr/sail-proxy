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

// Installed plugins on the CLI: a zip in <config dir>/plugins is there after a start, and gone after
// the next start once the zip is removed. Runs the real gateway entry with the CLI's own env, against
// a copy of the bundled gateway, because the sync writes into the plugins folder.
const bundleRoot = path.resolve(gatewayCwd);
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sail-proxy-installed-')));
const copyRoot = path.join(scratch, 'gateway');
// Node 20's cpSync gives the filter Windows long paths (\\?\C:\...): compared without that prefix.
const plainPath = source => source.replace(/^\\\\\?\\/, '');
fs.cpSync(bundleRoot, copyRoot, {
  recursive: true,
  filter: source => path.relative(bundleRoot, plainPath(source)) !== 'node_modules',
});
fs.symlinkSync(path.join(bundleRoot, 'node_modules'), path.join(copyRoot, 'node_modules'), 'junction');
const copyEntry = path.join(copyRoot, path.relative(bundleRoot, gatewayEntry));
const copyPlugins = path.join(path.dirname(copyEntry), 'plugins');
const configDir = path.join(scratch, 'config');
const configFile = path.join(configDir, 'api_config.json');
fs.mkdirSync(configDir);

const { buildGatewayEnv } = require(path.join(packageRoot, 'dist', 'utils', 'gateway-env.js'));
const { zipSync, strToU8 } = require(path.join(bundleRoot, 'node_modules', 'fflate'));
const { execFileSync } = require('child_process');

const SAMPLE_ID = 'sampleInstalled';
const manifestOf = (gateway) => JSON.stringify({
  id: SAMPLE_ID, version: '1.0.0', runtime: 'node', gateway,
  settings: { schema: { type: 'object' }, defaults: { greeting: 'hello' } },
  help: { en: { summary: 'A sample' } },
});
const sampleZip = (gateway = '*') => zipSync({
  'manifest.json': strToU8(manifestOf(gateway)),
  'index.js': strToU8(
    "const { ruleId } = require('./lib/helper');\n" +
    "module.exports = [{ id: ruleId, match: [], strategy: 'before', handler: async () => ({}) }];\n"
  ),
  'lib/helper.js': strToU8(`exports.ruleId = '${SAMPLE_ID}';\n`),
});

function start(helperFile) {
  const env = buildGatewayEnv({ PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, HOSTNAME: 'bundled-test', METADATA_ENCRYPTION_KEY: 'a'.repeat(64) }, {}, configFile);
  const args = [path.join(__dirname, 'installed-plugins-driver.js'), copyEntry, SAMPLE_ID];
  if (helperFile) args.push(helperFile);
  const out = execFileSync(process.execPath, args, {
    cwd: copyRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
  });
  const result = JSON.parse(out.split('\n').find(line => line.startsWith('RESULT ')).slice('RESULT '.length));
  if (result.driverError) throw new Error(result.driverError);
  return result;
}

const sourceFolder = path.join(configDir, 'plugins');
const unpacked = path.join(copyPlugins, SAMPLE_ID);
const sampleRow = result => result.report.find(row => row.source === SAMPLE_ID);

check('a start without the plugins folder loads the built-ins and installs nothing', () => {
  const result = start();
  assert.ok(result.builtIn, 'pseudonymizationPlugin/before is missing');
  assert.strictEqual(sampleRow(result), undefined);
  assert.ok(!fs.existsSync(unpacked));
});

fs.mkdirSync(sourceFolder);
const zipPath = path.join(sourceFolder, 'sample.zip');
fs.writeFileSync(zipPath, sampleZip());
fs.writeFileSync(path.join(sourceFolder, '.DS_Store'), 'junk');
fs.writeFileSync(path.join(sourceFolder, 'corrupt.zip'), 'not a zip');

check('a zip in the plugins folder is registered on a fresh start, built-ins intact', () => {
  const result = start();
  assert.ok(fs.existsSync(path.join(unpacked, '.installed.json')), 'the package was not unpacked');
  assert.ok(result.afterConfig.hasRule, 'the rule is not registered');
  assert.ok(result.builtIn, 'pseudonymizationPlugin/before is missing');
  assert.deepStrictEqual(sampleRow(result), {
    source: SAMPLE_ID, kind: 'installed', id: SAMPLE_ID, version: '1.0.0', rules: [{ id: SAMPLE_ID, strategy: 'before' }],
  });
});

check('boot order: a fresh unpack lands before the one and only plugin load, and does not reload', () => {
  // Pins the answer to "does standalone config initialization load plugins before the boot sync
  // returns?": no. Nothing before bootSyncPlugins calls getConfig(); the first load is the one
  // runMigration causes later in initializeGatewayService, before the listener binds. Were that to
  // move ahead of the boot sync, this would show reloads: 1 (the runtime then reloads once).
  fs.rmSync(unpacked, { recursive: true, force: true });
  assert.deepStrictEqual(start().atListen, { hasRule: true, loaded: true, firstLoads: 1, reloads: 0 });
});

check('manifest defaults reach getPluginSettings in the bundle', () => {
  assert.deepStrictEqual(start().settings, { greeting: 'hello' });
});

check('a damaged zip of an installed plugin keeps the plugin running', () => {
  assert.ok(fs.existsSync(unpacked), 'precondition: the earlier start should have installed it');
  const good = fs.readFileSync(zipPath);
  fs.writeFileSync(zipPath, good.subarray(0, 40));
  const result = start();
  fs.writeFileSync(zipPath, good);
  assert.ok(fs.existsSync(path.join(unpacked, '.installed.json')), 'the plugin was removed');
  assert.ok(result.afterConfig.hasRule, 'the rule is gone');
});

check('a reload picks up a changed helper file inside the plugin folder', () => {
  assert.strictEqual(start(path.join(unpacked, 'lib', 'helper.js')).reloadedFresh, true);
});

check('after removing the zip the plugin is gone on the next start, and its folder with it', () => {
  assert.ok(fs.existsSync(unpacked), 'precondition: the earlier start should have installed it');
  fs.rmSync(zipPath);
  fs.rmSync(path.join(sourceFolder, 'corrupt.zip')); // an unreadable zip would hold the removal back
  const result = start();
  assert.ok(!fs.existsSync(unpacked), 'the plugin folder is still there');
  assert.ok(!result.afterConfig.hasRule, 'the rule is still registered');
  assert.strictEqual(sampleRow(result), undefined);
  assert.ok(result.builtIn, 'pseudonymizationPlugin/before is missing');
});

check('a package for another gateway version is not unpacked and the gateway still starts', () => {
  fs.writeFileSync(zipPath, sampleZip('>=999.0.0'));
  const result = start();
  assert.ok(!fs.existsSync(unpacked));
  assert.ok(!result.afterConfig.hasRule);
  assert.ok(result.builtIn, 'pseudonymizationPlugin/before is missing');
});

fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\nRegistered ${ruleCount} plugin rules from ${gatewayCwd}`);
process.exit(failed ? 1 : 0);
