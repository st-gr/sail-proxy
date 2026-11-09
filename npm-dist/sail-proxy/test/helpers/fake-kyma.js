// A fake Kyma cluster for the upgrade tests: answers the kubectl argument arrays the upgrade, the
// kit's deploy-kyma.js / migration-jobs.js (through the command adapter) and setup-kyma.js's
// read-only kubectl issue. Objects live in memory; the "database" is a string the dump carries.
// Anything it does not know throws, so a new kubectl call shows up as a test failure.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const yaml = require('js-yaml');

const TRAILER = '-- PostgreSQL database dump complete';
const CLUSTER_KINDS = new Set(['namespace', 'clusterrole', 'clusterrolebinding']);
// Custom resources: an update needs the live resourceVersion (as on a real API server)
const CR_KINDS = new Set(['authorizationpolicy', 'virtualservice', 'apirule', 'envoyfilter', 'destinationrule', 'peerauthentication']);

class KubeErr extends Error {
  constructor(stderr, stdout = '') {
    super(`Command failed: kubectl\n${stderr}`);
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/** "deployments.apps" / "Deployment" / "networkpolicies" -> "networkpolicy" */
function kindOf(word) {
  let w = String(word).toLowerCase().split('.')[0].split('/')[0];
  if (w.endsWith('policies')) w = w.replace(/policies$/, 'policy');
  else if (w.endsWith('ies')) w = w.replace(/ies$/, 'y');
  else if (w.endsWith('ses') && w !== 'services' || w === 'statuses') w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

function parseArgs(args) {
  const flags = {};
  const pos = [];
  let rest = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest = args.slice(i + 1); break; }
    const eq = /^(--?[A-Za-z-]+)=(.*)$/.exec(a);
    if (eq) { flags[eq[1]] = eq[2]; continue; }
    if (['-n', '--namespace', '-o', '-f', '-l', '-c', '--field-selector', '--for'].includes(a)) { flags[a === '--namespace' ? '-n' : a] = args[++i]; continue; }
    if (a.startsWith('-')) { flags[a] = true; continue; }
    pos.push(a);
  }
  return { flags, pos, rest };
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const matchLabels = (obj, selector) => !selector || selector.split(',').every((p) => {
  const [k, v] = p.split('=');
  return ((obj.metadata && obj.metadata.labels) || {})[k] === v;
});

class FakeKyma {
  constructor(namespace) {
    this.ns = namespace;
    this.objects = new Map();
    this.db = 'rows of 0.11.0';
    this.podFiles = new Map();
    this.calls = [];
    this.denied = new Set(); // "verb resource"
    this.unhealthyTags = new Set();
    this.failDryRun = null; // substring of an applied path
    this.failRestore = false;
    this.unauthorized = false;
    this.rebuildRunning = false;
    this.beforeCommand = null; // async (args, signal) => void
    this.onApply = null; // (obj) => void, after a real apply
    this.replaced = []; // replace calls, '[force ]Kind/name'
    this.failReplace = null; // (doc) => void, may throw before a plain replace
    this.jobPodPolls = 0; // polls during which the migration pods are still listed
    this.dumpRunning = false;
    this.restorePrefixes = [];
    this.objects.set(this.key('namespace', null, namespace), { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } });
    this.add({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'kubernetes', namespace: 'default' }, spec: { clusterIP: '10.0.0.1' } });
  }

  key(kind, ns, name) { return `${kindOf(kind)}/${CLUSTER_KINDS.has(kindOf(kind)) ? '_' : ns}/${name}`; }

  add(obj) {
    const kind = kindOf(obj.kind);
    const ns = CLUSTER_KINDS.has(kind) ? null : (obj.metadata.namespace || this.ns);
    const copy = JSON.parse(JSON.stringify(obj));
    if (ns) copy.metadata.namespace = ns;
    if (copy.kind === 'Secret' && copy.stringData) {
      copy.data = { ...(copy.data || {}), ...Object.fromEntries(Object.entries(copy.stringData).map(([k, v]) => [k, b64(v)])) };
      delete copy.stringData;
    }
    copy.metadata.uid = copy.metadata.uid || crypto.randomUUID();
    this.rv = (this.rv || 0) + 1;
    copy.metadata.resourceVersion = String(this.rv);
    if (copy.kind === 'Job') copy.status = this.jobStatus(copy);
    this.objects.set(this.key(kind, ns, copy.metadata.name), copy);
    return copy;
  }

