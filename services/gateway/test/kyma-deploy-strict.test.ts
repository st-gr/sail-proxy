/**
 * deploy-kyma.js for `sail-proxy upgrade kyma`: strict (stop at the first failed command),
 * dry-run (server-side validation, nothing changed), holdAtZero (gateway/admin applied at zero
 * replicas), and the migration Jobs (runMigrationJobs, kyma/templates/manifests/core/migrate-jobs.yaml).
 *
 * child_process is mocked for the whole file: nothing reaches a cluster. The strict, dry-run and
 * hold tests inject the kubectl runner; the default-mode regression goes through the mocked exec.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockExecCommands: string[] = [];
let mockExecFails: (command: string) => boolean = () => false;

jest.mock('child_process', () => ({
  exec: (command: string, callback: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
    mockExecCommands.push(command);
    if (mockExecFails(command)) {
      callback(new Error(`Command failed: ${command}`), { stdout: '', stderr: '' });
      return;
    }
    callback(null, { stdout: '', stderr: '' });
  },
  // verifyLiveCredentials: the namespace does not exist yet, so there is nothing to compare
  execFileSync: () => {
    const error = new Error('NotFound') as Error & { stderr: string };
    error.stderr = 'Error from server (NotFound): namespaces "sail-proxy" not found\n';
    throw error;
  },
  execSync: () => {
    throw new Error('execSync not expected');
  },
  spawn: () => {
    throw new Error('spawn not expected');
  },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const deployKyma = require('../../../kyma/scripts/deploy-kyma.js');
const { runMigrationJobs } = require('../../../kyma/scripts/migration-jobs.js');
const { renderInstallRecord } = require('../../../kyma/scripts/install-record.js');
/* eslint-enable @typescript-eslint/no-var-requires */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CORE_TEMPLATES = path.join(REPO_ROOT, 'kyma', 'templates', 'manifests', 'core');
const NAMESPACE = 'sail-proxy';

const fromTemplate = (file: string) =>
  fs
    .readFileSync(path.join(CORE_TEMPLATES, file), 'utf8')
    .replace(/__NAMESPACE__/g, NAMESPACE)
    .replace(/__CONTAINER_REGISTRY__/g, 'ghcr.io')
    .replace(/__CONTAINER_ORGANIZATION__/g, 'st-gr')
    .replace(/__CONTAINER_TAG__/g, '0.12.0');

