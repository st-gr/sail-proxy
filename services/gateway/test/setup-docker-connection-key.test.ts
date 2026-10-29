/**
 * docker/setup-docker.js and CONNECTION_CREDENTIAL_KEY (spec 2026-10-23 §8): a fresh admin .env
 * gets a generated key; an existing one keeps its real key; an existing one from before
 * Connections (no key, or the .env.sample placeholder) gets a generated key added and nothing else
 * touched - without it the admin refuses to store any connection credential.
 *
 * Runs DockerSetup against a temporary project root, never the live .env files.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const savedArgv = process.argv;
process.argv = [savedArgv[0], 'setup-docker.js'];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DockerSetup = require('../../../docker/setup-docker.js');
process.argv = savedArgv;

const REAL_KEY = 'c'.repeat(64);
const SAMPLE = path.resolve(__dirname, '../../admin/.env.sample');

let root: string;
let setup: any;
let adminEnv: string;

function writeAdminEnv(lines: string[]): void {
  fs.writeFileSync(adminEnv, lines.join('\n') + '\n', 'utf8');
}
const valueIn = (key: string) =>
  fs.readFileSync(adminEnv, 'utf8').split('\n').filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-docker-conn-key-'));
  fs.mkdirSync(path.join(root, 'services', 'admin'), { recursive: true });
  fs.copyFileSync(SAMPLE, path.join(root, 'services', 'admin', '.env.sample'));
  adminEnv = path.join(root, 'services', 'admin', '.env');
  setup = new DockerSetup({ ciMode: true });
  setup.projectRoot = root;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('setup-docker.js: CONNECTION_CREDENTIAL_KEY', () => {
  it('the .env.sample carries the placeholder line', () => {
    expect(fs.readFileSync(SAMPLE, 'utf8')).toMatch(/^CONNECTION_CREDENTIAL_KEY=changeme$/m);
  });

  it('a fresh admin .env gets a generated key', async () => {
    await setup.setupAdminEnv(null);
    const [key] = valueIn('CONNECTION_CREDENTIAL_KEY');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an existing .env without the key gets one added, everything else untouched', async () => {
    writeAdminEnv(['# mine', 'LOG_LEVEL=debug', 'SIEM_CREDENTIAL_KEY=' + 's'.repeat(64)]);
    const before = fs.readFileSync(adminEnv, 'utf8');
    await setup.setupAdminEnv(null);
    const after = fs.readFileSync(adminEnv, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    const keys = valueIn('CONNECTION_CREDENTIAL_KEY');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an existing .env with the placeholder gets a generated key in its place', async () => {
    writeAdminEnv(['LOG_LEVEL=debug', 'CONNECTION_CREDENTIAL_KEY=changeme']);
    await setup.setupAdminEnv(null);
    const keys = valueIn('CONNECTION_CREDENTIAL_KEY');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(valueIn('LOG_LEVEL')).toEqual(['debug']);
  });

  it('an existing real key is kept, also when the file is rewritten for database credentials', async () => {
    writeAdminEnv(['LOG_LEVEL=debug', `CONNECTION_CREDENTIAL_KEY=${REAL_KEY}`]);
    await setup.setupAdminEnv(null);
    expect(valueIn('CONNECTION_CREDENTIAL_KEY')).toEqual([REAL_KEY]);
    setup.sharedSecrets.POSTGRES_PASSWORD = 'p'.repeat(16);
    await setup.setupAdminEnv(null);
    expect(valueIn('CONNECTION_CREDENTIAL_KEY')).toEqual([REAL_KEY]);
  });
});
