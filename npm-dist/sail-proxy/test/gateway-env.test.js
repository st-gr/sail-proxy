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
