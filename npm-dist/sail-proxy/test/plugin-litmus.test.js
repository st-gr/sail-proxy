#!/usr/bin/env node
/**
 * The litmus for the plugin package format: two real built-ins, packaged by the real tool, installed by
 * the real sync into a copy of the bundled gateway and loaded in a fresh process, must behave exactly like
 * the shipped ones. Rule ids and strategies below are literals taken from the gateway before the port.
 *
 * Prerequisites: `npm run build:local && npm run bundle`. Run with `npm test`. Each step runs in a child
 * process with a scratch HOME and config, and binds nothing but its own mock on an OS-picked loopback port.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const pathsModule = path.join(packageRoot, 'dist', 'utils', 'paths.js');
if (!fs.existsSync(pathsModule)) {
  console.error(`Missing ${pathsModule}. Run "npm run build:local" first.`);
  process.exit(1);
}
const { getGatewayPath, getGatewayCwd } = require(pathsModule);
const { buildGatewayEnv } = require(path.join(packageRoot, 'dist', 'utils', 'gateway-env.js'));

const bundleRoot = path.resolve(getGatewayCwd());
const bundleEntry = getGatewayPath();
if (!fs.existsSync(bundleEntry)) {
  console.error(`Missing bundled gateway entry ${bundleEntry}. Run "npm run bundle" first.`);
  process.exit(1);
}
const srcRelative = path.relative(bundleRoot, path.dirname(bundleEntry));
const TOOL = path.join(repoRoot, 'cli-tools', 'package-plugin.js');
const SAMPLE_DIR = path.join(repoRoot, 'services', 'gateway', 'test', 'fixtures', 'sample-plugin');
const DRIVER = path.join(__dirname, 'plugin-litmus-driver.js');

const STRIP_RULES = [{ id: 'stripCacheControlScope', strategy: 'before' }];
const WEB_RULES = [{ id: 'webSearchPlugin', strategy: 'before' }, { id: 'webSearchPlugin', strategy: 'after' }];
const OTHER_BUILT_INS = {
  awsBedrockResponseCache: [
    { id: 'awsBedrockResponseCache', strategy: 'before' },
    { id: 'awsBedrockResponseCache', strategy: 'after' },
    { id: 'awsBedrockResponseCache', strategy: 'error' },
    { id: 'awsBedrockResponseCache', strategy: 'stream' },
  ],
  pseudonymization: [
    { id: 'pseudonymizationPlugin', strategy: 'before' },
    { id: 'pseudonymizationPlugin', strategy: 'after' },
    { id: 'pseudonymizationPlugin', strategy: 'stream' },
  ],
  removeEmptyAssistantMessages: [
    { id: 'removeEmptyAssistantMessages', strategy: 'before' },
    { id: 'removeEmptyAssistantMessages', strategy: 'after' },
  ],
  repairToolBlocks: [{ id: 'repairToolBlocks', strategy: 'before' }],
  resizeOversizedImages: [{ id: 'resizeOversizedImages', strategy: 'before' }],
  responsesCustomToolsPlugin: [
    { id: 'responsesCustomToolsPlugin', strategy: 'before' },
    { id: 'responsesCustomToolsPlugin', strategy: 'after' },
  ],
  responsesFileSearchPlugin: [
    { id: 'responsesFileSearchPlugin', strategy: 'before' },
    { id: 'responsesFileSearchPlugin', strategy: 'after' },
  ],
  responsesImagePlugin: [{ id: 'responsesImagePlugin', strategy: 'before' }],
  responsesNamespaceToolsPlugin: [
    { id: 'responsesNamespaceToolsPlugin', strategy: 'before' },
    { id: 'responsesNamespaceToolsPlugin', strategy: 'after' },
  ],
  responsesWebSearchPlugin: [
    { id: 'responsesWebSearchPlugin', strategy: 'before' },
    { id: 'responsesWebSearchPlugin', strategy: 'after' },
  ],
};
const ALL_BUILT_INS = { ...OTHER_BUILT_INS, stripCacheControlScope: STRIP_RULES, webSearch: WEB_RULES };

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sail-proxy-litmus-')));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

let copies = 0;
function makeCopy(configText) {
  const home = path.join(scratch, `copy-${++copies}`);
  const root = path.join(home, 'gateway');
  fs.mkdirSync(home);
  // Node 20's cpSync gives the filter Windows long paths (\\?\C:\...): compared without that prefix.
  fs.cpSync(bundleRoot, root, { recursive: true, filter: source => path.relative(bundleRoot, source.replace(/^\\\\\?\\/, '')) !== 'node_modules' });
  fs.symlinkSync(path.join(bundleRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const configFile = path.join(home, 'api_config.json');
  if (configText) fs.writeFileSync(configFile, configText);
  const srcDir = path.join(root, srcRelative);
  return { home, root, srcDir, plugins: path.join(srcDir, 'plugins'), configFile, sourceFolder: path.join(home, 'plugins') };
}

function drive(copy, input) {
  // Nothing of the developer's environment reaches the child: no proxy, no SAP credentials, no real HOME.
  const env = buildGatewayEnv(
    { PATH: process.env.PATH, HOME: copy.home, USERPROFILE: copy.home, HOSTNAME: 'litmus-test', METADATA_ENCRYPTION_KEY: 'a'.repeat(64) },
    {},
    copy.configFile,
  );
  const run = spawnSync(process.execPath, [DRIVER, JSON.stringify({ srcDir: copy.srcDir, ...input })], {
    cwd: copy.root, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
  });
  const line = (run.stdout || '').split('\n').find(text => text.startsWith('RESULT '));
  if (!line) throw new Error(`the driver printed no result (status ${run.status}): ${String(run.stderr).slice(-1500)}`);
  const result = JSON.parse(line.slice('RESULT '.length));
  if (result.driverError) throw new Error(result.driverError);
  assert.deepStrictEqual(result.lookups, [], 'the driver tried to look up a host name');
  return result;
}

function packagePlugin(dir, out, ...extra) {
  execFileSync(process.execPath, [TOOL, '--dir', dir, '--out', out, ...extra], { cwd: scratch, encoding: 'utf8', stdio: 'pipe' });
  return out;
}

function installZip(copy, sourceDir, ...extra) {
  fs.mkdirSync(copy.sourceFolder, { recursive: true });
  packagePlugin(sourceDir, path.join(copy.sourceFolder, 'plugin.zip'), ...extra);
  const result = drive(copy, { op: 'sync', sourceFolder: copy.sourceFolder });
  assert.strictEqual(result.error, undefined, `sync error: ${result.error}`);
  assert.strictEqual(result.listFailed, undefined, `sync list failed: ${result.listFailed}`);
  assert.ok(result.changed, 'the sync changed nothing');
  assert.deepStrictEqual(result.plugins.map(p => p.state), ['installed'], JSON.stringify(result.plugins));
}

const rowOf = (result, source) => result.report.find(row => row.source === source);

function assertHealthyRow(result, source, kind, rules) {
  const row = rowOf(result, source);
  assert.ok(row, `no load report row for ${source}: ${JSON.stringify(result.report.map(r => r.source))}`);
  assert.strictEqual(row.error, undefined, `${source} failed: ${row.error}`);
  assert.strictEqual(row.kind, kind);
  assert.deepStrictEqual(row.rules, rules);
}

/** Exactly the built-ins, each as it shipped: a stale compiled top-level entry would be ignored, a stale folder would show here. */
function assertBuiltInsAsShipped(result, except = []) {
  for (const row of result.report) {
    if (except.includes(row.source)) continue;
    assert.strictEqual(row.kind, 'shipped', `${row.source} is ${row.kind}`);
    assert.strictEqual(row.error, undefined, `${row.source} failed: ${row.error}`);
    assert.deepStrictEqual(row.rules, ALL_BUILT_INS[row.source], `unexpected rules from ${row.source}`);
  }
  assert.deepStrictEqual(result.report.map(row => row.source).sort(), Object.keys(ALL_BUILT_INS).sort());
}

