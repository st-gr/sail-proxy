#!/usr/bin/env node
// The standalone CLI is the lite gateway: it starts the gateway with OCR, vision transcription and
// legacy .doc conversion switched off, and neither the shell nor the user's .env can turn them
// back on - not even through dotenv's own DOTENV_CONFIG_* options, which the gateway's
// `import 'dotenv/config'` reads.
// Prerequisites: `npm run build:local && npm run bundle` (the last check runs the bundled gateway's
// own dotenv, OCR, vision and .doc switches, from the CLI's spawn cwd).
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { buildGatewayEnv, LITE_GATEWAY_ENV } = require(path.resolve(__dirname, '..', 'dist', 'utils', 'gateway-env.js'));
const { getGatewayPath, getGatewayCwd } = require(path.resolve(__dirname, '..', 'dist', 'utils', 'paths.js'));
let f = 0;
function check(name, fn){ try { fn(); console.log('ok - '+name); } catch(e){ f++; console.error('not ok - '+name+'\n  '+e.message); } }

check('the lite gateway switches OCR off', () => assert.strictEqual(LITE_GATEWAY_ENV.FILE_SEARCH_OCR, 'off'));
check('the lite gateway switches vision transcription off', () => assert.strictEqual(LITE_GATEWAY_ENV.FILE_SEARCH_VISION, 'off'));
check('the lite gateway switches legacy .doc conversion off', () => assert.strictEqual(LITE_GATEWAY_ENV.FILE_SEARCH_DOC, 'off'));
check('the lite gateway switches log shipping off', () => assert.strictEqual(LITE_GATEWAY_ENV.GATEWAY_LOG_SHIPPING, 'off'));
// The payload cleanup limits are defaults, not forced: 0 (no cleanup) unless the user sets them.
check('without a value of the user, the gateway gets no payload cleanup (both limits 0)', () => {
  const env = buildGatewayEnv({ PATH: '/usr/bin' }, { PORT: '3001' }, '/cfg/api_config.json');
  assert.strictEqual(env.PAYLOAD_LOG_RETENTION_HOURS, '0');
  assert.strictEqual(env.PAYLOAD_LOG_MAX_MB, '0');
});
check("the payload cleanup limits of the CLI's .env reach the gateway", () => {
  const env = buildGatewayEnv({ PATH: '/usr/bin' }, { PAYLOAD_LOG_RETENTION_HOURS: '72', PAYLOAD_LOG_MAX_MB: '512' }, '/cfg/api_config.json');
  assert.strictEqual(env.PAYLOAD_LOG_RETENTION_HOURS, '72');
  assert.strictEqual(env.PAYLOAD_LOG_MAX_MB, '512');
});
check('the payload cleanup limits of the shell reach the gateway', () => {
  const env = buildGatewayEnv({ PATH: '/usr/bin', PAYLOAD_LOG_RETENTION_HOURS: '24', PAYLOAD_LOG_MAX_MB: '256' }, {}, '/cfg/api_config.json');
  assert.strictEqual(env.PAYLOAD_LOG_RETENTION_HOURS, '24');
  assert.strictEqual(env.PAYLOAD_LOG_MAX_MB, '256');
});
// The CLI's .env parser (dotenv.parse) hands over `PAYLOAD_LOG_MAX_MB=` as '' (and trims spaces); the shell can
// pass whitespace. The gateway would read such a value, or a typo, as its own defaults (48 h, 1,024 MB).
check('an empty, blank, non-numeric or negative payload limit keeps the CLI default 0', () => {
  for (const bad of ['', '   ', 'abc', '-5']) {
    const fromEnvFile = buildGatewayEnv({ PATH: '/usr/bin' }, { PAYLOAD_LOG_RETENTION_HOURS: bad, PAYLOAD_LOG_MAX_MB: bad }, '/cfg/api_config.json');
    assert.strictEqual(fromEnvFile.PAYLOAD_LOG_RETENTION_HOURS, '0', JSON.stringify(bad));
    assert.strictEqual(fromEnvFile.PAYLOAD_LOG_MAX_MB, '0', JSON.stringify(bad));
    const fromShell = buildGatewayEnv({ PATH: '/usr/bin', PAYLOAD_LOG_RETENTION_HOURS: bad, PAYLOAD_LOG_MAX_MB: bad }, {}, '/cfg/api_config.json');
    assert.strictEqual(fromShell.PAYLOAD_LOG_RETENTION_HOURS, '0', JSON.stringify(bad));
    assert.strictEqual(fromShell.PAYLOAD_LOG_MAX_MB, '0', JSON.stringify(bad));
  }
});
check('a non-negative number as payload limit reaches the gateway as the user wrote it', () => {
  for (const good of ['24', '0', '1.5']) {
    const env = buildGatewayEnv({ PATH: '/usr/bin' }, { PAYLOAD_LOG_RETENTION_HOURS: good, PAYLOAD_LOG_MAX_MB: good }, '/cfg/api_config.json');
    assert.strictEqual(env.PAYLOAD_LOG_RETENTION_HOURS, good);
    assert.strictEqual(env.PAYLOAD_LOG_MAX_MB, good);
  }
});
// Payload files (PAYLOAD_LOGGING_ENABLED) go to the CLI's data folder, next to logs/gateway.log: the
// installed package is replaced on every upgrade and may not be writable.
check('payload files go to logs/payloads in the CLI data folder', () => {
  const env = buildGatewayEnv({ PATH: '/usr/bin' }, {}, path.join('/home/jane/.sail-proxy', 'api_config.json'));
  assert.strictEqual(env.PAYLOAD_LOG_DIR, path.join('/home/jane/.sail-proxy', 'logs', 'payloads'));
});
check("the user's own PAYLOAD_LOG_DIR (shell or .env) wins", () => {
  assert.strictEqual(buildGatewayEnv({ PATH: '/usr/bin', PAYLOAD_LOG_DIR: '/data/p' }, {}, '/cfg/api_config.json').PAYLOAD_LOG_DIR, '/data/p');
  assert.strictEqual(buildGatewayEnv({ PATH: '/usr/bin' }, { PAYLOAD_LOG_DIR: '/data/q' }, '/cfg/api_config.json').PAYLOAD_LOG_DIR, '/data/q');
});
check('a blank PAYLOAD_LOG_DIR keeps the data folder (the gateway would fall back to its own install folder)', () => {
  const env = buildGatewayEnv({ PATH: '/usr/bin' }, { PAYLOAD_LOG_DIR: '  ' }, path.join('/cfg', 'api_config.json'));
  assert.strictEqual(env.PAYLOAD_LOG_DIR, path.join('/cfg', 'logs', 'payloads'));
});
check('every other lite setting stays forced when the shell and the .env ask otherwise', () => {
  const asked = { FILE_SEARCH_OCR: 'on', FILE_SEARCH_VISION: 'on', FILE_SEARCH_DOC: 'on', GATEWAY_LOG_SHIPPING: 'on' };
  const env = buildGatewayEnv({ PATH: '/usr/bin', ...asked }, asked, '/cfg/api_config.json');
  assert.deepStrictEqual(Object.keys(LITE_GATEWAY_ENV).sort(), ['FILE_SEARCH_DOC', 'FILE_SEARCH_OCR', 'FILE_SEARCH_VISION', 'GATEWAY_LOG_SHIPPING']);
  for (const [key, value] of Object.entries(LITE_GATEWAY_ENV)) assert.strictEqual(env[key], value, key);
});
check('OCR, vision and .doc stay off when the shell and the .env ask for them', () => {
  const env = buildGatewayEnv(
    { FILE_SEARCH_OCR: 'auto', FILE_SEARCH_VISION: 'auto', FILE_SEARCH_DOC: 'auto', PATH: '/usr/bin' },
    { FILE_SEARCH_OCR: 'on', FILE_SEARCH_VISION: 'on', FILE_SEARCH_DOC: 'on', PORT: '3001' }, '/cfg/api_config.json');
  assert.strictEqual(env.FILE_SEARCH_OCR, 'off');
  assert.strictEqual(env.FILE_SEARCH_VISION, 'off');
  assert.strictEqual(env.FILE_SEARCH_DOC, 'off');
});
check('the rest of the env is passed on as before', () => {
  const env = buildGatewayEnv({ PATH: '/usr/bin', NODE_ENV: 'development' }, { PORT: '3001' }, '/cfg/api_config.json');
  assert.strictEqual(env.PATH, '/usr/bin');
  assert.strictEqual(env.PORT, '3001');
  assert.strictEqual(env.CONFIG_FILE_PATH, '/cfg/api_config.json');
  assert.strictEqual(env.NODE_ENV, 'production');
});
check('installed plugins come from the plugins folder beside the config file', () => {
  const env = buildGatewayEnv({ PLUGINS_SOURCE_DIR: '/shell' }, { PLUGINS_SOURCE_DIR: '/dotenv' }, path.join('/cfg', 'api_config.json'));
  assert.strictEqual(env.PLUGINS_SOURCE_DIR, path.join('/cfg', 'plugins'));
});
check('LITE_GATEWAY_ENV cannot be changed at runtime', () => assert.ok(Object.isFrozen(LITE_GATEWAY_ENV)));
check("dotenv's DOTENV_CONFIG_* options from the shell or the .env never reach the gateway", () => {
  const env = buildGatewayEnv(
    { PATH: '/usr/bin', DOTENV_CONFIG_OVERRIDE: 'true', DOTENV_CONFIG_PATH: '/x/.env', dotenv_config_debug: 'true' },
    { DOTENV_CONFIG_OVERRIDE: 'false', DOTENV_CONFIG_ENCODING: 'latin1' },
    '/cfg/api_config.json');
  assert.deepStrictEqual(Object.keys(env).filter(k => /^dotenv_config_/i.test(k)), []);
  assert.strictEqual(env.FILE_SEARCH_OCR, 'off');
  assert.strictEqual(env.FILE_SEARCH_VISION, 'off');
  assert.strictEqual(env.FILE_SEARCH_DOC, 'off');
});

