import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, withGithub } from './github-dex.mjs';

const env = parseEnv('GITHUB_CLIENT_ID=abc\n# note\nGITHUB_CLIENT_SECRET="s3"\nGITHUB_ORG=sap-llm-gateway\nGITHUB_ADMIN_TEAM=admins\n');

test('parseEnv reads KEY=value lines, quotes stripped, comments skipped', () => {
  assert.deepEqual(env, { GITHUB_CLIENT_ID: 'abc', GITHUB_CLIENT_SECRET: 's3', GITHUB_ORG: 'sap-llm-gateway', GITHUB_ADMIN_TEAM: 'admins' });
});

test('withGithub adds a GitHub connector next to the local sign-in, with the demo callback', () => {
  const y = withGithub('issuer: http://localhost:8080/dex\nenablePasswordDB: true\n', env);
  assert.ok(y.startsWith('issuer: http://localhost:8080/dex\nenablePasswordDB: true\n'));
  assert.ok(y.includes('connectors:\n- type: github\n'));
  assert.ok(y.includes('redirectURI: http://localhost:8080/dex/callback'));
  assert.ok(y.includes("- name: 'sap-llm-gateway'") && y.includes("- 'admins'") && y.includes("- 'users'"));
  assert.ok(y.includes("clientSecret: 's3'"));
});

test('withGithub refuses a config that already has connectors or a missing value', () => {
  assert.throws(() => withGithub('connectors:\n- type: ldap\n', env), /already has connectors/);
  assert.throws(() => withGithub('issuer: x\n', { ...env, GITHUB_CLIENT_ID: '' }), /GITHUB_CLIENT_ID/);
});
