/**
 * The S3 verification script (scripts/file-search-s3-verify.ts): its prefix refusal, the plan it
 * prints, and the request guard. No test here reaches a network: the guard is exercised through a
 * fake axios adapter, and the script itself runs only in --plan mode, which exits before any gateway
 * module (or any S3 code) is loaded. All values are fake.
 */
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
// The module object itself (an ES namespace import cannot be spied on): axios' http adapter calls
// https.request on this same object.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require('https');
import * as os from 'os';
import * as path from 'path';
import axios, { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { checkPrefix, parseArgs, runIdFor, settingsFrom } from '../../scripts/fileSearchS3Verify/options';
import { buildPlan, formatPlan, keyFor, planFingerprint, PROBE_CONTENT, testContent } from '../../scripts/fileSearchS3Verify/plan';
import { checkRequest, countByOp, GUARD_ERROR_CODE, GuardViolation, installGuard, sameAdapter } from '../../scripts/fileSearchS3Verify/guard';
import { executeCommand, prepareEnvironment } from '../../scripts/fileSearchS3Verify/environment';
import { createS3Backend, S3RequestError, S3_PROBE_CONTENT } from '../../src/fileSearch/blob/s3Backend';

const BUCKET = 'example-verify-bucket';
const REGION = 'eu-central-1';
const RUN_ID = 'w7-20261008T120000Z';
const FAKE_ENV = {
  FILE_SEARCH_S3_VERIFY_BUCKET: BUCKET,
  FILE_SEARCH_S3_VERIFY_REGION: REGION,
  FILE_SEARCH_S3_VERIFY_PREFIX: 'grounding-test',
  FILE_SEARCH_S3_ACCESS_KEY_ID: 'AKIDVERIFYTESTONLY',
  FILE_SEARCH_S3_SECRET_ACCESS_KEY: 'verify-test-secret-only',
};
const HOST = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;

describe('options', () => {
  it('defaults to --plan with a generated run id; --execute needs the plan\'s run id', () => {
    const now = new Date('2026-10-08T12:34:56.789Z');
    expect(parseArgs([], now)).toEqual(expect.objectContaining({ mode: 'plan', runId: 'w7-20261008T123456Z', runIdGiven: false, files: 3 }));
    expect(runIdFor(now)).toBe('w7-20261008T123456Z');
    expect(() => parseArgs(['--execute'])).toThrow(/--run-id/);
    expect(() => parseArgs(['--execute', '--run-id', RUN_ID])).toThrow(/--plan-fingerprint/);
    expect(() => parseArgs(['--execute', '--run-id', RUN_ID, '--plan-fingerprint', 'xyz'])).toThrow(/16 hex/);
    expect(parseArgs(['--execute', '--run-id', RUN_ID, '--plan-fingerprint', '0123456789abcdef']))
      .toEqual(expect.objectContaining({ mode: 'execute', planFingerprint: '0123456789abcdef' }));
    expect(() => parseArgs(['--plan', '--execute', '--run-id', RUN_ID, '--plan-fingerprint', '0123456789abcdef'])).toThrow(/exclude/);
    expect(() => parseArgs(['--run-id', 'w7-../x'])).toThrow(/run-id/);
    expect(() => parseArgs(['--files', '0'])).toThrow(/--files/);
    expect(() => parseArgs(['--files', '11'])).toThrow(/--files/);
    expect(() => parseArgs(['--bucket', 'x'])).toThrow(/unknown argument/);
  });

  it.each(['grounding-test', 'grounding-test/', 'grounding-test/w7', 'grounding-test/a/b.c_d-e'])(
    'accepts the prefix %s', (prefix) => {
      expect(checkPrefix(prefix)).toBe(prefix.replace(/\/+$/, ''));
    });

  it.each([
    '', 'grounding-tests', 'grounding-testx/a', 'other/grounding-test', '/grounding-test', 'grounding_test',
    'Grounding-test', 'grounding-test/../other', 'grounding-test/./a', 'grounding-test//a', 'grounding-test/a b',
    'grounding-test/%2e%2e', 'sail-proxy/blobs',
  ])('refuses the prefix %p', (prefix) => {
    expect(() => checkPrefix(prefix)).toThrow(/FILE_SEARCH_S3_VERIFY_PREFIX/);
  });

  it('names missing settings without printing any value, and puts the run folder under the prefix', () => {
    const s = settingsFrom({ ...FAKE_ENV, FILE_SEARCH_S3_VERIFY_PREFIX: 'grounding-test/' }, RUN_ID);
    expect(s.runFolder).toBe(`grounding-test/${RUN_ID}`);
    let message = '';
    try {
      settingsFrom({ FILE_SEARCH_S3_VERIFY_BUCKET: BUCKET, FILE_SEARCH_S3_ACCESS_KEY_ID: 'AKIDVERIFYTESTONLY' }, RUN_ID);
    } catch (e: any) {
      message = e.message;
    }
    expect(message).toContain('FILE_SEARCH_S3_VERIFY_REGION');
    expect(message).toContain('FILE_SEARCH_S3_SECRET_ACCESS_KEY');
    expect(message).not.toContain(BUCKET);
    expect(message).not.toContain('AKIDVERIFYTESTONLY');
    expect(() => settingsFrom({ ...FAKE_ENV, FILE_SEARCH_S3_VERIFY_PREFIX: 'sail-proxy/blobs' }, RUN_ID)).toThrow(/grounding-test/);
  });
});

describe('plan', () => {
  const folder = `grounding-test/${RUN_ID}`;

  it('derives the same content and keys from the same run id, and others from another', () => {
    const a = buildPlan(RUN_ID, folder, 3);
    const b = buildPlan(RUN_ID, folder, 3);
    const c = buildPlan('w7-20261008T120001Z', 'grounding-test/w7-20261008T120001Z', 3);
    expect(a.files.map((f) => f.key)).toEqual(b.files.map((f) => f.key));
    expect(a.files.every((f, i) => f.content.equals(b.files[i].content))).toBe(true);
    expect(new Set([...a.files, ...c.files].map((f) => f.sha256)).size).toBe(6);
    expect(new Set(a.files.map((f) => f.sha256)).size).toBe(3);
  });

  it('keys are content-addressed exactly as the S3 backend derives them, all inside the run folder', () => {
    const plan = buildPlan(RUN_ID, folder, 3);
    const backend = createS3Backend({ bucket: BUCKET, region: REGION, prefix: folder, endpoint: '' },
      { credentials: { accessKeyId: 'AKIDVERIFYTESTONLY', secretAccessKey: 'verify-test-secret-only' } });
    for (const f of plan.files) {
      expect(f.sha256).toBe(crypto.createHash('sha256').update(f.content).digest('hex'));
      expect(f.key).toBe(backend.keyFor(f.sha256));
      expect(f.key).toBe(keyFor(folder, f.sha256));
      expect(f.key.startsWith(`${folder}/`)).toBe(true);
    }
    expect(plan.cleanup).toEqual(plan.files.map((f) => f.key));
    expect(testContent(RUN_ID, 0).length).toBe(1024);
    // The probe object: the backend's own content and key, never in the cleanup list.
    expect(PROBE_CONTENT.equals(S3_PROBE_CONTENT)).toBe(true);
    expect(plan.probeKey).toBe(backend.keyFor(crypto.createHash('sha256').update(S3_PROBE_CONTENT).digest('hex')));
    expect(plan.cleanup).not.toContain(plan.probeKey);
  });

  it('the fingerprint changes with the bucket, the region, the run id, the file count and the prefix', () => {
    const target = { bucket: BUCKET, region: REGION };
    const base = planFingerprint(buildPlan(RUN_ID, folder, 3), target);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(planFingerprint(buildPlan(RUN_ID, folder, 3), target)).toBe(base);
    expect(planFingerprint(buildPlan('w7-20261008T120001Z', 'grounding-test/w7-20261008T120001Z', 3), target)).not.toBe(base);
    expect(planFingerprint(buildPlan(RUN_ID, folder, 2), target)).not.toBe(base);
    expect(planFingerprint(buildPlan(RUN_ID, `grounding-test/sub/${RUN_ID}`, 3), target)).not.toBe(base);
    expect(planFingerprint(buildPlan(RUN_ID, folder, 3), { bucket: 'another-verify-bucket', region: REGION })).not.toBe(base);
    expect(planFingerprint(buildPlan(RUN_ID, folder, 3), { bucket: BUCKET, region: 'us-east-1' })).not.toBe(base);
  });

  it('counts the requests per operation for three files', () => {
    const plan = buildPlan(RUN_ID, folder, 3);
    expect(plan.totals).toEqual({ PutObject: 8, GetObject: 17, DeleteObject: 9, HeadObject: 6 });
    expect(plan.steps).toHaveLength(12);
  });

  it('prints the folder, every key, the counts, the cleanup list and the exact execute command, never the bucket', () => {
    const plan = buildPlan(RUN_ID, folder, 3);
    const fingerprint = planFingerprint(plan, { bucket: BUCKET, region: REGION });
    const execute = executeCommand({ runId: RUN_ID, files: 3, env: '/path/to/gateway/.env' }, fingerprint);
    const text = formatPlan(plan, { execute, fingerprint });
    expect(text).toContain(`Run folder in the bucket: ${folder}/`);
    for (const f of plan.files) expect(text.split(f.key).length - 1).toBe(2); // keys + cleanup list
    expect(text).toContain('Requests per operation: PutObject 8, GetObject 17, DeleteObject 9, HeadObject 6 (total 40)');
    expect(text).toContain(`Left in place: 1 probe object (${plan.probeKey})`);
    expect(text.split(plan.probeKey).length - 1).toBe(1);
    expect(text).toContain(`Plan fingerprint: ${fingerprint}`);
    expect(text).toContain(`--execute --run-id ${RUN_ID} --plan-fingerprint ${fingerprint} --files 3 --env /path/to/gateway/.env`);
    expect(text).toContain('nothing has been sent');
    expect(text).not.toContain(BUCKET);
    expect(text).not.toContain(REGION);
  });
});

describe('request guard', () => {
  const folder = `grounding-test/${RUN_ID}`;
  const plan = buildPlan(RUN_ID, folder, 3);
  const scope = { bucket: BUCKET, region: REGION, runFolder: folder, keys: [...plan.files.map((f) => f.key), plan.probeKey] };
  const key = plan.files[0].key;

  it('allows the planned keys (files and the probe object) only', () => {
    expect(checkRequest('put', `${HOST}/${plan.probeKey}`, scope)).toEqual({ op: 'PutObject', key: plan.probeKey });
    expect(checkRequest('put', `${HOST}/${key}`, scope)).toEqual({ op: 'PutObject', key });
    expect(checkRequest('GET', `${HOST}/${key}`, scope)).toEqual({ op: 'GetObject', key });
    expect(checkRequest('delete', `${HOST}/${key}`, scope)).toEqual({ op: 'DeleteObject', key });
    expect(checkRequest('head', `${HOST}/${key}`, scope)).toEqual({ op: 'HeadObject', key });
  });

  const otherSha = crypto.createHash('sha256').update('not planned').digest('hex');
  it.each([
    ['a listing of the bucket', 'get', `${HOST}/?list-type=2&prefix=grounding-test/`],
    ['HeadBucket', 'head', `${HOST}/`],
    ['GET on the bucket', 'get', `${HOST}/`],
    ['DELETE on the bucket', 'delete', `${HOST}/`],
    ['a sub-resource on a key', 'get', `${HOST}/${key}?acl`],
    ['a delete-objects batch', 'post', `${HOST}/?delete`],
    ['POST on a key', 'post', `${HOST}/${key}`],
    ['plain http', 'get', `http://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`],
    ['another host', 'get', `https://other-bucket.s3.${REGION}.amazonaws.com/${key}`],
    ['another region', 'get', `https://${BUCKET}.s3.us-east-1.amazonaws.com/${key}`],
    ['path-style addressing', 'get', `https://s3.${REGION}.amazonaws.com/${BUCKET}/${key}`],
    ['a key in the run folder that is not planned', 'get', `${HOST}/${folder}/${otherSha.slice(0, 2)}/${otherSha}`],
    ['a key beside the run folder', 'get', `${HOST}/grounding-test/${otherSha}`],
    ['a key outside grounding-test', 'delete', `${HOST}/sail-proxy/blobs/${otherSha.slice(0, 2)}/${otherSha}`],
    ['a dot-dot escape', 'delete', `${HOST}/${folder}/../other/${otherSha}`],
    ['an encoded dot-dot escape', 'delete', `${HOST}/${folder}/%2e%2e/%2e%2e/x`],
    ['userinfo', 'get', `https://user:pw@${BUCKET}.s3.${REGION}.amazonaws.com/${key}`],
    ['a relative URL', 'get', `/${key}`],
  ])('refuses %s', (_name, method, url) => {
    expect(() => checkRequest(method, url, scope)).toThrow(/verification guard/);
  });

  it('compares adapters by value: the merged copy of the default list is the same adapter', () => {
    expect(sameAdapter(['xhr', 'http', 'fetch'], ['xhr', 'http', 'fetch'])).toBe(true);
    expect(sameAdapter(['http'], ['xhr', 'http', 'fetch'])).toBe(false);
    const fn = async () => ({}) as any;
    expect(sameAdapter(fn, fn)).toBe(true);
    expect(sameAdapter(fn, ['xhr', 'http', 'fetch'])).toBe(false);
  });

  it('never names the bucket or host in a refusal', () => {
    expect.assertions(2);
    try {
      checkRequest('get', `${HOST}/?list-type=2`, scope);
    } catch (e: any) {
      expect(e.message).not.toContain(BUCKET);
      expect(e.code).toBe(GUARD_ERROR_CODE);
    }
  });

  describe('installed on an axios instance', () => {
    function fakeTransport() {
      const sent: string[] = [];
      const stored = new Map<string, Buffer>();
      const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
        const method = String(config.method).toUpperCase();
        sent.push(`${method} ${config.url}`);
        if (method === 'PUT') stored.set(config.url!, Buffer.from(config.data ?? ''));
        const data = method === 'GET' ? stored.get(config.url!) ?? Buffer.alloc(0) : Buffer.alloc(0);
        return { data, status: 200, statusText: 'OK', headers: {}, config };
      };
      return { sent, adapter };
    }

    it('refuses before the transport sees the request, and records what it allowed', async () => {
      const instance = axios.create();
      const { sent, adapter } = fakeTransport();
      instance.defaults.adapter = adapter;
      const guard = installGuard(instance, scope);
      await expect(instance.request({ method: 'HEAD', url: `${HOST}/` })).rejects.toThrow(/verification guard/);
      await instance.request({ method: 'PUT', url: `${HOST}/${key}`, data: 'x' });
      await expect(instance.request({ method: 'GET', url: `${HOST}/?list-type=2` })).rejects.toThrow(/verification guard/);
      await expect(instance.request({ method: 'DELETE', url: `${HOST}/grounding-test/${otherSha}` })).rejects.toThrow(/verification guard/);
      expect(sent).toEqual([`PUT ${HOST}/${key}`]);
      expect(guard.violations).toHaveLength(3);
      expect(guard.created()).toEqual([key]);
      expect(countByOp(guard.allowed)).toEqual({ PutObject: 1, GetObject: 0, DeleteObject: 0, HeadObject: 0 });
      guard.eject();
      await instance.request({ method: 'GET', url: `${HOST}/?list-type=2` });
      expect(sent).toHaveLength(2);
    });

    it('checks the URL axios will send: params and baseURL are applied before the check', async () => {
      const instance = axios.create();
      const { sent, adapter } = fakeTransport();
      instance.defaults.adapter = adapter;
      const guard = installGuard(instance, scope);
      await expect(instance.request({ method: 'GET', url: `${HOST}/${key}`, params: { 'list-type': 2 } })).rejects.toThrow(/query string/);
      await expect(instance.request({ method: 'GET', baseURL: HOST, url: '/', params: { prefix: 'grounding-test/' } })).rejects.toThrow(/verification guard/);
      await expect(instance.request({ method: 'GET', url: `${HOST}/${key}`, adapter: async (c: any) => ({ data: '', status: 200, statusText: 'OK', headers: {}, config: c }) }))
        .rejects.toThrow(/own adapter/);
      await instance.request({ method: 'GET', baseURL: HOST, url: `/${key}` });
      expect(sent).toEqual([`GET /${key}`]);
      expect(guard.allowed).toEqual([{ op: 'GetObject', key }]);
      guard.eject();
    });

    it('on an instance that keeps the real default adapter, a planned request reaches the transport', async () => {
      // https.request is stubbed below the adapter, so nothing leaves the process.
      const transport = jest.spyOn(https, 'request').mockImplementation(((..._args: unknown[]) => {
        throw Object.assign(new Error('stubbed transport'), { code: 'ESTUBBED' });
      }) as any);
      try {
        const instance = axios.create();
        expect(Array.isArray(instance.defaults.adapter)).toBe(true);
        const guard = installGuard(instance, scope);
        const planned = await instance.request({ method: 'GET', url: `${HOST}/${key}` }).catch((e) => e);
        expect(planned.message).toBe('stubbed transport');
        expect(planned).not.toBeInstanceOf(GuardViolation);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(guard.allowed).toEqual([{ op: 'GetObject', key }]);
        expect(guard.violations).toEqual([]);
        const unplanned = await instance.request({ method: 'GET', url: `${HOST}/grounding-test/${otherSha}` }).catch((e) => e);
        expect(unplanned).toBeInstanceOf(GuardViolation);
        expect(transport).toHaveBeenCalledTimes(1);
        guard.eject();
      } finally {
        transport.mockRestore();
      }
    });

    it('refuses to install beside an earlier request interceptor (axios would run it after the guard)', () => {
      const instance = axios.create();
      instance.interceptors.request.use((c) => c);
      expect(() => installGuard(instance, scope)).toThrow(/already has request interceptors/);
    });

    it('stops the real S3 backend\'s requests on the default instance before they are sent', async () => {
      const { sent, adapter } = fakeTransport();
      const original = axios.defaults.adapter;
      axios.defaults.adapter = adapter;
      const guard = installGuard(axios, scope);
      try {
        const backend = createS3Backend({ bucket: BUCKET, region: REGION, prefix: folder, endpoint: '' },
          { credentials: { accessKeyId: 'AKIDVERIFYTESTONLY', secretAccessKey: 'verify-test-secret-only' } });
        await backend.probe();
        await backend.put(plan.files[1].sha256, plan.files[1].content, 'application/octet-stream');
        const refused = await backend.get(otherSha).catch((e) => e);
        expect(refused).toBeInstanceOf(S3RequestError);
        expect(refused.code).toBe(GUARD_ERROR_CODE);
        // A backend whose prefix is wider than the run folder is stopped too.
        const wide = createS3Backend({ bucket: BUCKET, region: REGION, prefix: 'grounding-test', endpoint: '' },
          { credentials: { accessKeyId: 'AKIDVERIFYTESTONLY', secretAccessKey: 'verify-test-secret-only' } });
        await expect(wide.delete(otherSha)).rejects.toBeInstanceOf(S3RequestError);
        expect(sent).toEqual([`PUT ${HOST}/${plan.probeKey}`, `GET ${HOST}/${plan.probeKey}`, `PUT ${HOST}/${plan.files[1].key}`]);
        expect(guard.violations).toHaveLength(2);
      } finally {
        guard.eject();
        axios.defaults.adapter = original;
      }
    });
  });
});