/** A small render: the real admin and gateway manifests, a stub for the rest, a secret, the record. */
function writeRender(kymaDir: string) {
  const core = path.join(kymaDir, 'manifests', 'core');
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(path.join(core, 'namespace.yaml'), `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${NAMESPACE}\n`);
  for (const file of ['admin.yaml', 'gateway.yaml']) fs.writeFileSync(path.join(core, file), fromTemplate(file));
  for (const file of ['postgres.yaml', 'valkey.yaml', 'nginx.yaml']) fs.writeFileSync(path.join(core, file), `kind: Service\n`);
  fs.writeFileSync(
    path.join(core, 'install-record.yaml'),
    renderInstallRecord({ namespace: NAMESPACE, version: '0.12.0', answers: {}, recordedBy: 'setup' })
  );
  fs.mkdirSync(path.join(kymaDir, 'templates', 'secrets'), { recursive: true });
  fs.writeFileSync(
    path.join(kymaDir, 'templates', 'secrets', 'admin-env.yaml'),
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: admin-env\n  namespace: ${NAMESPACE}\nstringData:\n  KEY: "value-1"\n`
  );
}

type Runner = (command: string) => Promise<{ stdout: string; stderr: string }>;

/** A kubectl runner that records each command and the content of the file it applies. */
function recorder(fails: (command: string) => string | null = () => null) {
  const commands: string[] = [];
  const applied: Record<string, string> = {};
  const kubectl: Runner = async (command) => {
    commands.push(command);
    const file = /^kubectl apply -f "([^"]+)"/.exec(command);
    if (file && fs.existsSync(file[1]) && fs.statSync(file[1]).isFile()) applied[command] = fs.readFileSync(file[1], 'utf8');
    const stderr = fails(command);
    if (stderr !== null) throw Object.assign(new Error(`Command failed: ${command}`), { stderr });
    return { stdout: '', stderr: '' };
  };
  return { kubectl, commands, applied };
}

describe('deploy-kyma.js strict, dry-run and hold at zero', () => {
  let kymaDir: string;
  let out: jest.SpyInstance[];

  beforeEach(() => {
    kymaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-deploy-strict-'));
    writeRender(kymaDir);
    mockExecCommands.length = 0;
    mockExecFails = () => false;
    out = ['log', 'warn', 'error'].map((m) => jest.spyOn(console, m as 'log').mockImplementation(() => undefined));
    delete process.env.KYMA_DEPLOY_CONFIG;
  });

  afterEach(() => {
    out.forEach((s) => s.mockRestore());
    fs.rmSync(kymaDir, { recursive: true, force: true });
  });

  it('default mode still swallows a failed apply and goes on (regression)', async () => {
    mockExecFails = (c) => c.includes('admin-env.yaml');
    await deployKyma.deployToKyma({ kymaDir, argv: [] });
    const failedAt = mockExecCommands.findIndex((c) => c.includes('admin-env.yaml'));
    expect(failedAt).toBeGreaterThan(-1);
    expect(mockExecCommands.length).toBeGreaterThan(failedAt + 5);
    expect(mockExecCommands.some((c) => c.includes('rollout status deployment/gateway'))).toBe(true);
    // a failed run records nothing
    expect(mockExecCommands.some((c) => c.includes('install-record.yaml'))).toBe(false);
  });

  it('strict mode throws a DeployError (no process.exit) when the folder holds no render', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-deploy-empty-'));
    try {
      const { kubectl, commands } = recorder();
      const failure = await deployKyma.deployToKyma({ kymaDir: empty, argv: [], strict: true, kubectl }).catch((e: Error) => e);
      expect(failure).toBeInstanceOf(deployKyma.DeployError);
      expect(failure.step).toBe('Resolving the deploy target');
      expect(exit).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
    } finally {
      exit.mockRestore();
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('strict mode throws a DeployError at a failed apply and runs nothing after it', async () => {
    const { kubectl, commands } = recorder((c) => (c.includes('admin-env.yaml') ? 'Error from server (Forbidden): nope' : null));
    const failure = await deployKyma.deployToKyma({ kymaDir, argv: [], strict: true, kubectl }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(deployKyma.DeployError);
    expect(failure.step).toBe('Applying admin-env.yaml');
    expect(failure.command).toMatch(/^kubectl apply -f ".*admin-env\.yaml"$/);
    expect(failure.stderr).toBe('Error from server (Forbidden): nope');
    expect(commands[commands.length - 1]).toBe(failure.command);
  });

  it('strict mode throws at a failed rollout and runs nothing after it', async () => {
    const { kubectl, commands } = recorder((c) => (c.includes('rollout status deployment/valkey') ? 'error: timed out waiting' : null));
    const failure = await deployKyma.deployToKyma({ kymaDir, argv: [], strict: true, kubectl }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(deployKyma.DeployError);
    expect(failure.step).toBe('Waiting for valkey to be ready');
    expect(failure.stderr).toBe('error: timed out waiting');
    expect(commands[commands.length - 1]).toBe('kubectl -n sail-proxy rollout status deployment/valkey --timeout=300s');
  });

  it('a DeployError carries only the first 2000 characters of stderr', async () => {
    const { kubectl } = recorder((c) => (c.includes('admin-env.yaml') ? 'x'.repeat(5000) : null));
    const failure = await deployKyma.deployToKyma({ kymaDir, argv: [], strict: true, kubectl }).catch((e: Error) => e);
    expect(failure.stderr).toHaveLength(2000);
    expect(failure.message).not.toMatch(/xxxx/);
  });

  it('a strict run that does not fail records the installation', async () => {
    const { kubectl, commands } = recorder();
    await deployKyma.deployToKyma({ kymaDir, argv: [], strict: true, kubectl });
    expect(commands.some((c) => c.includes('install-record.yaml'))).toBe(true);
  });

  it('the strictness ends with the run', async () => {
    await deployKyma.deployToKyma({ kymaDir, argv: [], strict: true, kubectl: recorder().kubectl });
    mockExecFails = (c) => c.includes('admin-env.yaml');
    await expect(deployKyma.deployToKyma({ kymaDir, argv: [] })).resolves.toBeDefined();
  });

  it('dry-run applies everything with --dry-run=server and issues no rollout, delete, label or record', async () => {
    const { kubectl, commands } = recorder();
    await deployKyma.deployToKyma({ kymaDir, argv: [], dryRun: true, strict: true, kubectl });
    const applies = commands.filter((c) => c.startsWith('kubectl apply'));
    expect(applies.length).toBeGreaterThan(5);
    for (const apply of applies) expect(apply).toMatch(/ --dry-run=server$/);
    expect(commands.filter((c) => /\b(rollout|delete|label|scale)\b/.test(c))).toEqual([]);
    expect(commands.some((c) => c.includes('install-record.yaml'))).toBe(false);
    expect(commands.some((c) => /get pods/.test(c))).toBe(false);
  });

  it('dry-run never writes into the rendered directory', async () => {
    const before = fs.readdirSync(path.join(kymaDir, 'manifests', 'core')).sort();
    await deployKyma.deployToKyma({ kymaDir, argv: [], dryRun: true, kubectl: recorder().kubectl });
    expect(fs.readdirSync(path.join(kymaDir, 'manifests', 'core')).sort()).toEqual(before);
  });

  it('holdAtZero applies gateway and admin with zero replicas and does not wait for them', async () => {
    const { kubectl, commands, applied } = recorder();
    const onDisk = (f: string) => fs.readFileSync(path.join(kymaDir, 'manifests', 'core', f), 'utf8');
    const before = { admin: onDisk('admin.yaml'), gateway: onDisk('gateway.yaml') };
    await deployKyma.deployToKyma({ kymaDir, argv: [], strict: true, holdAtZero: ['gateway', 'admin'], skipInstallRecord: true, kubectl });

    const content = (name: string) => Object.entries(applied).find(([c]) => c.includes(`${name}.yaml`))![1];
    for (const name of ['admin', 'gateway']) {
      const deployment = content(name).split('\n---\n').find((d) => /^kind: Deployment$/m.test(d))!;
      expect(deployment).toMatch(/^ {2}replicas: 0$/m);
      expect(deployment).not.toMatch(/^ {2}replicas: [1-9]/m);
      expect(commands).not.toContain(`kubectl -n sail-proxy rollout status deployment/${name} --timeout=300s`);
    }
    expect(commands).toContain('kubectl -n sail-proxy rollout status deployment/nginx --timeout=300s');
    expect(commands).toContain('kubectl -n sail-proxy rollout status deployment/valkey --timeout=300s');
    // the render on disk is untouched, and the record is left to the caller
    expect(onDisk('admin.yaml')).toBe(before.admin);
    expect(onDisk('gateway.yaml')).toBe(before.gateway);
    expect(commands.some((c) => c.includes('install-record.yaml'))).toBe(false);
  });

  it('without holdAtZero the Deployments keep their replicas and are waited for', async () => {
    const { kubectl, commands, applied } = recorder();
    await deployKyma.deployToKyma({ kymaDir, argv: [], kubectl });
    expect(commands).toContain('kubectl -n sail-proxy rollout status deployment/gateway --timeout=300s');
    expect(Object.entries(applied).find(([c]) => c.includes('gateway.yaml'))![1]).toMatch(/^ {2}replicas: 1$/m);
    expect(commands.some((c) => c.includes('install-record.yaml'))).toBe(true);
  });

  it('withReplicasZero adds the field when the manifest has none, and refuses a missing Deployment', () => {
    const manifest = 'kind: Service\nmetadata:\n  name: x\n---\nkind: Deployment\nmetadata:\n  name: x\nspec:\n  selector: {}\n';
    expect(deployKyma.withReplicasZero(manifest, 'x')).toBe(
      'kind: Service\nmetadata:\n  name: x\n---\nkind: Deployment\nmetadata:\n  name: x\nspec:\n  replicas: 0\n  selector: {}\n'
    );
    expect(() => deployKyma.withReplicasZero(manifest, 'y')).toThrow(/no Deployment y/);
  });
});

describe('runMigrationJobs', () => {
  const [ADMIN_JOB, FS_JOB] = deployKyma.MIGRATION_JOBS;
  let manifestsDir: string;

  beforeEach(() => {
    manifestsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-migrate-'));
    fs.mkdirSync(path.join(manifestsDir, 'upgrade'));
    fs.writeFileSync(path.join(manifestsDir, 'upgrade', 'migrate-jobs.yaml'), fromTemplate('migrate-jobs.yaml'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(manifestsDir, { recursive: true, force: true });
  });

  const jobJson = (condition?: 'Complete' | 'Failed') =>
    JSON.stringify({ status: { conditions: condition ? [{ type: condition, status: 'True' }] : [] } });

  /** A cluster whose Jobs report the given condition (undefined = still running). */
  function jobs(state: Record<string, 'Complete' | 'Failed' | undefined>, logs = 'migration log line') {
    const commands: string[] = [];
    const kubectl: Runner = async (command) => {
      commands.push(command);
      const get = /get job (\S+) -o json/.exec(command);
      if (get) return { stdout: jobJson(state[get[1]]), stderr: '' };
      if (/ logs job\//.test(command)) return { stdout: logs, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    return { kubectl, commands };
  }
  const options = (kubectl: Runner) => ({ namespace: NAMESPACE, manifestsDir, kubectl, timeoutSeconds: 1, pollIntervalMs: 5 });

  it('deletes the stale Jobs, applies the rendered ones and returns when both completed', async () => {
    const { kubectl, commands } = jobs({ [ADMIN_JOB]: 'Complete', [FS_JOB]: 'Complete' });
    await runMigrationJobs(options(kubectl));
    expect(commands[0]).toBe(`kubectl -n ${NAMESPACE} delete job ${ADMIN_JOB} ${FS_JOB} --ignore-not-found`);
    const file = path.join(manifestsDir, 'upgrade', 'migrate-jobs.yaml');
    expect(commands[1]).toBe(`kubectl apply -f "${file}" -l sail-proxy/migration-job=admin`);
    expect(commands[2]).toBe(`kubectl apply -f "${file}" -l sail-proxy/migration-job=file-search`);
    expect(commands.slice(3).every((c) => c.includes('get job'))).toBe(true);
  });

  it.each([
    [['admin'], ADMIN_JOB, FS_JOB, 'admin'],
    [['file-search'], FS_JOB, ADMIN_JOB, 'file-search'],
  ])('runs only the %j Job when asked for it', async (selection, wanted, other, label) => {
    const { kubectl, commands } = jobs({ [wanted]: 'Complete' });
    await runMigrationJobs({ ...options(kubectl), jobs: selection });
    expect(commands[0]).toBe(`kubectl -n ${NAMESPACE} delete job ${wanted} --ignore-not-found`);
    expect(commands.filter((c) => c.startsWith('kubectl apply'))).toEqual([
      `kubectl apply -f "${path.join(manifestsDir, 'upgrade', 'migrate-jobs.yaml')}" -l sail-proxy/migration-job=${label}`,
    ]);
    expect(commands.filter((c) => c.includes('get job')).every((c) => c.includes(wanted))).toBe(true);
    expect(commands.some((c) => c.includes(other))).toBe(false);
  });

  it('refuses an unknown Job name', async () => {
    await expect(runMigrationJobs({ ...options(jobs({}).kubectl), jobs: ['nope'] })).rejects.toThrow(/Unknown migration job/);
  });

  it('waits while a Job is still running', async () => {
    let reads = 0;
    const kubectl: Runner = async (command) => {
      if (command.includes(`get job ${ADMIN_JOB}`)) return { stdout: jobJson(++reads > 2 ? 'Complete' : undefined), stderr: '' };
      if (command.includes('get job')) return { stdout: jobJson('Complete'), stderr: '' };
      return { stdout: '', stderr: '' };
    };
    await runMigrationJobs(options(kubectl));
    expect(reads).toBe(3);
  });

  it('throws a DeployError with the last log lines when a Job failed', async () => {
    const { kubectl, commands } = jobs({ [ADMIN_JOB]: 'Failed', [FS_JOB]: undefined }, 'ERROR: relation "x" already exists');
    const failure = await runMigrationJobs(options(kubectl)).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(deployKyma.DeployError);
    expect(failure.step).toBe(`Migration job ${ADMIN_JOB}`);
    expect(failure.command).toBe(`kubectl -n ${NAMESPACE} get job ${ADMIN_JOB} -o json`);
    expect(failure.stderr).toContain('ERROR: relation "x" already exists');
    expect(commands).toContain(`kubectl -n ${NAMESPACE} logs job/${ADMIN_JOB} --tail=50`);
  });

  it('throws a DeployError when a Job does not finish in time', async () => {
    const { kubectl } = jobs({ [ADMIN_JOB]: 'Complete', [FS_JOB]: undefined });
    const failure = await runMigrationJobs({ ...options(kubectl), timeoutSeconds: 0.05 }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(deployKyma.DeployError);
    expect(failure.step).toBe(`Migration job ${FS_JOB}`);
    expect(failure.stderr).toMatch(/not complete after/);
  });

  it('throws a DeployError when applying the Jobs fails', async () => {
    const kubectl: Runner = async (command) => {
      if (command.startsWith('kubectl apply')) throw Object.assign(new Error('boom'), { stderr: 'admission webhook denied' });
      return { stdout: '', stderr: '' };
    };
    const failure = await runMigrationJobs(options(kubectl)).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(deployKyma.DeployError);
    expect(failure.step).toBe('Applying the admin migration job');
    expect(failure.stderr).toBe('admission webhook denied');
  });
});

describe('migrate-jobs.yaml template', () => {
  const read = (file: string) => fs.readFileSync(path.join(CORE_TEMPLATES, file), 'utf8');
  const jobs = read('migrate-jobs.yaml').split(/\n---\n/);
  const jobNamed = (name: string) => jobs.find((j) => new RegExp(`^  name: ${name}$`, 'm').test(j))!;

  /** The envFrom entries of the first envFrom block of a text, comments dropped. */
  function envFromOf(text: string): string[] {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim() === 'envFrom:');
    const base = lines[start].length - lines[start].trimStart().length;
    const entries: string[] = [];
    for (const line of lines.slice(start + 1)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (indent < base || (indent === base && !trimmed.startsWith('-'))) break;
      entries.push(trimmed.replace(/^- /, ''));
    }
    return entries;
  }
  const lineAfter = (text: string, marker: string) => {
    const lines = text.split('\n');
    return lines[lines.findIndex((l) => l.trim() === marker) + 1].trim();
  };

  it('runs the admin schema step of core/admin.yaml with its image and env sources', () => {
    const job = jobNamed('sail-proxy-migrate-admin');
    const admin = read('admin.yaml');
    const image = (t: string) => /^\s+image: (\S+)$/m.exec(t)![1];
    expect(image(job)).toBe(image(admin));
    expect(envFromOf(job)).toEqual(envFromOf(admin));
    // the Job's script is the Deployment's, up to the point where the Deployment starts the service
    const script = (t: string) => {
      const lines = t.split('\n').map((l) => l.trim());
      const first = lines.findIndex((l) => l.startsWith("echo 'Waiting for PostgreSQL"));
      return lines.slice(first, lines.findIndex((l) => l.includes('cds-deploy --profile pg')) + 1).filter(Boolean);
    };
    const jobScript = script(job);
    const adminScript = script(admin);
    expect(jobScript.length).toBeGreaterThan(5);
    expect(jobScript).toEqual(adminScript.slice(0, jobScript.length));
    expect(job).not.toMatch(/exec node/);
    expect(job).toContain('name: admin-api-config');
  });

  it("runs the gateway's migrate-file-search initContainer with its image, env sources and command", () => {
    const job = jobNamed('sail-proxy-migrate-file-search');
    const gateway = read('gateway.yaml');
    const init = gateway.slice(gateway.indexOf('- name: migrate-file-search'), gateway.indexOf('\n      containers:'));
    expect(/^\s+image: (\S+)$/m.exec(job)![1]).toBe(/^\s+image: (\S+)$/m.exec(init)![1]);
    expect(/command: (\[.*\])/.exec(job)![1]).toBe(/command: (\[.*\])/.exec(init)![1]);
    expect(envFromOf(job)).toEqual(envFromOf(init));
    expect(lineAfter(job, 'envFrom:')).toBe('- secretRef:');
  });

  it('both Jobs fail once, expire, run without a sidecar and keep their names', () => {
    for (const name of ['sail-proxy-migrate-admin', 'sail-proxy-migrate-file-search']) {
      const job = jobNamed(name);
      expect(job).toContain('kind: Job');
      expect(job).toMatch(/^ {2}backoffLimit: 0$/m);
      expect(job).toMatch(/^ {2}ttlSecondsAfterFinished: 600$/m);
      expect(job).toMatch(/restartPolicy: Never/);
      expect(job).toMatch(/sidecar\.istio\.io\/inject: "false"/);
    }
    // each Job is selectable on its own
    expect(jobNamed('sail-proxy-migrate-admin')).toMatch(/^ {4}sail-proxy\/migration-job: admin$/m);
    expect(jobNamed('sail-proxy-migrate-file-search')).toMatch(/^ {4}sail-proxy\/migration-job: file-search$/m);
    expect(deployKyma.MIGRATION_JOBS).toEqual(['sail-proxy-migrate-admin', 'sail-proxy-migrate-file-search']);
  });

  it("gives each Job container imagePullPolicy Always and its Deployment container's resources", () => {
    const resourcesOf = (t: string) => /^ {8}resources:\n(?: {10}.*\n)+/m.exec(t)![0];
    for (const [name, file] of [['sail-proxy-migrate-admin', 'admin.yaml'], ['sail-proxy-migrate-file-search', 'gateway.yaml']]) {
      const job = jobNamed(name);
      expect(job).toMatch(/^ {8}imagePullPolicy: Always$/m);
      expect(resourcesOf(job)).toBe(resourcesOf(read(file)));
    }
  });

  it('is admitted by the network policies: Postgres, Valkey and Admin ingress, own egress', () => {
    const docs = read('network-policies.yaml').split(/\n---\n/);
    const policy = (name: string) => docs.find((d) => new RegExp(`^  name: ${name}$`, 'm').test(d))!;
    const label = /^ {10}sail-proxy\/migration: "true"/m;
    for (const name of ['allow-apps-to-postgres', 'allow-apps-to-valkey', 'allow-migrations-to-admin']) {
      expect(policy(name)).toMatch(label);
    }
    const egress = policy('allow-migrations-egress');
    expect(egress).toMatch(/^ {6}sail-proxy\/migration: "true"$/m);
    for (const app of ['postgres', 'valkey', 'admin']) expect(egress).toMatch(new RegExp(`app: ${app}$`, 'm'));
    // the Job pods carry that label, and never an app label a Service selects
    for (const name of ['sail-proxy-migrate-admin', 'sail-proxy-migrate-file-search']) {
      const pod = jobNamed(name).split('template:')[1];
      expect(pod).toMatch(/^ {8}sail-proxy\/migration: "true"$/m);
      expect(pod).not.toMatch(/^ {8}app: (admin|gateway)$/m);
    }
  });
});