  get(kind, ns, name) { return this.objects.get(this.key(kind, ns, name)); }

  /** What a refusal must not change: objects (without uids) and the database. */
  state() {
    const objects = [...this.objects.entries()].sort().map(([k, o]) => [k, { ...o, metadata: { ...o.metadata, uid: undefined, resourceVersion: undefined } }]);
    return JSON.stringify({ objects, db: this.db });
  }

  clone() {
    const c = new FakeKyma(this.ns);
    c.objects = new Map(JSON.parse(JSON.stringify([...this.objects])));
    c.db = this.db;
    return c;
  }

  secretValues() {
    const out = [];
    for (const o of this.objects.values()) {
      if (o.kind !== 'Secret') continue;
      for (const v of Object.values(o.data || {})) {
        const text = Buffer.from(v, 'base64').toString('utf8');
        // generated keys and tokens; the password inside a database URL; secrets inside a config file
        if (/^[A-Za-z0-9+/=_.-]{16,}$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text)) out.push(text);
        for (const m of text.matchAll(/:\/\/[^:/@\s]+:([^@\s]{8,})@/g)) out.push(decodeURIComponent(m[1]));
        for (const m of text.matchAll(/(?:secret|password|hash|bindPW)\s*:\s*"?([^\s"]{12,})/gi)) out.push(m[1]);
      }
    }
    return [...new Set(out)];
  }

  jobStatus(job) {
    const failed = this.failJobs && this.failJobs.has(job.metadata.name);
    return { conditions: [{ type: failed ? 'Failed' : 'Complete', status: 'True' }] };
  }

  docsAt(file) {
    const files = fs.statSync(file).isDirectory()
      ? fs.readdirSync(file).filter((f) => /\.(ya?ml|json)$/.test(f)).map((f) => path.join(file, f))
      : [file];
    return files.flatMap((f) => yaml.loadAll(fs.readFileSync(f, 'utf8')).filter(Boolean));
  }

  /** The synchronous handler: returns stdout (string or Buffer) or throws a KubeErr. */
  handle(args, input) {
    this.calls.push(args);
    if (this.unauthorized) throw new KubeErr('error: You must be logged in to the server (Unauthorized)\n');
    const { flags, pos, rest } = parseArgs(args);
    const ns = flags['-n'] || this.ns;
    const verb = pos[0];
    const notFound = (res, name) => new KubeErr(`Error from server (NotFound): ${res} "${name}" not found\n`);
    const out = (obj) => (flags['-o'] === 'name' ? `${kindOf(obj.kind)}/${obj.metadata.name}\n` : JSON.stringify(obj));

    if (verb === 'config') return pos[1] === 'current-context' ? 'fake-context\n' : 'https://api.fake.test\n';
    if (verb === 'auth') {
      const denied = this.denied.has(`${pos[2]} ${pos[3]}`);
      if (denied) throw new KubeErr('', 'no\n');
      return 'yes\n';
    }
    if (verb === 'get') {
      if (flags['-f']) {
        const obj = this.docsAt(flags['-f'])[0];
        const live = this.get(obj.kind, obj.metadata.namespace || ns, obj.metadata.name);
        if (!live) throw notFound(`${kindOf(obj.kind)}s`, obj.metadata.name);
        return out(live);
      }
      const kind = kindOf(pos[1]);
      if (kind === 'gateway' || kind === 'virtualservice' && pos[2] || kind === 'apirule' && pos[2]) throw notFound(`${kind}s`, pos[2]);
      if (kind === 'pod') {
        const app = (flags['-l'] || '').replace(/^app=/, '');
        if (app === 'file-search-rebuild') return this.rebuildRunning ? 'pod/file-search-rebuild-index-x\n' : '';
        if (/^job-name in \(/.test(flags['-l'] || '')) {
          if (this.jobPodPolls > 0) { this.jobPodPolls--; return 'pod/sail-proxy-migrate-admin-x\n'; }
          return '';
        }
        if (['gateway', 'admin'].includes(app)) {
          const d = this.get('deployment', ns, app);
          return d && d.spec.replicas > 0 ? `pod/${app}-1\n` : '';
        }
        return '';
      }
      if (pos[2]) {
        const obj = this.get(kind, ns, pos[2]);
        if (!obj) throw notFound(`${kind}s`, pos[2]);
        if (flags['-o'] && flags['-o'].startsWith('jsonpath')) return obj.spec.clusterIP;
        return out(obj);
      }
      const items = [...this.objects.values()].filter((o) => kindOf(o.kind) === kind && (CLUSTER_KINDS.has(kind) || o.metadata.namespace === ns));
      return JSON.stringify({ items });
    }
    if (verb === 'apply' || verb === 'create' || verb === 'replace') {
      const dry = flags['--dry-run'] === 'server';
      if (dry && this.failDryRun && flags['-f'].includes(this.failDryRun)) throw new KubeErr('Error from server (Invalid): admission webhook denied the request\n');
      for (const doc of this.docsAt(flags['-f'])) {
        if (flags['-l'] && !matchLabels(doc, flags['-l'])) continue;
        const dns = doc.metadata.namespace || ns;
        const exists = this.get(doc.kind, dns, doc.metadata.name);
        if (verb === 'create' && exists) throw new KubeErr(`Error from server (AlreadyExists): ${doc.metadata.name} already exists\n`);
        if (verb === 'replace' && !exists) throw notFound(`${kindOf(doc.kind)}s`, doc.metadata.name);
        if (verb === 'replace' && !flags['--force'] && this.failReplace) this.failReplace(doc);
        if (verb === 'replace' && !flags['--force'] && CR_KINDS.has(kindOf(doc.kind)) && doc.metadata.resourceVersion !== exists.metadata.resourceVersion) {
          throw new KubeErr(`The ${doc.kind} "${doc.metadata.name}" is invalid: metadata.resourceVersion: Invalid value: 0x0: must be specified for an update\n`);
        }
        if (verb === 'replace') this.replaced.push(`${flags['--force'] ? 'force ' : ''}${doc.kind}/${doc.metadata.name}`);
        if (dry) continue;
        // kubectl apply stores what it applied, for its next three-way merge
        const applied = verb === 'apply'
          ? { ...doc, metadata: { ...doc.metadata, annotations: { ...(doc.metadata.annotations || {}), 'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify(doc) } } }
          : doc;
        const added = this.add(applied);
        if (added.kind === 'Job' && added.metadata.name === 'sail-proxy-migrate-admin' && added.status.conditions[0].type === 'Complete') {
          this.db += `\nadmin schema of ${this.imageTag(added)}`;
        }
        if (this.onApply) this.onApply(added);
      }
      return 'applied\n';
    }
    if (verb === 'delete') {
      const kind = kindOf(pos[1]);
      for (const name of pos.slice(2)) {
        const k = this.key(kind, ns, name);
        if (!this.objects.has(k) && !flags['--ignore-not-found']) throw notFound(`${kind}s`, name);
        this.objects.delete(k);
      }
      return '';
    }
    if (verb === 'label' || verb === 'wait') return '';
    if (verb === 'logs') return 'migration log line\n';
    if (verb === 'scale') {
      const d = this.get('deployment', ns, pos[2]);
      if (!d) throw notFound('deployments', pos[2]);
      d.spec.replicas = Number(flags['--replicas']);
      return `deployment.apps/${pos[2]} scaled\n`;
    }
    if (verb === 'rollout') {
      const [kind, name] = pos[2].split('/');
      const obj = this.get(kind, ns, name);
      if (!obj) throw notFound(`${kind}s`, name);
      if (obj.spec.replicas > 0 && this.unhealthyTags.has(this.imageTag(obj))) throw new KubeErr('error: timed out waiting for the condition\n');
      return 'successfully rolled out\n';
    }
    if (verb === 'exec') return this.exec(pos, rest, ns, input);
    throw new Error(`fake kubectl: unsupported command: ${args.join(' ')}`);
  }

  imageTag(obj) {
    const c = ((obj.spec.template || {}).spec || {}).containers || [];
    const m = c[0] && /:([^:@/]+)$/.exec(c[0].image);
    return m ? m[1] : null;
  }

  exec(pos, rest, ns, input) {
    const target = pos.find((p) => p !== 'exec');
    if (target.startsWith('deploy/')) {
      const d = this.get('deployment', ns, target.slice(7));
      if (!d || !(d.spec.replicas > 0) || this.unhealthyTags.has(this.imageTag(d))) throw new KubeErr('command terminated with exit code 1\n');
      return '';
    }
    if (target !== 'postgres-0') throw new Error(`fake kubectl: exec into ${target}`);
    if (rest[0] === 'cat') return this.podFile(rest[1]);
    if (rest[0] === 'rm') { rest.slice(2).forEach((p) => this.podFiles.delete(p)); return ''; }
    const script = rest[2];
    let m;
    if ((m = /^kill \$\(cat (\S+)\.pid 2>\/dev\/null\) 2>\/dev\/null; rm -f \1 \1\.gz \1\.pid$/.exec(script))) {
      this.dumpRunning = false;
      for (const p of [m[1], `${m[1]}.gz`, `${m[1]}.pid`]) this.podFiles.delete(p);
      return '';
    }
    if ((m = /pg_dump .* -f (\S+) & echo \$! > \1\.pid; wait \$! \|\| exit 1; gzip -1 \1 & echo \$! > \1\.pid; wait \$!$/.exec(script))) {
      // pg_dump --clean starts with the DROPs, the extension's among them
      this.podFiles.set(`${m[1]}.gz`, zlib.gzipSync(Buffer.from(`DROP EXTENSION IF EXISTS vector;\n-- dump\n${this.db}\n${TRAILER}\n`)));
      return '';
    }
    if ((m = /^sha256sum (\S+) && wc -c < \1$/.exec(script))) {
      const b = this.podFile(m[1]);
      return `${sha(b)}  ${m[1]}\n${b.length}\n`;
    }
    if ((m = /^cat > (\S+)$/.exec(script))) { this.podFiles.set(m[1], input); return ''; }
    if (/pg_database_size/.test(script)) return '1048576\n';
    if (/CREATE EXTENSION/.test(script)) return '';
    if ((m = /^gunzip (\S+)\.gz && .*psql .* -f \1 > \/dev\/null$/.exec(script))) {
      if (this.failRestore) throw new KubeErr('psql:/tmp/x:12: ERROR:  relation "x" already exists\n');
      const text = zlib.gunzipSync(this.podFile(`${m[1]}.gz`)).toString('utf8');
      // as with a table outside the dump that has a vector column
      if (/^DROP EXTENSION/m.test(text)) throw new KubeErr('psql:/tmp/x:3: ERROR:  cannot drop extension vector because other objects depend on it\n');
      const start = text.indexOf('-- dump\n');
      this.restorePrefixes.push(text.slice(0, start));
      this.db = text.slice(start + '-- dump\n'.length, text.lastIndexOf(`\n${TRAILER}`));
      return '';
    }
    throw new Error(`fake kubectl: unsupported pod script: ${script}`);
  }

  podFile(p) {
    if (!this.podFiles.has(p)) throw new KubeErr(`cat: ${p}: No such file or directory\n`);
    return this.podFiles.get(p);
  }

  /** setup-kyma.js's runKubectl / deploy-kyma.js's kubectlRead */
  read(args) {
    const r = this.handle(args);
    return Buffer.isBuffer(r) ? r.toString('utf8') : r;
  }

  /** The upgrade's kubectl runner (argument arrays). */
  async run(args, options = {}) {
    if (this.beforeCommand) await this.beforeCommand(args, options.signal);
    if (options.signal && options.signal.aborted) throw Object.assign(new Error('interrupted'), { name: 'AbortedError' });
    let input;
    if (options.input !== undefined) {
      if (typeof options.input.pipe === 'function') {
        const parts = [];
        for await (const c of options.input) parts.push(c);
        input = Buffer.concat(parts);
      } else input = Buffer.from(options.input);
    }
    const r = this.handle(args, input);
    if (options.stdout) {
      await new Promise((resolve, reject) => { options.stdout.on('error', reject); options.stdout.end(r, resolve); });
      return { stdout: '', stderr: '' };
    }
    return { stdout: Buffer.isBuffer(r) ? r.toString('utf8') : r, stderr: '' };
  }
}

module.exports = { FakeKyma, KubeErr, kindOf };
