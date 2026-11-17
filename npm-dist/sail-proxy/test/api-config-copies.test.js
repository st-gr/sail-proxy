#!/usr/bin/env node
// The gateway's api_config.json is the origin of two shipped copies: the admin service's (the
// default configuration the cockpit compares with, and what Docker and Kyma mount) and the CLI's
// template ("sail-proxy config" copies it, the defaults notice compares with it).
// cli-tools/sync-api-config.js copies it, but only when it is run, so a change to the gateway file
// alone would ship outdated copies.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const GATEWAY_FILE = 'services/gateway/api_config.json';
const COPIES = [
  'services/admin/api_config.json',
  'npm-dist/sail-proxy/src/templates/api_config.template.json',
];

const origin = fs.readFileSync(path.join(REPO, GATEWAY_FILE));
const differing = COPIES.filter((copy) => !fs.readFileSync(path.join(REPO, copy)).equals(origin));
assert.deepStrictEqual(
  differing, [],
  `${differing.join(' and ')} must be byte-identical to ${GATEWAY_FILE}. The gateway file is the origin: `
  + `"git add ${GATEWAY_FILE}", then "node cli-tools/sync-api-config.js" (it does nothing unless one of the copies is staged).`
);

console.log('api-config-copies: ok');
