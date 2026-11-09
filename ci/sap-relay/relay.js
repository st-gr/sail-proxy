#!/usr/bin/env node
/**
 * Operator script for the SAP AI Core relay used by private CI (see README.md).
 *
 *   node ci/sap-relay/relay.js render [--domain <d>] [--key-file <f>] [--resolver <r>] [--out <dir>]
 *   node ci/sap-relay/relay.js apply | up | down | status | delete   [--out <dir>]
 *
 * render fills the templates from the SAP service key (SAP_AI_CORE_SERVICE_KEY or --key-file) and the
 * cluster's ingress domain (--domain or SAP_RELAY_DOMAIN) into a gitignored directory. Nothing this
 * script prints contains the path key, the relay base, the relay host or the SAP hosts.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const DEFAULT_OUT = path.join(HERE, '.rendered');
const NAMESPACE = 'sap-relay';
const POLICY = 'allowlist-sap-relay';
const WAIT = '--timeout=180s';
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const RENDERED = ['nginx.conf', 'manifests.yaml', 'relay-base.txt'];
// Stands in for the key while templates are filled, so a key can never pose as (or hide) a placeholder.
const KEY_SENTINEL = '\u0000RELAY-KEY\u0000';
const USAGE = 'usage: node ci/sap-relay/relay.js <render|apply|up|down|status|delete> ' +
  '[--domain <d>] [--key-file <f>] [--resolver <r>] [--out <dir>]';

class UserError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw new UserError(`unexpected argument (${USAGE})`);
    opts[m[1]] = m[2] !== undefined ? m[2] : rest[++i];
    if (opts[m[1]] === undefined) throw new UserError(`--${m[1]} needs a value`);
  }
  return { command, opts };
}

/** stderr is captured, not passed through: API errors can echo field values (the relay host, the key). */
function defaultExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const defaultRandomKey = () => crypto.randomBytes(32).toString('base64url');

/** GET a URL; resolves { statusCode }, rejects with an error carrying `code` (never its message is printed). */
function defaultGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve({ statusCode: res.statusCode }); });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

function upstreamHost(value, field) {
  let u;
  try { u = new URL(value); } catch { throw new UserError(`service key: ${field} is not a URL`); }
  if (u.protocol !== 'https:' || !HOST_RE.test(u.host)) throw new UserError(`service key: ${field} is not an https host`);
  return u.host;
}

/** The two SAP hosts from the service key. Parse errors are reported without any of the key's content. */
function readServiceKey(opts, env) {
  let raw;
  if (opts['key-file']) {
    try { raw = fs.readFileSync(opts['key-file'], 'utf8'); } catch { throw new UserError('cannot read --key-file'); }
  } else if (env.SAP_AI_CORE_SERVICE_KEY) {
    raw = env.SAP_AI_CORE_SERVICE_KEY;
  } else {
    throw new UserError('no SAP service key: set SAP_AI_CORE_SERVICE_KEY or pass --key-file');
  }
  let key;
  try { key = JSON.parse(raw); } catch { throw new UserError('the SAP service key is not valid JSON'); }
  if (!key || typeof key.url !== 'string' || !key.serviceurls || typeof key.serviceurls.AI_API_URL !== 'string') {
    throw new UserError('the SAP service key has no url or serviceurls.AI_API_URL');
  }
  return { apiHost: upstreamHost(key.serviceurls.AI_API_URL, 'serviceurls.AI_API_URL'), authHost: upstreamHost(key.url, 'url') };
}

function assertIgnored(out, exec) {
  const parent = path.dirname(out);
  for (const name of RENDERED) {
    try {
      exec('git', ['-C', parent, 'check-ignore', '-q', path.join(out, name)]);
    } catch {
      throw new UserError(`refusing to render: ${display(path.join(out, name))} is not ignored by git`);
    }
  }
}

