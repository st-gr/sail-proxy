// A fake Docker host for `sail-proxy upgrade docker` tests: answers `docker` argument arrays
// (compose, ps, rm) and `git` status, keeps containers in memory and represents the database as a
// string carried by the dump. Unknown commands throw. Images of gateway/admin/nginx follow the
// install directory's docker/.env (DOCKER_REGISTRY/ORGANIZATION/TAG), as compose does.
const fs = require('fs');
const path = require('path');

const OWN = ['gateway', 'admin', 'nginx'];
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16-trixie';

function envOf(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

class AbortedError extends Error {
  constructor() { super('interrupted'); this.name = 'AbortedError'; }
}

class FakeDocker {
  constructor({ dir, project = 'sailtest', tag = '0.11.0' }) {
    this.dir = dir;
    this.project = project;
    this.workingDir = path.join(dir, 'docker');
    let n = 0;
    const c = (service, image) => ({ id: `c${++n}`, service, image, state: 'running', project, oneoff: 'False' });
    const own = (s) => `ghcr.io/st-gr/sail-proxy-${s}:${tag}`;
    this.containers = [
      c('postgres', POSTGRES_IMAGE), c('valkey', 'valkey/valkey:8'), c('dex', 'ghcr.io/dexidp/dex:v2.46.1'),
      c('oauth2-proxy', 'quay.io/oauth2-proxy/oauth2-proxy:v7.6.0'), c('admin', own('admin')), c('gateway', own('gateway')),
      c('nginx', own('nginx')),
    ];
    this.db = 'rows of 0.11.0';
    this.calls = [];
    this.gitStatus = '';
    this.otherProjects = []; // [{ project, workingDir }] with a running postgres
    this.missingTags = [];
    this.failOn = null; // (args) => Error | undefined
    this.beforeCommand = null; // async (args) => void
    this.restoreInputs = [];
    this.unhealthy = new Set();
  }

  /** compose interpolation: the shell (inherited minus unsetEnv, plus env) wins over docker/.env */
  imageFor(service, opts = {}) {
    const shell = {};
    for (const k of ['DOCKER_REGISTRY', 'DOCKER_ORGANIZATION', 'DOCKER_TAG']) {
      if (process.env[k] !== undefined && !(opts.unsetEnv || []).includes(k)) shell[k] = process.env[k];
    }
    const e = { ...envOf(path.join(this.dir, 'docker', '.env')), ...shell, ...(opts.env || {}) };
    return `${e.DOCKER_REGISTRY || 'ghcr.io'}/${e.DOCKER_ORGANIZATION || 'st-gr'}/sail-proxy-${service}:${e.DOCKER_TAG || 'latest'}`;
  }

  get(service) {
    return this.containers.find((c) => c.service === service && c.oneoff !== 'True');
  }

  /** compose global options, then the subcommand and its arguments. */
  parseCompose(args) {
    const out = { files: [], project: null, projectDir: null };
    let i = 1;
    for (; i < args.length; i++) {
      if (args[i] === '-p') out.project = args[++i];
      else if (args[i] === '--project-directory') out.projectDir = args[++i];
      else if (args[i] === '-f') out.files.push(args[++i]);
      else break;
    }
    out.sub = args[i];
    out.rest = args.slice(i + 1);
    return out;
  }

  dumpText() {
    return [
      '--', '-- PostgreSQL database dump', '--',
      'DROP TABLE IF EXISTS public.sap_llm_gateway_admin_apikeys;',
      'DROP EXTENSION IF EXISTS vector;',
      'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;',
      'CREATE TABLE public.sap_llm_gateway_admin_apikeys (', '    id text', ');',
      'COPY public.sap_llm_gateway_admin_apikeys (id) FROM stdin;',
      this.db, '\\.', '', '--', '-- PostgreSQL database dump complete', '--', '',
    ].join('\n');
  }

  async run(args, opts = {}) {
    this.calls.push({ args: args.slice(), env: opts.env || {}, unsetEnv: opts.unsetEnv || [] });
    if (this.beforeCommand) await this.beforeCommand(args, opts);
    if (opts.signal && opts.signal.aborted) throw new AbortedError();
    const injected = this.failOn && this.failOn(args);
    if (injected) throw injected;
    if (args[0] === 'ps') return this.ps(args);
    if (args[0] === 'rm') {
      const ids = args.filter((a) => /^c\d+$/.test(a));
      this.containers = this.containers.filter((c) => !ids.includes(c.id));
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'compose') return this.compose(this.parseCompose(args), opts);
    throw new Error(`fake docker: unknown command ${args.join(' ')}`);
  }

  ps(args) {
    const filter = args.filter((a, i) => args[i - 1] === '--filter');
    if (filter.includes('label=com.docker.compose.service=postgres')) {
      const rows = [];
      if (this.get('postgres') && this.get('postgres').state === 'running') rows.push(`${this.project}\t${this.workingDir}`);
      for (const o of this.otherProjects) rows.push(`${o.project}\t${o.workingDir}`);
      return { stdout: rows.map((r) => `${r}\n`).join(''), stderr: '' };
    }
    const project = (filter.find((f) => f.startsWith('label=com.docker.compose.project=')) || '').split('=').pop();
    if (project !== this.project) return { stdout: '', stderr: '' };
    let list = this.containers;
    if (filter.includes('label=com.docker.compose.oneoff=True')) list = list.filter((c) => c.oneoff === 'True');
    if (!args.includes('-a')) list = list.filter((c) => c.state === 'running');
    return { stdout: list.map((c) => `${c.id}\t${c.service}\t${c.image}\t${c.state}\t${c.oneoff}\n`).join(''), stderr: '' };
  }

  async compose(c, opts) {
    if (c.project !== this.project) throw Object.assign(new Error('fake docker: wrong project'), { stderr: 'wrong project' });
    const services = c.rest.filter((a) => !a.startsWith('-'));
    switch (c.sub) {
      case 'config':
        return { stdout: '', stderr: '' };
      case 'pull':
        for (const s of services) {
          const image = this.imageFor(s, opts);
          if (this.missingTags.some((t) => image.endsWith(`:${t}`))) {
            const e = new Error(`pull ${image}`);
            e.stderr = `Error response from daemon: manifest for ${image} not found`;
            throw e;
          }
        }
        return { stdout: '', stderr: '' };
      case 'stop':
        for (const s of services) if (this.get(s)) this.get(s).state = 'exited';
        return { stdout: '', stderr: '' };
      case 'start':
        for (const s of services) if (this.get(s)) this.get(s).state = 'running';
        return { stdout: '', stderr: '' };
      case 'up':
        for (const s of services) {
          if (s === 'postgres') throw new Error('fake docker: postgres is never recreated');
          const ct = this.get(s);
          ct.state = 'running';
          if (OWN.includes(s)) ct.image = this.imageFor(s, opts);
        }
        return { stdout: '', stderr: '' };
      case 'run': {
        if (!c.rest.includes('--no-deps')) throw new Error('fake docker: run without --no-deps may recreate postgres');
        const script = c.rest.join(' ');
        if (script.includes('cds-deploy')) this.db += ' +admin-schema';
        else if (c.rest.includes('gateway-migrate')) this.db += ' +file-search';
        else throw new Error(`fake docker: unknown run ${script}`);
        return { stdout: '', stderr: '' };
      }
      case 'exec':
        return this.exec(c.rest, opts);
      default:
        throw new Error(`fake docker: unknown compose ${c.sub}`);
    }
  }

  async exec(rest, opts) {
    const script = rest[rest.length - 1];
    if (!rest.includes('postgres')) throw new Error(`fake docker: exec outside postgres: ${rest.join(' ')}`);
    if (this.get('postgres').state !== 'running') throw Object.assign(new Error('not running'), { stderr: 'service "postgres" is not running' });
    if (script.includes('pg_database_size')) return { stdout: `${1024 * 1024}\n`, stderr: '' };
    if (script.includes('pg_dump')) {
      await new Promise((resolve, reject) => {
        opts.stdout.once('error', reject);
        opts.stdout.end(Buffer.from(this.dumpText(), 'utf8'), resolve);
      });
      return { stdout: '', stderr: '' };
    }
    if (script.includes('--single-transaction')) {
      let text = '';
      for await (const chunk of opts.input) text += chunk.toString('utf8');
      this.restoreInputs.push(text);
      if (/^DROP EXTENSION/m.test(text)) throw Object.assign(new Error('psql'), { stderr: 'ERROR:  cannot drop extension vector because other objects depend on it' });
      const lines = text.split('\n');
      const at = lines.findIndex((l) => /^COPY .* FROM stdin;$/.test(l));
      this.db = lines[at + 1];
      return { stdout: '', stderr: '' };
    }
    if (script.includes('CREATE EXTENSION')) return { stdout: '', stderr: '' };
    throw new Error(`fake docker: unknown exec ${script}`);
  }

  async git(args) {
    this.calls.push({ args: ['git', ...args], env: {} });
    if (args.includes('status')) return { stdout: this.gitStatus, stderr: '' };
    throw new Error(`fake git: unknown ${args.join(' ')}`);
  }

  /** HTTP status of a health URL on 127.0.0.1 (no network). */
  async http(url) {
    const u = new URL(url);
    const up = (s) => this.get(s) && this.get(s).state === 'running' && !this.unhealthy.has(s);
    let ok;
    if (u.port === '3000' && u.pathname === '/health') ok = up('gateway');
    else if (u.port === '4004' && u.pathname === '/api/health') ok = up('admin');
    else if (u.pathname === '/gateway/health') ok = up('nginx') && up('gateway');
    else throw new Error(`fake http: unknown ${url}`);
    if (!ok) throw Object.assign(new Error(`connect ECONNREFUSED ${u.host}`), { code: 'ECONNREFUSED' });
    return 200;
  }

  composeCalls() {
    return this.calls.filter((c) => c.args[0] === 'compose').map((c) => {
      const p = this.parseCompose(c.args);
      return [p.sub, ...p.rest].join(' ');
    });
  }
}

module.exports = { FakeDocker, POSTGRES_IMAGE, envOf };
