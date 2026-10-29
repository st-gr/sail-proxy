/**
 * Golden safety net for docker/setup-docker.js unattended runs: `--ci --force` (what the CI
 * pipeline runs) and the `--config` JSON mode setup-kyma.js uses through runDockerSetup. The files
 * a run writes are compared with committed fixtures (random hex values normalised), so a refactor
 * of the script provably changes nothing here. UPDATE_GOLDEN=1 rewrites the fixtures.
 *
 * Runs against a temporary project root with every docker call stubbed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { forbidChildProcess, makeDockerRoot, newDockerSetup, snapshotRoot, walk } from './helpers/setupDockerHarness';

const savedArgv = process.argv;
process.argv = [savedArgv[0], 'setup-docker.js'];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DockerSetup = require('../../../docker/setup-docker.js');
process.argv = savedArgv;

const FIXTURES = path.join(__dirname, 'fixtures', 'setup-docker-golden');
const FAKE_VOLUMES = ['docker_postgres_data', 'docker_valkey_data'];

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const HEX32 = 'c'.repeat(32);

let root: string;
let logs: string[];
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of ['SAP_AI_CORE_SERVICE_KEY', 'POSTGRES_USER', 'POSTGRES_PASSWORD']) delete process.env[key];
  root = makeDockerRoot();
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as any);
  forbidChildProcess();
});

afterEach(() => {
  process.env = savedEnv;
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// Fixtures named `.env` would be gitignored: stored as `dot-env`, mapped both ways.
const toFixtureName = (rel: string) => rel.replace(/(^|\/)\.env$/, '$1dot-env');
const fromFixtureName = (rel: string) => rel.replace(/(^|\/)dot-env$/, '$1.env');

function compareWithFixture(name: string, actual: Record<string, string>): void {
  const dir = path.join(FIXTURES, name);
  if (process.env.UPDATE_GOLDEN) {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, content] of Object.entries(actual)) {
      const dest = path.join(dir, toFixtureName(rel));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf8');
    }
    return;
  }
  const stored: Record<string, string> = {};
  walk(dir, dir, stored);
  const expected: Record<string, string> = {};
  for (const [rel, content] of Object.entries(stored)) expected[fromFixtureName(rel)] = content;
  try {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const rel of Object.keys(expected)) expect({ [rel]: actual[rel] }).toEqual({ [rel]: expected[rel] });
  } catch (e) {
    console.error('setup-docker golden mismatch: run with UPDATE_GOLDEN=1 if the change is intended');
    throw e;
  }
}

describe('setup-docker.js unattended golden output', () => {
  it('--ci --force writes the pinned files and deletes the existing volumes', async () => {
    // The CI pipeline supplies the service key through the environment (ci-pipeline.js).
    process.env.SAP_AI_CORE_SERVICE_KEY = JSON.stringify({
      serviceurls: { AI_API_URL: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com' },
      url: 'https://golden.authentication.eu10.hana.ondemand.com',
      clientid: 'golden-client-id',
      clientsecret: 'golden-client-secret'
    });
    const { setup, calls } = newDockerSetup(DockerSetup, root, { ciMode: true, forceOverwrite: true }, FAKE_VOLUMES);
    await setup.run();
    compareWithFixture('ci', snapshotRoot(root));
    expect(calls.filter((c) => c.startsWith('deleteVolumes'))).toEqual([`deleteVolumes(${FAKE_VOLUMES.join(',')})`]);
    expect(logs.join('\n')).toContain('Unattended mode: Automatically deleting existing volumes');
  });

  it('--config (as runDockerSetup sends it, keepDockerVolumes) writes the pinned files and keeps the volumes', async () => {
    const configFromJson = {
      provider: 'local',
      providerConfig: {},
      baseUrl: 'http://localhost:8080',
      sharedSecrets: {
        VALIDATION_TOKEN_SECRET: HEX64_A,
        METADATA_ENCRYPTION_KEY: HEX64_B,
        OAUTH2_PROXY_CLIENT_SECRET: HEX32,
        OAUTH2_PROXY_COOKIE_SECRET: HEX32
      },
      keepDockerVolumes: true,
      POSTGRES_USER: 'admin_user',
      POSTGRES_PASSWORD: 'golden-postgres-password',
      sapConfig: {
        SAP_AI_CORE_URL: 'https://api.ai.example.invalid',
        AUTH_URL: 'https://auth.example.invalid',
        CLIENT_ID: 'golden-client-id',
        CLIENT_SECRET: 'golden-client-secret',
        SAP_AI_REGION: 'eu10',
        SAP_AI_RESOURCE_GROUP: 'default'
      }
    };
    const { setup, calls } = newDockerSetup(DockerSetup, root, { configFromJson }, FAKE_VOLUMES);
    await setup.run();
    compareWithFixture('config-keep-volumes', snapshotRoot(root));
    expect(calls.filter((c) => c.startsWith('deleteVolumes'))).toEqual([]);
    expect(logs.join('\n')).toContain('Keeping existing volumes');
  });
});
