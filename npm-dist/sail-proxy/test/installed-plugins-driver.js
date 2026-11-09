// Child process of bundled-plugins.test.js: boots the real bundled gateway entry, the way the CLI
// spawns it, waits until it listens, and prints what happened to the plugins. Not a test by itself.
const fs = require('fs');
const net = require('net');
const path = require('path');

const [entry, ruleId, helperFile] = process.argv.slice(2);
const srcDir = path.dirname(entry);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

(async () => {
  const port = await freePort();
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';

  // Count the loader's calls without changing them; the boot order is what the test pins.
  const loader = require(path.join(srcDir, 'services', 'pluginLoader.js'));
  const counts = { firstLoads: 0, reloads: 0 };
  const realLoadAll = loader.default.loadAll;
  loader.default.loadAll = (...args) => { counts.firstLoads++; return realLoadAll(...args); };
  const realReloadAll = loader.reloadAll;
  loader.reloadAll = (...args) => { counts.reloads++; return realReloadAll(...args); };

  require(entry);

  const deadline = Date.now() + 60_000;
  while (!(await listening(port))) {
    if (Date.now() > deadline) throw new Error('the gateway never listened');
    await new Promise(r => setTimeout(r, 100));
  }

  const hasRule = () => Boolean(loader.getRule(ruleId, 'before'));
  const atListen = { hasRule: hasRule(), loaded: loader.hasLoadedPlugins(), ...counts };

  // The first getConfig() of a request loads plugins if nothing did before.
  const configService = require(path.join(srcDir, 'services', 'configService.js'));
  configService.getConfig();
  const afterConfig = { hasRule: hasRule(), ...counts };
  const report = loader.getLoadReport();
  const settings = configService.getPluginSettings(ruleId);
  const builtIn = Boolean(loader.getRule('pseudonymizationPlugin', 'before'));

  let reloadedFresh = null;
  if (helperFile) {
    fs.writeFileSync(helperFile, "exports.ruleId = 'reloadedRule';\n");
    await configService.reloadPluginModules();
    reloadedFresh = Boolean(loader.getRule('reloadedRule', 'before'));
  }

  process.stdout.write(`RESULT ${JSON.stringify({ atListen, afterConfig, report, settings, builtIn, reloadedFresh })}\n`);
  process.exit(0);
})().catch(error => {
  process.stdout.write(`RESULT ${JSON.stringify({ driverError: String(error && error.stack || error) })}\n`);
  process.exit(1);
});
