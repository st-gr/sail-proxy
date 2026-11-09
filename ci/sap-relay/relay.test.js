#!/usr/bin/env node
/**
 * The SAP relay operator script (relay.js) with a fake service key and domain. Rendering runs
 * against throwaway git repositories (so the ignore check is real) and never touches the
 * operator's own ci/sap-relay/.rendered; kubectl and the health request are stubbed, so nothing
 * reaches a cluster. The key and the relay base must never reach stdout or stderr.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { main } = require('./relay');

const SERVICE_KEY = JSON.stringify({
  url: 'https://auth.example.test',
  serviceurls: { AI_API_URL: 'https://api.example.test' },
  clientid: 'x',
  clientsecret: 'y'
});
const DOMAIN = 'example.test';
const RESOLVER = '127.0.0.11';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-relay-test-'));

/** A throwaway git repo whose .gitignore holds `ignore` (default `.rendered/`; '' for none). Returns the output dir. */
function repo(name, { ignore = '.rendered/' } = {}) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  if (ignore) fs.writeFileSync(path.join(dir, '.gitignore'), ignore + '\n');
  return path.join(dir, '.rendered');
}

/** Runs main() with captured output and a stubbed exec: git runs for real, everything else is recorded. */
async function run(argv, { env = {}, responses = {}, get, randomKey } = {}) {
  const out = [];
  const calls = [];
  const exec = (cmd, args) => {
    if (cmd === 'git') return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const r = responses[line];
    if (r instanceof Error) throw r;
    return r === undefined ? '' : r;
  };
  const code = await main(argv, env, {
    exec,
    log: (s) => out.push(String(s)),
    error: (s) => out.push(String(s)),
    get: get || (async () => { throw Object.assign(new Error('no network in tests'), { code: 'ENETUNREACH' }); }),
    ...(randomKey ? { randomKey } : {})
  });
  return { code, output: out.join('\n'), calls };
}

const renderArgs = (outDir) => ['render', '--domain', DOMAIN, '--resolver', RESOLVER, '--out', outDir];
const read = (outDir, f) => fs.readFileSync(path.join(outDir, f), 'utf8');
const keyOf = (outDir) => read(outDir, 'relay-base.txt').trim().split('/').pop();

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok - ' + name); } catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}

