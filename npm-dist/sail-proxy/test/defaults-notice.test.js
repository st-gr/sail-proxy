#!/usr/bin/env node
// defaultsNotice: after an update, or with a config an older version wrote, the start says once
// which settings of this version's default configuration the user's api_config.json lacks.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultsNotice, checkDefaultsNotice } = require('../dist/utils/defaultsNotice');

const ROOT = path.join(__dirname, '..');
const SHIPPED = path.join(ROOT, 'dist', 'templates', 'api_config.template.json');
const clone = (value) => JSON.parse(JSON.stringify(value));
const RENAMES = '{"advanced-tool-use-2025-11-20":"tool-search-tool-2025-10-19"}';

/** A config folder holding `config` as api_config.json (a string is written as it is). */
function folderWith(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-defaults-'));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, 'api_config.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  }
  return dir;
}
const recordOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'defaults-check.json'), 'utf-8'));
const hasRecord = (dir) => fs.existsSync(path.join(dir, 'defaults-check.json'));

/** The shipped configuration as a version before the tool search beta wrote it. */
function writtenBeforeBetaRenames() {
  const config = JSON.parse(fs.readFileSync(SHIPPED, 'utf-8'));
  const anthropic = config.api_config.providers.anthropic;
  delete anthropic.beta_header_renames;
  anthropic.supported_beta_headers = anthropic.supported_beta_headers.filter((flag) => flag !== 'tool-search-tool-2025-10-19');
  return config;
}

// The comparison rules are the cockpit's: one module, copied, and the copies stay byte-identical.
const cockpitRules = path.join(ROOT, '..', '..', 'services', 'admin', 'app', 'config-app', 'webapp', 'model', 'shippedDefaults.ts');
assert.strictEqual(
  fs.readFileSync(path.join(ROOT, 'src', 'utils', 'shippedDefaults.ts'), 'utf-8'),
  fs.readFileSync(cockpitRules, 'utf-8'),
  'npm-dist/sail-proxy/src/utils/shippedDefaults.ts and services/admin/app/config-app/webapp/model/shippedDefaults.ts must stay byte-identical: copy the changed file over the other'
);

// a config an older version wrote (no record yet): the message names what it lacks and both files
let dir = folderWith(writtenBeforeBetaRenames());
let notice = defaultsNotice({ current: '0.13.0', configDir: dir, templatePath: SHIPPED });
assert.ok(notice, 'a config that lacks shipped settings gets a message');
assert.ok(notice.includes('lacks 2 settings'), notice);
assert.ok(notice.includes('providers / anthropic / supported_beta_headers (list entry): "tool-search-tool-2025-10-19"'), notice);
assert.ok(notice.includes(`providers / anthropic / beta_header_renames: ${RENAMES}`), notice);
assert.ok(notice.includes(path.join(dir, 'api_config.json')), notice);
assert.ok(notice.includes(SHIPPED), notice);
assert.deepStrictEqual(recordOf(dir), { version: '0.13.0' });

// the message never changes the user's file
assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'api_config.json'), 'utf-8')), writtenBeforeBetaRenames());

// said once per installed version: the next start of the same version is silent ...
assert.strictEqual(defaultsNotice({ current: '0.13.0', configDir: dir, templatePath: SHIPPED }), null);
// ... and the first start after an update says it again
notice = defaultsNotice({ current: '0.14.0', configDir: dir, templatePath: SHIPPED });
assert.ok(notice && notice.includes('lacks 2 settings'), String(notice));
assert.deepStrictEqual(recordOf(dir), { version: '0.14.0' });

// one missing setting reads as one
const oneMissing = writtenBeforeBetaRenames();
oneMissing.api_config.providers.anthropic.supported_beta_headers.push('tool-search-tool-2025-10-19');
notice = defaultsNotice({ current: '0.13.0', configDir: folderWith(oneMissing), templatePath: SHIPPED });
assert.ok(notice && notice.includes('lacks 1 setting ') && !notice.includes('supported_beta_headers'), String(notice));

// nothing missing: silent, and remembered
dir = folderWith(JSON.parse(fs.readFileSync(SHIPPED, 'utf-8')));
assert.strictEqual(defaultsNotice({ current: '0.13.0', configDir: dir, templatePath: SHIPPED }), null);
assert.deepStrictEqual(recordOf(dir), { version: '0.13.0' });

// a value that only differs is the user's own setting: silent
const ownValues = JSON.parse(fs.readFileSync(SHIPPED, 'utf-8'));
ownValues.api_config.providers.anthropic.beta_header_renames = { 'advanced-tool-use-2025-11-20': 'own-flag', mine: 'other' };
ownValues.api_config.providers.anthropic.supported_beta_headers.unshift('my-own-flag');
assert.strictEqual(defaultsNotice({ current: '0.13.0', configDir: folderWith(ownValues), templatePath: SHIPPED }), null);

