#!/usr/bin/env node
// node stack/github-dex.mjs: renders out/github-dex.config.yaml (mode 600) for the demo stack's GitHub sign-in:
// the local Dex config (docker/dex.config.yaml, local accounts kept) plus a GitHub connector built from
// out/github-oauth.env (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_ORG, GITHUB_ADMIN_TEAM, GITHUB_USER_TEAM).
// stack/compose.github.yml mounts the result; the OAuth App's callback is http://localhost:8080/dex/callback.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

export function withGithub(dexYaml, env) {
  if (/^connectors:/m.test(dexYaml)) throw new Error('the Dex config already has connectors: render from the local sign-in config');
  for (const k of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_ORG', 'GITHUB_ADMIN_TEAM']) if (!env[k]) throw new Error(`out/github-oauth.env: ${k} is missing`);
  return `${dexYaml.replace(/\n*$/, '\n')}
# The demo stack's GitHub sign-in (stack/github-dex.mjs); the local accounts above stay available.
connectors:
- type: github
  id: github
  name: GitHub
  config:
    clientID: ${q(env.GITHUB_CLIENT_ID)}
    clientSecret: ${q(env.GITHUB_CLIENT_SECRET)}
    redirectURI: http://localhost:8080/dex/callback
    orgs:
    - name: ${q(env.GITHUB_ORG)}
      teams:
      - ${q(env.GITHUB_ADMIN_TEAM)}
      - ${q(env.GITHUB_USER_TEAM || 'users')}
    teamNameField: slug
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    const env = parseEnv(readFileSync(join(root, 'screencast', 'out', 'github-oauth.env'), 'utf8'));
    const out = join(root, 'screencast', 'out', 'github-dex.config.yaml');
    writeFileSync(out, withGithub(readFileSync(join(root, 'docker', 'dex.config.yaml'), 'utf8'), env), { mode: 0o600 });
    console.log('wrote screencast/out/github-dex.config.yaml');
  } catch (e) { console.error(e.code === 'ENOENT' ? `missing ${e.path.replace(root + '/', '')}` : e.message); process.exit(1); }
}
