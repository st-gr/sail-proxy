/**
 * Docker Compose Port Exposure Test (A5)
 *
 * docker compose publishes container ports on all interfaces by default
 * ("HOSTPORT:CONTAINERPORT" binds 0.0.0.0). For most services in this Docker
 * deployment that means the admin API (which trusts client-supplied
 * X-Auth-Request-Email/Groups headers that nginx is supposed to set) plus
 * Valkey, Postgres, Dex and OAuth2-Proxy are reachable from anyone on the
 * network, bypassing nginx entirely — see docs/superpowers/plans/
 * 2026-09-25-review-fixes/A.md, finding A5.
 *
 * This test parses every docker-compose*.yml file/template the Docker setup
 * uses or renders and asserts that every published port, on every service not
 * explicitly allowlisted below, is bound to 127.0.0.1 (still reachable from
 * the host for debugging, not from the network). Every allowlist entry needs
 * a reason; do not add entries to silence a real finding.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Services that may publish a port without a 127.0.0.1 prefix. Every entry
 * needs a reason.
 */
const PUBLIC_ALLOWED: Record<string, string> = {
  // The public entry point; everything else reaches the deployment through it.
  nginx: 'the reverse proxy / public entry point of the Docker deployment',
  // Documented across docs/user (chapters 2-7, 10-15) as the direct API base
  // URL for every client integration (curl http://localhost:3000/..., SDK
  // baseURL settings, the realtime websocket, etc.) — chapter-10-troubleshooting.md
  // and chapter-3-installation.md both mark this exact form "correct" for the
  // Docker deployment (only Kyma requires the nginx-proxied path instead), so
  // this is intended direct client access, not an internal-only port.
  gateway: 'documented direct API base URL for clients in the Docker deployment',
  // Optional (profiles: ollama), does not trust proxy headers and holds no
  // credential/session data; not part of the A5 finding.
  ollama: 'optional local LLM host; no proxy-header trust, no credential data, out of A5 scope',
};

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'gen', 'coverage', '.git']);

function findComposeFiles(root: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name));
      } else if (/^docker-compose.*\.ya?ml$/i.test(entry.name)) {
        results.push(path.join(dir, entry.name));
      }
    }
  }
  walk(root);
  return results;
}

/**
 * Parses a compose file's `services:` block into { serviceName: ["<port entry>", ...] },
 * using indentation to find service boundaries and each service's `ports:` list.
 * Deliberately not a full YAML parser (matches this codebase's existing
 * approach in ci/ci-pipeline.js's parseDockerComposeConfig): these files are
 * simple and consistently 2-space indented, and a line-based parser is enough
 * to find `ports:` lists without adding a new dependency.
 */
function parseComposeServicePorts(content: string): Record<string, string[]> {
  const ports: Record<string, string[]> = {};
  let inServices = false;
  let currentService: string | null = null;
  let currentServiceIndent = -1;
  let inPortsList = false;
  let portsIndent = -1;

  const serviceHeaderPattern = /^[\w.-]+:\s*$/;

  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      inServices = trimmed === 'services:';
      currentService = null;
      inPortsList = false;
      continue;
    }

    if (!inServices) continue;

    if (currentService === null || indent <= currentServiceIndent) {
      inPortsList = false;
      currentService = null;
      if (serviceHeaderPattern.test(trimmed)) {
        currentService = trimmed.slice(0, -1);
        currentServiceIndent = indent;
        ports[currentService] = [];
      }
      continue;
    }

    if (trimmed === 'ports:') {
      inPortsList = true;
      portsIndent = indent;
      continue;
    }

    if (inPortsList) {
      if (indent > portsIndent && trimmed.startsWith('-')) {
        let value = trimmed.replace(/^-\s*/, '').trim();
        const quoted = value.match(/^"([^"]*)"/) ?? value.match(/^'([^']*)'/);
        value = quoted ? quoted[1] : value.split('#')[0].trim();
        ports[currentService].push(value);
        continue;
      }
      if (indent <= portsIndent) {
        inPortsList = false;
      }
    }
  }

  return ports;
}

describe('docker compose services bind non-public ports to 127.0.0.1 only (A5)', () => {
  const composeFiles = findComposeFiles(REPO_ROOT);

  it('discovers the known compose files', () => {
    const relPaths = composeFiles.map((f) => path.relative(REPO_ROOT, f)).sort();
    expect(relPaths).toEqual(
      expect.arrayContaining([
        'docker/docker-compose.yml',
        'services/admin/docker-compose.validation.yml',
        'docker/configs/providers/ldap/docker-compose.override.yml',
      ])
    );
  });

  for (const file of composeFiles) {
    const relPath = path.relative(REPO_ROOT, file);
    const content = fs.readFileSync(file, 'utf8');
    const servicePorts = parseComposeServicePorts(content);

    for (const [service, entries] of Object.entries(servicePorts)) {
      if (entries.length === 0) continue;
      if (service in PUBLIC_ALLOWED) continue;

      it(`${relPath}: ${service} publishes ports only on 127.0.0.1`, () => {
        for (const entry of entries) {
          expect(entry.startsWith('127.0.0.1:')).toBe(true);
        }
      });
    }
  }
});