// The sample requests, run through the handlers of the shipped and of the installed plugin alike.
const scoped = text => ({ type: 'text', text, cache_control: { type: 'ephemeral', scope: 'global' } });
const stripRequests = () => ({
  strip: {
    rule: 'stripCacheControlScope',
    strategy: 'before',
    body: {
      system: [scoped('system text')],
      messages: [{ role: 'user', content: [scoped('user text')] }],
      tools: [{ name: 'a_tool', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', scope: 'global' } }],
    },
  },
});
const unscoped = text => ({ type: 'text', text, cache_control: { type: 'ephemeral' } });
const STRIP_EXPECTED = {
  returned: { stop: false },
  body: {
    system: [unscoped('system text')],
    messages: [{ role: 'user', content: [unscoped('user text')] }],
    tools: [{ name: 'a_tool', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
  },
};

const webBody = () => ({
  tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  messages: [{ role: 'user', content: 'What is new?' }],
});
const webToolUse = { type: 'tool_use', id: 'toolu_mock', name: 'web_search', input: { query: 'what is new' } };
const webRequests = () => ({
  before: { rule: 'webSearchPlugin', strategy: 'before', body: webBody() },
  pendingSearch: {
    rule: 'webSearchPlugin',
    strategy: 'before',
    body: { ...webBody(), messages: [...webBody().messages, { role: 'assistant', content: [webToolUse] }] },
  },
  after: {
    rule: 'webSearchPlugin',
    strategy: 'after',
    body: webBody(),
    upstreamResponse: { role: 'assistant', content: [webToolUse], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 } },
  },
});

let failed = false;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${name}`);
    console.error(`  ${String(error.stack || error.message).slice(0, 2000)}`);
  }
}

const CORE_IMPORTERS = [path.join('services', 'configService.js'), path.join('services', 'awsBedrockService.js'), path.join('upstreams', 'messagesDispatch.js')];
const FOLDER_HELPERS = ['webSearchTool.js', 'searchCap.js', 'anthropicWebSearchStream.js'].map(file => path.join('pluginSupport', 'webSearch', file));

const templateConfig = () => fs.readFileSync(path.join(packageRoot, 'dist', 'templates', 'api_config.template.json'), 'utf8');
const shippedPlugins = makeCopy().plugins; // the untouched source of every package below
let shipped = null;
check('every built-in loads from a folder as shipped, with the rule ids it always had', () => {
  shipped = drive(makeCopy(), { op: 'load', requests: { ...stripRequests(), ...webRequests() }, modules: [...CORE_IMPORTERS, ...FOLDER_HELPERS] });
  assertBuiltInsAsShipped(shipped);
});

check('a reload keeps every built-in healthy, and the hosted tools registered', () => {
  assert.deepStrictEqual(shipped.reloaded, shipped.report);
  assert.deepStrictEqual(shipped.hostedTools, ['web_search', 'file_search']);
});

check('stripCacheControlScope, shape: the handler strips the scope', () => {
  assert.deepStrictEqual(shipped.handlers.strip, STRIP_EXPECTED);
});

check('webSearch, shape: the handlers reach the mock upstream and the helpers core imports resolve', () => {
  assert.ok(shipped.calls.includes('POST /v2/inference/deployments/mock-sonar/chat/completions'), JSON.stringify(shipped.calls));
  assert.ok(shipped.handlers.after.returned.content[0].text.includes('[Mock Result](https://example.invalid/mock)'), JSON.stringify(shipped.handlers.after));
  assert.ok(JSON.stringify(shipped.handlers.pendingSearch.body.messages).includes('Mock Result'), 'the pending search result was not injected');
  for (const file of [...CORE_IMPORTERS, ...FOLDER_HELPERS]) assert.strictEqual(shipped.resolved[file], true, `${file} did not resolve`);
});

check('stripCacheControlScope, zip: deleted from a copy and installed by the real sync, it behaves the same', () => {
  const copy = makeCopy();
  fs.rmSync(path.join(copy.plugins, 'stripCacheControlScope'), { recursive: true });
  installZip(copy, path.join(shippedPlugins, 'stripCacheControlScope'));
  const installedDir = path.join(copy.plugins, 'stripCacheControlScope');
  assert.ok(fs.existsSync(path.join(installedDir, '.installed.json')), 'no marker');
  assert.ok(!fs.existsSync(path.join(installedDir, 'index.d.ts')), 'the declaration file was packaged');
  const result = drive(copy, { op: 'load', requests: stripRequests() });
  assertHealthyRow(result, 'stripCacheControlScope', 'installed', STRIP_RULES);
  assert.ok(!result.report.some(row => row.error), JSON.stringify(result.report.filter(row => row.error)));
  assert.deepStrictEqual(result.handlers.strip, shipped.handlers.strip);
});

for (const [id, rules] of Object.entries(OTHER_BUILT_INS)) {
  check(`${id}, zip: deleted from a copy and installed by the real sync, it loads with the same rules and survives a reload`, () => {
    const copy = makeCopy();
    fs.rmSync(path.join(copy.plugins, id), { recursive: true });
    installZip(copy, path.join(shippedPlugins, id));
    const result = drive(copy, { op: 'load' });
    assertHealthyRow(result, id, 'installed', rules);
    assertBuiltInsAsShipped(result, [id]);
    assert.deepStrictEqual(result.reloaded, result.report);
    assert.deepStrictEqual(result.hostedTools, shipped.hostedTools);
  });
}

// The folder holds nothing core needs: forced masking keeps its guarantee without it.
const ADDRESS = 'someone.invented@example.com';
const maskedRequest = { model: 'anthropic--claude-4-sonnet--deployed', max_tokens: 64, messages: [{ role: 'user', content: `Write to ${ADDRESS} today.` }] };
let maskedByShipped = null;
check('pseudonymization, shape: a forced request reaches the upstream masked and comes back restored', () => {
  maskedByShipped = drive(makeCopy(templateConfig()), { op: 'request', messagesRequest: maskedRequest });
  assert.strictEqual(maskedByShipped.status, 200, JSON.stringify(maskedByShipped.body));
  assert.ok(maskedByShipped.upstreamBodies.length > 0, 'nothing reached the upstream');
  assert.ok(!maskedByShipped.upstreamBodies.join('').includes(ADDRESS), 'the address reached the upstream');
  assert.ok(JSON.stringify(maskedByShipped.body.content).includes(ADDRESS), JSON.stringify(maskedByShipped.body));
});

check('pseudonymization, zip: the same forced request masks and restores the same', () => {
  const copy = makeCopy(templateConfig());
  fs.rmSync(path.join(copy.plugins, 'pseudonymization'), { recursive: true });
  installZip(copy, path.join(shippedPlugins, 'pseudonymization'));
  const result = drive(copy, { op: 'request', messagesRequest: maskedRequest });
  assertHealthyRow(result, 'pseudonymization', 'installed', OTHER_BUILT_INS.pseudonymization);
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.upstreamBodies.length > 0, 'nothing reached the upstream');
  assert.ok(!result.upstreamBodies.join('').includes(ADDRESS), 'the address reached the upstream');
  assert.deepStrictEqual(result.body.content, maskedByShipped.body.content);
});

check('pseudonymization, folder gone: a forced request is refused and nothing reaches the upstream', () => {
  const copy = makeCopy(templateConfig());
  fs.rmSync(path.join(copy.plugins, 'pseudonymization'), { recursive: true });
  const result = drive(copy, { op: 'request', messagesRequest: maskedRequest });
  assert.strictEqual(result.status, 503, JSON.stringify(result.body));
  assert.ok(JSON.stringify(result.body).includes('pseudonymization_hook_missing'), JSON.stringify(result.body));
  assert.deepStrictEqual(result.upstreamBodies, []);
});

check('webSearch, zip: deleted from a copy and installed by the real sync, its handlers give the same result', () => {
  const copy = makeCopy();
  fs.rmSync(path.join(copy.plugins, 'webSearch'), { recursive: true });
  installZip(copy, path.join(shippedPlugins, 'webSearch'));
  const result = drive(copy, { op: 'load', requests: webRequests(), modules: [...CORE_IMPORTERS, ...FOLDER_HELPERS] });
  assertHealthyRow(result, 'webSearch', 'installed', WEB_RULES);
  assert.ok(!result.report.some(row => row.error), JSON.stringify(result.report.filter(row => row.error)));
  assert.ok(result.calls.includes('POST /v2/inference/deployments/mock-sonar/chat/completions'), JSON.stringify(result.calls));
  for (const name of ['before', 'pendingSearch', 'after']) assert.deepStrictEqual(result.handlers[name], shipped.handlers[name], name);
  for (const file of [...CORE_IMPORTERS, ...FOLDER_HELPERS]) assert.strictEqual(result.resolved[file], true, `${file} did not resolve`);
  assertBuiltInsAsShipped(result, ['webSearch']);
});

const messagesRequest = {
  model: 'anthropic--claude-4-sonnet--deployed',
  max_tokens: 64,
  ...webBody(),
};

let throughShipped = null;
check('webSearch, shape: a request through the running gateway searches against the mock upstream', () => {
  throughShipped = drive(makeCopy(templateConfig()), { op: 'request', messagesRequest });
  assert.strictEqual(throughShipped.status, 200, JSON.stringify(throughShipped.body));
  assert.ok(JSON.stringify(throughShipped.body.content).includes('[Mock Result](https://example.invalid/mock)'), JSON.stringify(throughShipped));
  assert.ok(throughShipped.calls.includes('POST /v2/inference/deployments/mock-sonar/chat/completions'), JSON.stringify(throughShipped.calls));
});

check('webSearch, zip: the same request through the running gateway gives the same response', () => {
  const copy = makeCopy(templateConfig());
  fs.rmSync(path.join(copy.plugins, 'webSearch'), { recursive: true });
  installZip(copy, path.join(shippedPlugins, 'webSearch'));
  const result = drive(copy, { op: 'request', messagesRequest });
  assertHealthyRow(result, 'webSearch', 'installed', WEB_RULES);
  assert.strictEqual(result.status, throughShipped.status);
  assert.deepStrictEqual(result.body, throughShipped.body);
  assert.ok(result.calls.includes('POST /v2/inference/deployments/mock-sonar/chat/completions'), JSON.stringify(result.calls));
});

check('sample plugin: registers, getPluginSettings merges, the non-JavaScript file is on disk beside it', () => {
  const copy = makeCopy(templateConfig());
  const config = JSON.parse(fs.readFileSync(copy.configFile, 'utf8'));
  config.api_config.plugins = { samplePlugin: { greeting: 'hi' } };
  fs.writeFileSync(copy.configFile, JSON.stringify(config));
  installZip(copy, SAMPLE_DIR);
  assert.ok(fs.existsSync(path.join(copy.plugins, 'samplePlugin', 'note.txt')), 'note.txt is not on disk');
  const result = drive(copy, {
    op: 'load',
    settingsFor: 'samplePlugin',
    requests: { sample: { rule: 'samplePlugin', strategy: 'before', body: {} } },
  });
  assertHealthyRow(result, 'samplePlugin', 'installed', [{ id: 'samplePlugin', strategy: 'before' }]);
  assert.deepStrictEqual(result.settings, { greeting: 'hi', retries: 3 });
  assert.strictEqual(result.handlers.sample.body.sampleNote, 'A note read from a file inside the plugin folder.');
});

// The packaging tool, on a throwaway folder.
function toolFolder(extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'tool-'));
  const files = {
    'manifest.json': JSON.stringify({ id: 'toolSample', version: '1.0.0', runtime: 'node', gateway: '*', help: { en: { summary: 'A sample' } } }),
    'index.js': 'module.exports = [];\n',
    'lib/helper.js': 'exports.x = 1;\n',
    ...extraFiles,
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const zipNames = zip => Object.keys(require(path.join(bundleRoot, 'node_modules', 'fflate')).unzipSync(fs.readFileSync(zip))).sort();
const zipManifest = zip => JSON.parse(Buffer.from(require(path.join(bundleRoot, 'node_modules', 'fflate')).unzipSync(fs.readFileSync(zip))['manifest.json']).toString('utf8'));

check('package-plugin strips declarations, source maps and the install marker, and keeps the rest', () => {
  const out = path.join(scratch, 'nested', 'folder', 'strip.zip');
  packagePlugin(toolFolder({
    'index.d.ts': 'export {};\n',
    'lib/helper.d.ts': 'export {};\n',
    'index.js.map': '{}',
    '.installed.json': '{}',
    '.DS_Store': 'junk',
    'data/.DS_Store': 'junk',
    'data/notes ü.txt': 'kept\n',
  }), out);
  assert.deepStrictEqual(zipNames(out), ['data/notes ü.txt', 'index.js', 'lib/helper.js', 'manifest.json']);
  assert.strictEqual(zipManifest(out).id, 'toolSample');
});

check('package-plugin --id overrides the id in the zip only', () => {
  const dir = toolFolder();
  const out = path.join(scratch, 'override.zip');
  packagePlugin(dir, out, '--id', 'otherId');
  assert.strictEqual(zipManifest(out).id, 'otherId');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).id, 'toolSample');
});

for (const [name, make, extra] of [
  ['TypeScript source', () => toolFolder({ 'lib/source.ts': 'export {};\n' }), []],
  ['node_modules', () => toolFolder({ 'node_modules/dep/index.js': '\n' }), []],
  ['a missing entry', () => { const dir = toolFolder(); fs.rmSync(path.join(dir, 'index.js')); return dir; }, []],
  ['an invalid manifest', () => toolFolder({ 'manifest.json': '{"id":"x"}' }), []],
  ['an invalid --id', () => toolFolder(), ['--id', 'not/valid']],
  // Windows lets only Developer Mode or an administrator create symlinks: no fixture there (null).
  ['a symlink', () => {
    const dir = toolFolder();
    try { fs.symlinkSync(path.join(dir, 'index.js'), path.join(dir, 'link.js')); } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') return null;
      throw error;
    }
    return dir;
  }, []],
]) {
  check(`package-plugin refuses ${name} and writes no zip`, () => {
    const out = path.join(scratch, `refused-${Math.random().toString(36).slice(2)}.zip`);
    const dir = make();
    if (dir === null) return console.log(`# skipped: this account cannot create ${name} on Windows`);
    const run = spawnSync(process.execPath, [TOOL, '--dir', dir, '--out', out, ...extra], { encoding: 'utf8' });
    assert.notStrictEqual(run.status, 0, 'the tool exited 0');
    assert.ok(run.stderr.trim().length > 0 && !run.stderr.includes('Cannot find module'), `no reason given: ${run.stderr}`);
    assert.ok(!fs.existsSync(out), 'a zip was written');
  });
}

check('package-plugin without --dir or --out explains its usage', () => {
  const run = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' });
  assert.notStrictEqual(run.status, 0);
  assert.match(run.stderr, /--dir/);
});

console.log(failed ? '\nThe plugin litmus failed' : '\nThe plugin litmus passed');
process.exit(failed ? 1 : 0);