/** A usable key: base64url of 32 bytes and free of "__" (which the templates use for placeholders). */
const usableKey = (key) => typeof key === 'string' && KEY_RE.test(key) && !key.includes('__');

function existingKey(out) {
  try {
    const key = fs.readFileSync(path.join(out, 'relay-base.txt'), 'utf8').trim().split('/').pop();
    return usableKey(key) ? key : null;
  } catch { return null; }
}

function newKey(randomKey) {
  for (let i = 0; i < 100; i++) {
    const key = randomKey();
    if (usableKey(key)) return key;
  }
  throw new UserError('could not generate a usable path key');
}

/** Fills placeholders; the result is checked for leftovers before the caller inserts the key. */
function fill(template, values) {
  const text = template.replace(/__([A-Z_]+?)__/g, (m, name) => {
    if (!(name in values)) throw new UserError(`template placeholder ${name} has no value`);
    return values[name];
  });
  if (/__[A-Z_]+__/.test(text)) throw new UserError('a placeholder was left unfilled');
  return text;
}

const withKey = (text, key) => text.split(KEY_SENTINEL).join(key);

function display(p) {
  return path.relative(process.cwd(), p) || p;
}

function writePrivate(out, name, content) {
  const file = path.join(out, name);
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function render(opts, env, deps) {
  const out = path.resolve(opts.out || DEFAULT_OUT);
  const domain = opts.domain || env.SAP_RELAY_DOMAIN;
  if (!domain) throw new UserError('no cluster ingress domain: pass --domain or set SAP_RELAY_DOMAIN');
  if (!HOST_RE.test(domain) || domain.includes(':')) throw new UserError('--domain is not a valid DNS name');
  const { apiHost, authHost } = readServiceKey(opts, env);

  let resolver = opts.resolver;
  if (!resolver) {
    try {
      resolver = deps.exec('kubectl', ['-n', 'kube-system', 'get', 'svc', 'kube-dns', '-o', 'jsonpath={.spec.clusterIP}']).trim();
    } catch {
      throw new UserError('could not look up the cluster DNS service; pass --resolver <ip>');
    }
  }
  if (!HOST_RE.test(resolver)) throw new UserError('--resolver is not an IP address or host name');

  assertIgnored(out, deps.exec);
  const key = existingKey(out) || newKey(deps.randomKey);
  const host = `sap-relay.${domain}`;

  const nginx = fill(fs.readFileSync(path.join(HERE, 'nginx.conf.template'), 'utf8'),
    { RESOLVER: resolver, KEY: KEY_SENTINEL, SAP_API_HOST: apiHost, SAP_AUTH_HOST: authHost });
  const embedded = nginx.trimEnd().split('\n').map(l => (l ? '    ' + l : '')).join('\n');
  const manifests = fill(fs.readFileSync(path.join(HERE, 'manifests.yaml.template'), 'utf8'),
    { NGINX_CONF: embedded, KEY: KEY_SENTINEL, RELAY_HOST: host });

  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  writePrivate(out, 'nginx.conf', withKey(nginx, key));
  writePrivate(out, 'manifests.yaml', withKey(manifests, key));
  writePrivate(out, 'relay-base.txt', `https://${host}/${key}\n`);
  deps.log(`rendered 3 files to ${display(out)} (key not shown)`);
  return 0;
}

/** The SAP hosts (and their names without a port) that the rendered nginx.conf forwards to. */
function renderedSapHosts(out) {
  try {
    const conf = fs.readFileSync(path.join(out, 'nginx.conf'), 'utf8');
    const hosts = [...conf.matchAll(/set \$up "([^"]+)";/g)].map(m => m[1]);
    return [...new Set([...hosts, ...hosts.map(h => h.replace(/:\d+$/, ''))])];
  } catch { return []; }
}

/** The rendered key, relay host and SAP hosts, if any, for redacting kubectl's stderr. */
function renderedSecrets(out) {
  let relay = [];
  try {
    const base = new URL(fs.readFileSync(path.join(out, 'relay-base.txt'), 'utf8').trim());
    relay = [[base.pathname.split('/').pop(), '<key>'], [base.host, '<relay-host>'], [base.hostname, '<relay-host>']];
  } catch { /* nothing rendered */ }
  return [...relay, ...renderedSapHosts(out).map(h => [h, '<sap-host>'])].filter(([value]) => value);
}

function redact(text, secrets) {
  return secrets.reduce((t, [value, label]) => t.split(value).join(label), text);
}

function readBase(opts) {
  const file = path.join(path.resolve(opts.out || DEFAULT_OUT), 'relay-base.txt');
  let base;
  try { base = fs.readFileSync(file, 'utf8').trim(); } catch { throw new UserError('nothing rendered yet: run render first'); }
  return base;
}

async function status(opts, deps) {
  const base = readBase(opts);
  try {
    const res = await deps.get(`${base}/healthz`);
    if (res.statusCode === 200) { deps.log('relay: up 200'); return 0; }
    deps.log(`relay: down ${res.statusCode}`);
  } catch (e) {
    deps.log(`relay: down ${(e && e.code) || 'error'}`);
  }
  return 1;
}

/** Runs kubectl and passes on its output (object names and states; never the key, which lives in the Secret). */
function kubectl(deps, ...args) {
  const out = String(deps.exec('kubectl', args) || '').trim();
  if (out) deps.log(out);
}

async function main(argv, env = process.env, deps = {}) {
  deps = { exec: defaultExec, get: defaultGet, randomKey: defaultRandomKey, log: console.log, error: console.error, ...deps };
  let out = DEFAULT_OUT;
  try {
    const { command, opts } = parseArgs(argv);
    out = path.resolve(opts.out || DEFAULT_OUT);
    switch (command) {
      case 'render':
        return render(opts, env, deps);
      case 'apply':
        kubectl(deps, 'apply', '-f', path.join(path.resolve(opts.out || DEFAULT_OUT), 'manifests.yaml'));
        return 0;
      case 'up':
        readBase(opts);
        kubectl(deps, '-n', NAMESPACE, 'scale', 'deploy/sap-relay', '--replicas=1');
        kubectl(deps, '-n', NAMESPACE, 'rollout', 'status', 'deploy/sap-relay', WAIT);
        return status(opts, deps);
      case 'down':
        kubectl(deps, '-n', NAMESPACE, 'scale', 'deploy/sap-relay', '--replicas=0');
        try {
          kubectl(deps, '-n', NAMESPACE, 'wait', '--for=delete', 'pod', '-l', 'app=sap-relay', WAIT);
        } catch (e) {
          // Some kubectl versions fail the wait when no pod matches at all; that is the goal state.
          if (String(deps.exec('kubectl', ['-n', NAMESPACE, 'get', 'pods', '-l', 'app=sap-relay', '-o', 'name']) || '').trim()) throw e;
        }
        return 0;
      case 'status':
        return status(opts, deps);
      case 'delete':
        kubectl(deps, '-n', 'istio-system', 'delete', 'authorizationpolicy', POLICY, '--ignore-not-found');
        kubectl(deps, 'delete', 'namespace', NAMESPACE, '--ignore-not-found');
        return 0;
      default:
        deps.error(USAGE);
        return 1;
    }
  } catch (e) {
    // Own messages never carry the key or the base; a failed command is reduced to its exit code plus its
    // stderr with the key, the relay host and the SAP hosts replaced, so it stays diagnosable without leaking them.
    if (e instanceof UserError) {
      deps.error(`relay: ${e.message}`);
    } else {
      deps.error(`relay: ${argv[0]} failed${e && e.status !== undefined && e.status !== null ? ` (exit ${e.status})` : ''}`);
      const stderr = e && e.stderr ? String(e.stderr).trim() : '';
      if (stderr) deps.error(redact(stderr, renderedSecrets(out)));
    }
    return 1;
  }
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
