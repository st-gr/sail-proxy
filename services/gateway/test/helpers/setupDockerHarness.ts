/**
 * Harness for running docker/setup-docker.js unattended against a temporary project root.
 * Nothing here touches the live .env files, Docker volumes or a Docker daemon: every method of
 * DockerSetup that shells out to docker / docker compose is stubbed on the instance and the
 * calls are recorded instead.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
// setup-docker.js writes the project version as DOCKER_TAG; the goldens hold <version> so a release bump does not break them.
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;

// Files the script reads, copied into the temporary root (relative to the repo root).
const INPUT_PATHS = [
  'docker/docker-compose.yml',
  'docker/configs',
  'package.json',
  'services/gateway/.env.sample',
  'services/admin/.env.sample',
  'services/ollama/.env.sample'
];

const baselines = new Map<string, Record<string, string>>();

export function walk(dir: string, base: string, out: Record<string, string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
  }
}

export function makeDockerRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-docker-golden-'));
  for (const rel of INPUT_PATHS) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(REPO, rel), dest, { recursive: true });
  }
  const baseline: Record<string, string> = {};
  walk(root, root, baseline);
  baselines.set(root, baseline);
  return root;
}

/** Relative path -> content of every file the run created or changed; random hex runs and the version normalised. */
export function snapshotRoot(root: string): Record<string, string> {
  const all: Record<string, string> = {};
  walk(root, root, all);
  const baseline = baselines.get(root) || {};
  const out: Record<string, string> = {};
  for (const rel of Object.keys(all).sort()) {
    if (baseline[rel] === all[rel]) continue;
    out[rel] = all[rel]
      .split(`DOCKER_TAG=${VERSION}\n`).join('DOCKER_TAG=<version>\n')
      .replace(/AKIA[0-9A-Z]{16}/g, '<aws-access-key-id>')
      .replace(/\b[0-9a-f]{64}\b/g, '<hex64>')
      .replace(/\b[0-9a-f]{32}\b/g, '<hex32>')
      .replace(/\b[0-9a-f]{16}\b/g, '<hex16>');
  }
  return out;
}

const dockerCalls = new WeakMap<object, string[]>();

/** Stubs every docker-calling method on the instance; returns the live call log. */
export function stubDockerCalls(setup: any, existingVolumes: string[] = []): string[] {
  const calls: string[] = [];
  dockerCalls.set(setup, calls);
  setup.checkExistingVolumes = (names: string[]) => {
    calls.push(`checkExistingVolumes(${(names || []).join(',')})`);
    return existingVolumes.slice();
  };
  setup.deleteVolumes = (names: string[]) => {
    calls.push(`deleteVolumes(${(names || []).join(',')})`);
    return true;
  };
  setup.detectArchitecture = () => {
    calls.push('detectArchitecture()');
    return { nodeArch: 'x64', dockerArch: 'x86_64', isAppleSilicon: false, isARM64: false, isAMD64: true };
  };
  return calls;
}

/** Guard: any direct child_process use that escapes the stubs (docker pull etc.) fails the test. */
export function forbidChildProcess(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const childProcess = require('child_process');
  const refuse = (name: string) => () => {
    throw new Error(`child_process.${name} called during a unit test`);
  };
  for (const name of ['execSync', 'spawnSync', 'spawn', 'exec', 'execFile', 'execFileSync'] as const) {
    jest.spyOn(childProcess, name as any).mockImplementation(refuse(name) as any);
  }
}

export function newDockerSetup(
  DockerSetup: any,
  root: string,
  options: Record<string, unknown>,
  existingVolumes: string[] = []
): { setup: any; calls: string[] } {
  const setup = new DockerSetup(options);
  setup.dockerDir = path.join(root, 'docker');
  setup.configsDir = path.join(root, 'docker', 'configs');
  setup.projectRoot = root;
  return { setup, calls: stubDockerCalls(setup, existingVolumes) };
}