(async () => {
  await check('render writes three files with mode 600 and no placeholder left', async () => {
    const outDir = repo('basic');
    const r = await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    assert.strictEqual(r.code, 0, r.output);
    const key = keyOf(outDir);
    for (const f of ['nginx.conf', 'manifests.yaml', 'relay-base.txt']) {
      const text = read(outDir, f).split(key).join('KEY'); // template-derived text only
      assert.ok(!/__[A-Z_]+__/.test(text), `${f} still has a placeholder`);
      assert.ok(!text.includes('__'), `${f} still contains "__"`);
      assert.strictEqual(fs.statSync(path.join(outDir, f)).mode & 0o777, 0o600, `${f} mode`);
    }
    assert.deepStrictEqual(r.calls, [], 'render with --resolver runs no kubectl');
  });

  await check('upstream hosts, relay host, resolver and key land where they belong', async () => {
    const outDir = repo('hosts');
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    const key = keyOf(outDir);
    assert.match(key, /^[A-Za-z0-9_-]{43}$/, 'key is 32 random bytes, base64url');
    assert.strictEqual(read(outDir, 'relay-base.txt').trim(), `https://sap-relay.${DOMAIN}/${key}`);
    const conf = read(outDir, 'nginx.conf');
    assert.ok(conf.includes('set $up "api.example.test";'), 'API upstream');
    assert.ok(conf.includes('set $up "auth.example.test";'), 'auth upstream');
    assert.ok(conf.includes(`resolver ${RESOLVER} valid=60s ipv6=off;`), 'resolver');
    assert.ok(conf.includes(`location /${key}/api/`) && conf.includes(`location = /${key}/healthz`), 'key locations');
    assert.ok(conf.includes('access_log off;'), 'URIs are never logged');
    const yaml = read(outDir, 'manifests.yaml');
    assert.ok(yaml.includes(`- sap-relay.${DOMAIN}\n`), 'APIRule host');
    assert.ok(yaml.includes(`hosts: ["sap-relay.${DOMAIN}", "sap-relay.${DOMAIN}:443"]`), 'policy hosts');
    assert.ok(yaml.includes(`path: /${key}/healthz`), 'readiness path');
    assert.ok(yaml.includes('name: allowlist-sap-relay') && !yaml.includes('allowlist-sail-proxy'), 'policy name');
    // The Secret embeds the rendered nginx.conf verbatim, indented under its block scalar.
    const embedded = conf.trimEnd().split('\n').map(l => (l ? '    ' + l : '')).join('\n');
    assert.ok(yaml.includes('  nginx.conf: |\n' + embedded + '\n'), 'Secret carries nginx.conf');
  });

  await check('the rendered manifests are structurally sound YAML', async () => {
    const outDir = repo('yaml');
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    const yaml = read(outDir, 'manifests.yaml');
    assert.ok(!yaml.includes('\t'), 'no tabs');
    const docs = yaml.split(/^---$/m).map(d => d.trim()).filter(Boolean);
    const kinds = docs.map(d => (d.match(/^kind: (\S+)$/m) || [])[1]);
    assert.deepStrictEqual(kinds, ['Namespace', 'Secret', 'Deployment', 'Service', 'NetworkPolicy', 'APIRule', 'AuthorizationPolicy']);
    for (const d of docs) {
      assert.match(d, /^apiVersion: \S+$/m, 'every document has an apiVersion');
      let inBlock = null;
      for (const line of d.split('\n')) {
        const indent = line.match(/^ */)[0].length;
        if (inBlock !== null && (line === '' || indent > inBlock)) continue; // block scalar body
        inBlock = null;
        if (line.trim() === '' || line.trim().startsWith('#')) continue;
        assert.strictEqual(indent % 2, 0, `odd indentation: ${JSON.stringify(line)}`);
        if (/: \|$/.test(line)) inBlock = indent;
      }
    }
    for (const want of ['replicas: 0', 'automountServiceAccountToken: false', 'readOnlyRootFilesystem: true',
      'runAsNonRoot: true', 'allowPrivilegeEscalation: false', 'type: RuntimeDefault',
      'nginxinc/nginx-unprivileged:1.29-alpine@sha256:', 'pod-security.kubernetes.io/enforce: restricted',
      'istio-injection: disabled', 'cidr: 0.0.0.0/0', '- 10.0.0.0/8', '- 172.16.0.0/12', '- 192.168.0.0/16',
      '- 169.254.0.0/16', '- 100.64.0.0/10', 'gateway: kyma-system/kyma-gateway', 'apiVersion: gateway.kyma-project.io/v2']) {
      assert.ok(yaml.includes(want), `manifests contain ${want}`);
    }
  });

  await check('a re-render reuses the existing path key', async () => {
    const outDir = repo('reuse');
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    const first = keyOf(outDir);
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    assert.strictEqual(keyOf(outDir), first);
    fs.unlinkSync(path.join(outDir, 'relay-base.txt'));
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    assert.notStrictEqual(keyOf(outDir), first, 'deleting relay-base.txt rotates the key');
  });

  await check('the service key can come from --key-file and the domain from SAP_RELAY_DOMAIN', async () => {
    const outDir = repo('keyfile');
    const keyFile = path.join(tmpRoot, 'service-key.json');
    fs.writeFileSync(keyFile, SERVICE_KEY);
    const r = await run(['render', '--key-file', keyFile, '--resolver', RESOLVER, '--out', outDir],
      { env: { SAP_RELAY_DOMAIN: DOMAIN } });
    assert.strictEqual(r.code, 0, r.output);
    assert.ok(read(outDir, 'relay-base.txt').startsWith(`https://sap-relay.${DOMAIN}/`));
  });

  await check('without --resolver the resolver is looked up from the cluster', async () => {
    const outDir = repo('lookup');
    const lookup = 'kubectl -n kube-system get svc kube-dns -o jsonpath={.spec.clusterIP}';
    const r = await run(['render', '--domain', DOMAIN, '--out', outDir],
      { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY }, responses: { [lookup]: '10.0.0.10' } });
    assert.strictEqual(r.code, 0, r.output);
    assert.deepStrictEqual(r.calls, [lookup]);
    assert.ok(read(outDir, 'nginx.conf').includes('resolver 10.0.0.10 valid=60s'));
  });

  await check('nothing printed contains the key, the base or the relay host', async () => {
    const outDir = repo('quiet');
    const r = await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    const key = keyOf(outDir);
    assert.match(r.output, /^rendered 3 files to .+ \(key not shown\)$/);
    const up = await run(['status', '--out', outDir], { get: async () => ({ statusCode: 200 }) });
    const down = await run(['status', '--out', outDir], { get: async () => { throw Object.assign(new Error(`getaddrinfo ENOTFOUND sap-relay.${DOMAIN}`), { code: 'ENOTFOUND' }); } });
    const notFound = await run(['status', '--out', outDir], { get: async () => ({ statusCode: 404 }) });
    assert.strictEqual(up.output, 'relay: up 200');
    assert.strictEqual(up.code, 0);
    assert.strictEqual(down.output, 'relay: down ENOTFOUND');
    assert.strictEqual(down.code, 1);
    assert.strictEqual(notFound.output, 'relay: down 404');
    for (const o of [r, up, down, notFound]) {
      for (const secret of [key, 'sap-relay.' + DOMAIN, 'api.example.test', 'auth.example.test']) {
        assert.ok(!o.output.includes(secret), `output leaks ${secret === key ? 'the key' : secret}`);
      }
    }
  });

  await check('status asks the healthz path under the base', async () => {
    const outDir = repo('health');
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    let asked;
    await run(['status', '--out', outDir], { get: async (url) => { asked = url; return { statusCode: 200 }; } });
    assert.strictEqual(asked, read(outDir, 'relay-base.txt').trim() + '/healthz');
  });

  await check('a malformed service key fails without echoing it', async () => {
    const outDir = repo('badkey');
    const r = await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: '{"clientsecret":"hunter2-secret' } });
    assert.strictEqual(r.code, 1);
    assert.ok(!r.output.includes('hunter2'), 'service key content echoed');
    assert.ok(!fs.existsSync(outDir), 'nothing written');
  });

  await check('render refuses an output dir that git does not ignore', async () => {
    const notIgnored = repo('notignored', { ignore: '' });
    const r = await run(renderArgs(notIgnored), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    assert.strictEqual(r.code, 1);
    assert.match(r.output, /not ignored by git/);
    assert.ok(!fs.existsSync(notIgnored), 'nothing written');
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sap-relay-nogit-')), '.rendered');
    const r2 = await run(renderArgs(outside), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    assert.strictEqual(r2.code, 1);
    assert.ok(!fs.existsSync(outside), 'nothing written outside a repo');
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  });

  await check('render refuses when only some rendered files are ignored', async () => {
    const partly = repo('partly', { ignore: '.rendered/*.txt' });
    const r = await run(renderArgs(partly), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    assert.strictEqual(r.code, 1);
    assert.match(r.output, /not ignored by git/);
    assert.ok(!fs.existsSync(partly), 'nothing written');
  });

  await check('a generated key never contains "__" (it could pose as a placeholder)', async () => {
    const outDir = repo('underscore');
    const bad = 'A__B'.padEnd(43, 'c');
    const good = 'D'.padEnd(43, 'e');
    const keys = [bad, good];
    const r = await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY }, randomKey: () => keys.shift() });
    assert.strictEqual(r.code, 0, r.output);
    assert.strictEqual(keyOf(outDir), good);
  });

  await check('an existing key with "__" is replaced (rotated) on render', async () => {
    const outDir = repo('oldunderscore');
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    const old = 'X__Y'.padEnd(43, 'z');
    fs.writeFileSync(path.join(outDir, 'relay-base.txt'), `https://sap-relay.${DOMAIN}/${old}\n`);
    const r = await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY }, randomKey: () => 'F'.padEnd(43, 'g') });
    assert.strictEqual(r.code, 0, r.output);
    assert.strictEqual(keyOf(outDir), 'F'.padEnd(43, 'g'));
    assert.ok(read(outDir, 'nginx.conf').includes(`location /${'F'.padEnd(43, 'g')}/api/`));
  });

  await check('a failing kubectl shows its stderr with the key, the relay host and the SAP hosts redacted', async () => {
    const outDir = repo('stderr');
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    const key = keyOf(outDir);
    const host = `sap-relay.${DOMAIN}`;
    const manifests = path.join(outDir, 'manifests.yaml');
    const failure = Object.assign(new Error(`Command failed: kubectl apply -f ${manifests}`), {
      status: 1,
      stderr: `The Deployment "sap-relay" is invalid: readinessProbe.httpGet.path: "/${key}/healthz"\n` +
        `AuthorizationPolicy hosts ["${host}"]: denied\n` +
        `ConfigMap nginx.conf: upstream "api.example.test" and "auth.example.test" rejected\n`
    });
    const r = await run(['apply', '--out', outDir], { responses: { [`kubectl apply -f ${manifests}`]: failure } });
    assert.strictEqual(r.code, 1);
    assert.match(r.output, /^relay: apply failed \(exit 1\)$/m);
    assert.ok(r.output.includes('"/<key>/healthz"') && r.output.includes('["<relay-host>"]'), r.output);
    assert.ok(!r.output.includes(key) && !r.output.includes(host), 'stderr leaked the key or host');
    assert.ok(r.output.includes('upstream "<sap-host>" and "<sap-host>" rejected'), r.output);
    assert.ok(!r.output.includes('api.example.test') && !r.output.includes('auth.example.test'), 'stderr leaked a SAP host');
  });

  await check('render needs a domain and rejects values that could break the config', async () => {
    const outDir = repo('domain');
    const none = await run(['render', '--resolver', RESOLVER, '--out', outDir], { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    assert.strictEqual(none.code, 1);
    assert.match(none.output, /domain/);
    const bad = await run(['render', '--domain', 'x; return 200', '--resolver', RESOLVER, '--out', outDir], { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    assert.strictEqual(bad.code, 1);
    const badResolver = await run(['render', '--domain', DOMAIN, '--resolver', '1.2.3.4;', '--out', outDir], { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    assert.strictEqual(badResolver.code, 1);
  });

  await check('apply, up, down and delete run exactly the kubectl commands for the relay', async () => {
    const outDir = repo('kubectl');
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    const manifests = path.join(outDir, 'manifests.yaml');
    assert.deepStrictEqual((await run(['apply', '--out', outDir])).calls, [`kubectl apply -f ${manifests}`]);
    const up = await run(['up', '--out', outDir], { get: async () => ({ statusCode: 200 }) });
    assert.deepStrictEqual(up.calls, [
      'kubectl -n sap-relay scale deploy/sap-relay --replicas=1',
      'kubectl -n sap-relay rollout status deploy/sap-relay --timeout=180s'
    ]);
    assert.strictEqual(up.output, 'relay: up 200');
    assert.deepStrictEqual((await run(['down', '--out', outDir])).calls, [
      'kubectl -n sap-relay scale deploy/sap-relay --replicas=0',
      'kubectl -n sap-relay wait --for=delete pod -l app=sap-relay --timeout=180s'
    ]);
    assert.deepStrictEqual((await run(['delete', '--out', outDir])).calls, [
      'kubectl -n istio-system delete authorizationpolicy allowlist-sap-relay --ignore-not-found',
      'kubectl delete namespace sap-relay --ignore-not-found'
    ]);
  });

  await check('a failing kubectl fails the command', async () => {
    const outDir = repo('kubectl-fail');
    await run(renderArgs(outDir), { env: { SAP_AI_CORE_SERVICE_KEY: SERVICE_KEY } });
    const r = await run(['up', '--out', outDir], { responses: { 'kubectl -n sap-relay scale deploy/sap-relay --replicas=1': new Error('connection refused') } });
    assert.strictEqual(r.code, 1);
  });

  await check('down accepts a failed wait only when no relay pod is left', async () => {
    const wait = 'kubectl -n sap-relay wait --for=delete pod -l app=sap-relay --timeout=180s';
    const pods = 'kubectl -n sap-relay get pods -l app=sap-relay -o name';
    const gone = await run(['down'], { responses: { [wait]: new Error('no matching resources found'), [pods]: '' } });
    assert.strictEqual(gone.code, 0);
    const left = await run(['down'], { responses: { [wait]: new Error('timed out'), [pods]: 'pod/sap-relay-1\n' } });
    assert.strictEqual(left.code, 1);
  });

  await check('an unknown command prints usage', async () => {
    const r = await run(['bogus']);
    assert.strictEqual(r.code, 1);
    assert.match(r.output, /usage/i);
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (failed) { console.error(`${failed} relay check(s) failed`); process.exit(1); }
  console.log('relay: all checks passed');
})();
