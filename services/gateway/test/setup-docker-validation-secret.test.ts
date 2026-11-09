/**
 * docker/setup-docker.js carries an existing services/gateway/.env's VALIDATION_TOKEN_SECRET over
 * to the admin. When that value is publicly known — the built-in default or the .env.sample
 * placeholder, which the admin and gateway refuse outside development — it must be treated as
 * unset: a fresh secret is generated and written into both existing .env files, so they still
 * match. A real secret is carried over untouched.
 *
 * Runs DockerSetup against a temporary project root, never the live .env files.
 * Lives here because this repo's only Jest runner is services/gateway's (see
 * test/kyma-api-config-sync.test.ts).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { REJECTED_VALIDATION_TOKEN_SECRETS } from '../../../libs/aws-token-validation/validation-token-secrets';

// The script reads its own flags from process.argv when loaded; jest's (--config jest.config.json)
// would be taken for setup-docker.js's --config JSON.
const savedArgv = process.argv;
process.argv = [savedArgv[0], 'setup-docker.js'];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DockerSetup = require('../../../docker/setup-docker.js');
process.argv = savedArgv;

const REAL_SECRET = 'a'.repeat(64);

let root: string;
let setup: any;

function writeEnv(service: string, lines: string[]): string {
  const dir = path.join(root, 'services', service);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

const secretIn = (file: string) =>
  fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith('VALIDATION_TOKEN_SECRET='))?.slice('VALIDATION_TOKEN_SECRET='.length);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-docker-secret-'));
  setup = new DockerSetup({ ciMode: true });
  setup.projectRoot = root;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('setup-docker.js: a publicly known VALIDATION_TOKEN_SECRET in an existing .env is not carried over', () => {
  it('mirrors the shared rejected-secret list (libs/aws-token-validation/validation-token-secrets.ts)', () => {
    expect([...DockerSetup.PUBLICLY_KNOWN_VALIDATION_TOKEN_SECRETS].sort()).toEqual([...REJECTED_VALIDATION_TOKEN_SECRETS].sort());
  });

  it.each(REJECTED_VALIDATION_TOKEN_SECRETS.map(s => [s]))('existing gateway and admin .env with %s: both get the same fresh secret', async (known) => {
    const gatewayEnv = writeEnv('gateway', ['# gateway', `VALIDATION_TOKEN_SECRET=${known}`, 'PORT=3000']);
    const adminEnv = writeEnv('admin', ['# admin', `VALIDATION_TOKEN_SECRET=${known}`, 'PORT=4004']);
    // What setupServiceEnvFiles generated before reading the existing files.
    setup.sharedSecrets.VALIDATION_TOKEN_SECRET = setup.generateSecureToken();

    await setup.setupGatewayEnv({});
    await setup.setupAdminEnv(null);

    const fresh = setup.sharedSecrets.VALIDATION_TOKEN_SECRET;
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(REJECTED_VALIDATION_TOKEN_SECRETS).not.toContain(fresh);
    expect(secretIn(gatewayEnv)).toBe(fresh);
    expect(secretIn(adminEnv)).toBe(fresh);
    // Everything else in the existing files is left as it was.
    expect(fs.readFileSync(gatewayEnv, 'utf8')).toBe(['# gateway', `VALIDATION_TOKEN_SECRET=${fresh}`, 'PORT=3000'].join('\n'));
    // The admin file additionally gets the CONNECTION_CREDENTIAL_KEY it lacked (setup-docker-connection-key.test.ts), appended.
    const admin = fs.readFileSync(adminEnv, 'utf8');
    expect(admin.startsWith(['# admin', `VALIDATION_TOKEN_SECRET=${fresh}`, 'PORT=4004'].join('\n'))).toBe(true);
    expect(admin.split('\n').slice(3).filter((l) => l && !l.startsWith('#'))).toEqual([
      `CONNECTION_CREDENTIAL_KEY=${setup.sharedSecrets.CONNECTION_CREDENTIAL_KEY}`,
    ]);
  });

  it('existing gateway .env with a real secret: carried over, files untouched', async () => {
    const gatewayEnv = writeEnv('gateway', [`VALIDATION_TOKEN_SECRET=${REAL_SECRET}`]);
    const adminEnv = writeEnv('admin', [`VALIDATION_TOKEN_SECRET=${REAL_SECRET}`]);
    setup.sharedSecrets.VALIDATION_TOKEN_SECRET = setup.generateSecureToken();

    await setup.setupGatewayEnv({});
    await setup.setupAdminEnv(null);

    expect(setup.sharedSecrets.VALIDATION_TOKEN_SECRET).toBe(REAL_SECRET);
    expect(secretIn(gatewayEnv)).toBe(REAL_SECRET);
    expect(secretIn(adminEnv)).toBe(REAL_SECRET);
  });
});