// End to end against the gateway the CLI really spawns: its own dotenv, its own OCR switch, with a
// tesseract (eng) first on PATH and a .env that tries DOTENV_CONFIG_OVERRIDE to set auto.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lite-ocr-'));
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'tesseract'), '#!/bin/sh\nprintf "List of available languages (1):\\neng\\n"\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'antiword'), '#!/bin/sh\necho converted\n', { mode: 0o755 });
const hostileEnvFile = path.join(tmp, 'hostile.env');
fs.writeFileSync(hostileEnvFile, 'FILE_SEARCH_OCR=auto\nFILE_SEARCH_VISION=auto\nFILE_SEARCH_DOC=auto\n');
const ocrModule = path.join(path.dirname(getGatewayPath()), 'fileSearch', 'extractors', 'ocrAvailability.js');
const visionModule = path.join(path.dirname(getGatewayPath()), 'fileSearch', 'visionTranscriber.js');
const docModule = path.join(path.dirname(getGatewayPath()), 'fileSearch', 'extractors', 'legacyDoc.js');
const probe = `require('dotenv/config');
const m = require(${JSON.stringify(ocrModule)});
const v = require(${JSON.stringify(visionModule)});
const d = require(${JSON.stringify(docModule)});
m.getOcrStatus().then(s => { process.stdout.write('RESULT ' + JSON.stringify({ env: process.env.FILE_SEARCH_OCR, enabled: s.enabled, vision: v.visionSwitchedOff(), doc: d.isLegacyDocEnabled() }) + '\\n'); process.exit(0); });`;
function runGateway(env) {
  const out = execFileSync(process.execPath, ['-e', probe], { cwd: getGatewayCwd(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.split('\n').find(l => l.startsWith('RESULT ')).slice(7));
}
const shell = {
  ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  DOTENV_CONFIG_OVERRIDE: 'true', DOTENV_CONFIG_PATH: hostileEnvFile, CONFIG_FILE_PATH: path.join(tmp, 'api_config.json'),
};
if (!fs.existsSync(ocrModule) || !fs.existsSync(visionModule) || !fs.existsSync(docModule)) {
  f++; console.error(`not ok - ${ocrModule}, ${visionModule} or ${docModule} is missing; run "npm run build:local && npm run bundle" first`);
} else {
  check('control: without the CLI env, that .env would switch OCR, vision and .doc on in the gateway', () => {
    // The fake tesseract/antiword are shell scripts; the gateway runs them without a shell, which on
    // Windows finds .exe files only. The next check still pins the switches there.
    if (process.platform === 'win32') return console.log('# skipped: the fake tesseract/antiword need a POSIX shell');
    assert.deepStrictEqual(
      runGateway({ ...shell, FILE_SEARCH_OCR: 'off', FILE_SEARCH_VISION: 'off', FILE_SEARCH_DOC: 'off' }),
      { env: 'auto', enabled: true, vision: null, doc: true });
  });
  check('the spawned gateway keeps OCR, vision and .doc off with tesseract and antiword installed and DOTENV_CONFIG_OVERRIDE in the shell', () => {
    const env = buildGatewayEnv(shell, { DOTENV_CONFIG_OVERRIDE: 'true', DOTENV_CONFIG_PATH: hostileEnvFile }, shell.CONFIG_FILE_PATH);
    assert.deepStrictEqual(runGateway(env), { env: 'off', enabled: false, vision: 'switched off (FILE_SEARCH_VISION=off)', doc: false });
  });
}
fs.rmSync(tmp, { recursive: true, force: true });

process.exit(f ? 1 : 0);