// an edited model mapping is the user's own setting too: identified by its provider, not by its values
const ownMapping = JSON.parse(fs.readFileSync(SHIPPED, 'utf-8'));
ownMapping.api_config.providers.openrouter.model_mappings.find((mapping) => mapping.provider === 'Anthropic').max_tokens = 16384;
assert.strictEqual(defaultsNotice({ current: '0.13.0', configDir: folderWith(ownMapping), templatePath: SHIPPED }), null);

// a file without the api_config section lacks all of it, named as one entry
notice = defaultsNotice({ current: '0.13.0', configDir: folderWith({}), templatePath: SHIPPED });
assert.ok(notice && notice.includes('lacks 1 setting ') && notice.includes('  - api_config: {'), String(notice));

// no file, a broken file, a missing default file: silent, no throw, and nothing remembered,
// so the message comes once the file can be read
dir = folderWith(undefined);
assert.strictEqual(defaultsNotice({ current: '0.13.0', configDir: dir, templatePath: SHIPPED }), null);
assert.ok(!hasRecord(dir));
dir = folderWith('{not json');
assert.strictEqual(defaultsNotice({ current: '0.13.0', configDir: dir, templatePath: SHIPPED }), null);
assert.ok(!hasRecord(dir));
dir = folderWith(writtenBeforeBetaRenames());
assert.strictEqual(defaultsNotice({ current: '0.13.0', configDir: dir, templatePath: path.join(dir, 'no-such-template.json') }), null);
assert.ok(!hasRecord(dir));

// a broken record counts as none; a record that cannot be written does not hide the message
dir = folderWith(writtenBeforeBetaRenames());
fs.writeFileSync(path.join(dir, 'defaults-check.json'), '{not json');
assert.ok(defaultsNotice({ current: '0.13.0', configDir: dir, templatePath: SHIPPED }));
dir = folderWith(writtenBeforeBetaRenames());
fs.mkdirSync(path.join(dir, 'defaults-check.json'));
assert.ok(defaultsNotice({ current: '0.13.0', configDir: dir, templatePath: SHIPPED }));

// the installed package: its own version and its shipped default file
const installed = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
dir = folderWith(writtenBeforeBetaRenames());
notice = checkDefaultsNotice({ configDir: dir });
assert.ok(notice && notice.includes('lacks 2 settings') && notice.includes(SHIPPED), String(notice));
assert.deepStrictEqual(recordOf(dir), { version: installed });
assert.strictEqual(checkDefaultsNotice({ configDir: dir }), null);

// settings only Docker and Kyma use (observability.gateway_log and observability.payload_capture) are never named: the standalone CLI ignores them
const shippedConfig = () => JSON.parse(fs.readFileSync(SHIPPED, 'utf-8'));
const dropDockerAndKymaOnly = (cfg) => { delete cfg.api_config.observability.gateway_log; delete cfg.api_config.observability.payload_capture; };
assert.ok(shippedConfig().api_config.observability.gateway_log, 'the shipped default holds observability.gateway_log');
assert.ok(shippedConfig().api_config.observability.payload_capture, 'the shipped default holds observability.payload_capture');
let config = shippedConfig();
dropDockerAndKymaOnly(config);
dir = folderWith(config);
assert.strictEqual(defaultsNotice({ current: '0.13.0', configDir: dir, templatePath: SHIPPED }), null, 'only the Docker/Kyma-only block is missing: no notice');
assert.deepStrictEqual(recordOf(dir), { version: '0.13.0' }, 'and the version is recorded as compared');
config = writtenBeforeBetaRenames();
dropDockerAndKymaOnly(config);
notice = defaultsNotice({ current: '0.13.0', configDir: folderWith(config), templatePath: SHIPPED });
assert.ok(notice && notice.includes('lacks 2 settings') && notice.includes('beta_header_renames'), String(notice));
assert.ok(!notice.includes('gateway_log') && !notice.includes('payload_capture'), notice);
// a missing sibling is still named
config = shippedConfig();
dropDockerAndKymaOnly(config);
delete config.api_config.observability.siem;
notice = defaultsNotice({ current: '0.13.0', configDir: folderWith(config), templatePath: SHIPPED });
assert.ok(notice && notice.includes('lacks 1 setting of') && notice.includes('observability / siem:'), String(notice));
assert.ok(!notice.includes('gateway_log') && !notice.includes('payload_capture'), notice);
// a missing observability parent is reported as one entry; the notice keeps it, without gateway_log in its value
config = shippedConfig();
delete config.api_config.observability;
notice = defaultsNotice({ current: '0.13.0', configDir: folderWith(config), templatePath: SHIPPED });
assert.ok(notice && notice.includes('lacks 1 setting of') && notice.includes('observability: {"pseudonymization"'), String(notice));
assert.ok(!notice.includes('gateway_log') && !notice.includes('payload_capture'), notice);

console.log('defaults-notice: ok');