describe('environment and the --plan run', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's3verify-test-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('blanks every infrastructure URL and points blob_storage at the run folder', () => {
    const env: NodeJS.ProcessEnv = {
      VALKEY_URL: 'redis://localhost:6379', ADMIN_SERVICE_URL: 'http://localhost:4004',
      FILE_SEARCH_DATABASE_URL: 'postgresql://dev', POSTGRES_URL: 'postgresql://dev',
    };
    const settings = settingsFrom(FAKE_ENV, RUN_ID);
    const { configFile } = prepareEnvironment(settings, env, tmp);
    expect(env.VALKEY_URL).toBe('');
    expect(env.ADMIN_SERVICE_URL).toBe('');
    expect(env.FILE_SEARCH_DATABASE_URL).toBe('');
    expect(env.POSTGRES_URL).toBe('');
    expect(env.GATEWAY_STANDALONE).toBe('true');
    expect(env.CONFIG_FILE_PATH).toBe(configFile);
    const blob = JSON.parse(fs.readFileSync(configFile, 'utf8')).api_config.capabilities.file_search.blob_storage;
    expect(blob).toEqual({ backend: 's3', s3: { bucket: BUCKET, prefix: `grounding-test/${RUN_ID}`, endpoint: '', region: REGION } });
  });

  function runPlan(envValues: Record<string, string>, args: string[]): { code: number; out: string } {
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, Object.entries(envValues).map(([k, v]) => `${k}=${v}`).join('\n'));
    try {
      const out = execFileSync('npx', ['ts-node', '-r', 'tsconfig-paths/register', '--transpile-only',
        'scripts/file-search-s3-verify.ts', '--env', envFile, ...args],
      { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FILE_SEARCH_S3_ACCESS_KEY_ID: '', FILE_SEARCH_S3_SECRET_ACCESS_KEY: '' } });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  it('--plan prints the plan and exits 0 without loading any S3 code', () => {
    const { code, out } = runPlan(FAKE_ENV, ['--run-id', RUN_ID]);
    expect(code).toBe(0);
    const plan = buildPlan(RUN_ID, `grounding-test/${RUN_ID}`, 3);
    for (const f of plan.files) expect(out).toContain(f.key);
    expect(out).toContain('(total 40)');
    expect(out).toContain(`Left in place: 1 probe object (${plan.probeKey})`);
    expect(out).not.toContain(BUCKET);
    expect(out).not.toContain('AKIDVERIFYTESTONLY');
    expect(out).not.toContain('verify-test-secret-only');
  }, 120000);

  it('refuses a prefix outside grounding-test with exit code 2', () => {
    const { code, out } = runPlan({ ...FAKE_ENV, FILE_SEARCH_S3_VERIFY_PREFIX: 'sail-proxy/blobs' },
      ['--execute', '--run-id', RUN_ID, '--plan-fingerprint', '0123456789abcdef']);
    expect(code).toBe(2);
    expect(out).toContain('refused');
    expect(out).not.toContain(BUCKET);
  }, 120000);

  it.each([
    ['bucket', { FILE_SEARCH_S3_VERIFY_BUCKET: 'another-verify-bucket' }],
    ['region', { FILE_SEARCH_S3_VERIFY_REGION: 'us-east-1' }],
  ])('--execute refuses the approved fingerprint once the env file names another %s (exit 2)', (_what, change) => {
    const planned = runPlan(FAKE_ENV, ['--run-id', RUN_ID]);
    const fingerprint = /Plan fingerprint: ([0-9a-f]{16})/.exec(planned.out)?.[1];
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const { code, out } = runPlan({ ...FAKE_ENV, ...change }, ['--execute', '--run-id', RUN_ID, '--plan-fingerprint', fingerprint!]);
    expect(code).toBe(2);
    expect(out).toContain('--plan-fingerprint does not match');
    expect(out).not.toContain('another-verify-bucket');
  }, 120000);

  it('--execute refuses a fingerprint that does not match the plan it would run (exit 2, nothing loaded)', () => {
    const { code, out } = runPlan(FAKE_ENV, ['--execute', '--run-id', RUN_ID, '--plan-fingerprint', '0123456789abcdef']);
    expect(code).toBe(2);
    expect(out).toContain('--plan-fingerprint does not match');
    expect(out).not.toContain(BUCKET);
  }, 120000);
});
