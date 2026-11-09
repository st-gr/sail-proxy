import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';
import { buildS3AuthHeader } from '@libs/aws-signing/s3Signer';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const s3 = require('../../../ci/scripts/file-search-test-s3.js');

const FULL_ENV = {
  FILE_SEARCH_TEST_S3_ENDPOINT: 'http://127.0.0.1:59000',
  FILE_SEARCH_TEST_S3_BUCKET: 'fs-test-blobs',
  FILE_SEARCH_TEST_S3_REGION: 'us-east-1',
  FILE_SEARCH_TEST_S3_ACCESS_KEY_ID: 'id',
  FILE_SEARCH_TEST_S3_SECRET_ACCESS_KEY: 'secret',
};
const CREDENTIALS = { accessKeyId: 'fstestabc', secretAccessKey: 'not-a-real-secret-0123456789' };

function fakeDocker(psOutput = '') {
  const calls: Array<{ command: string; options: any }> = [];
  const exec = jest.fn<any>(async (command: string, options?: any) => {
    calls.push({ command, options });
    return { stdout: command.startsWith('docker ps') ? psOutput : 'containerid\n' };
  });
  return { exec, calls };
}

const response = (status: number, body = '') => ({ status, text: async () => body });

describe('ci/scripts/file-search-test-s3', () => {
  it('uses 127.0.0.1:59000, clear of every service, pgvector, Colima and SIEM port', () => {
    expect(s3.HOST).toBe('127.0.0.1');
    expect(s3.PORT).toBe(59000);
    for (const port of [3000, 4004, 5432, 6379, 8080, 9000, 19000, 55432, 55434]) expect(s3.RESERVED_PORTS).toContain(port);
    expect(s3.RESERVED_PORTS).not.toContain(s3.PORT);
  });

  it('pins the image and the documented fallback by digest', () => {
    expect(s3.IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(s3.FALLBACK_IMAGE).toMatch(/^versity\/versitygw:v[\d.]+@sha256:[0-9a-f]{64}$/);
  });

  it('exports exactly the FILE_SEARCH_TEST_S3_* names, never the product FILE_SEARCH_S3_* ones', () => {
    for (const name of Object.values(s3.ENV) as string[]) expect(name).toMatch(/^FILE_SEARCH_TEST_S3_/);
  });

  it('accepts only loopback endpoints', () => {
    expect(s3.assertLoopbackEndpoint('http://127.0.0.1:59000/')).toBe('http://127.0.0.1:59000');
    expect(s3.assertLoopbackEndpoint('http://localhost:59000')).toBe('http://localhost:59000');
    for (const bad of ['https://s3.eu-central-1.amazonaws.com', 'http://bucket.s3.amazonaws.com', 'http://10.0.0.5:9000',
      'http://127.0.0.1.example.test:9000', 'ftp://127.0.0.1', 'not a url']) {
      expect(() => s3.assertLoopbackEndpoint(bad)).toThrow(/FILE_SEARCH_TEST_S3_ENDPOINT/);
    }
  });

  it('the suites\' gate: null without an endpoint, loud on AWS or a partial config, ignores the product variables', () => {
    expect(s3.s3TestConfigFromEnv({ FILE_SEARCH_S3_ACCESS_KEY_ID: 'product-key-id', FILE_SEARCH_S3_SECRET_ACCESS_KEY: 'x' })).toBeNull();
    expect(s3.s3TestConfigFromEnv(FULL_ENV)).toEqual({
      endpoint: 'http://127.0.0.1:59000', bucket: 'fs-test-blobs', region: 'us-east-1', accessKeyId: 'id', secretAccessKey: 'secret',
    });
    expect(() => s3.s3TestConfigFromEnv({ ...FULL_ENV, FILE_SEARCH_TEST_S3_ENDPOINT: 'https://s3.amazonaws.com' })).toThrow(/127\.0\.0\.1 or localhost/);
    expect(() => s3.s3TestConfigFromEnv({ ...FULL_ENV, FILE_SEARCH_TEST_S3_SECRET_ACCESS_KEY: '' }))
      .toThrow('FILE_SEARCH_TEST_S3_ENDPOINT is set but FILE_SEARCH_TEST_S3_SECRET_ACCESS_KEY is not');
  });

  it('names containers fs-test-minio-<suffix> and makes random credentials per run', () => {
    expect(s3.containerName('ab12')).toBe('fs-test-minio-ab12');
    expect(s3.containerName()).toMatch(/^fs-test-minio-[0-9a-f]{8}$/);
    expect(() => s3.containerName('x; rm -rf /')).toThrow('invalid MinIO container name');
    const a = s3.randomCredentials();
    const b = s3.randomCredentials();
    expect(a.accessKeyId).not.toBe(b.accessKeyId);
    expect(a.secretAccessKey).not.toBe(b.secretAccessKey);
    expect(a.secretAccessKey.length).toBeGreaterThanOrEqual(32);
  });

  it('finds the containers that publish a port', async () => {
    const { exec } = fakeDocker('filesearch-test-pg\t0.0.0.0:55432->5432/tcp\nold\t127.0.0.1:59000->9000/tcp\nother\t0.0.0.0:590001->1/tcp\nidle\t\n');
    expect(await s3.dockerPortHolders(exec, 59000)).toEqual(['old']);
  });

  it('refuses to start, touching nothing, when a container already publishes the port', async () => {
    const { exec, calls } = fakeDocker('fs-test-minio-old\t127.0.0.1:59000->9000/tcp\n');
    await expect(s3.startMinio({ exec, log: () => {}, portCheck: async () => false }))
      .rejects.toThrow('port 59000 is already published by container(s) fs-test-minio-old');
    expect(calls.map((c) => c.command)).toEqual(['docker ps --format "{{.Names}}\t{{.Ports}}"']);
  });

  it('refuses to start when anything else listens on the port', async () => {
    const { exec, calls } = fakeDocker();
    await expect(s3.startMinio({ exec, log: () => {}, portCheck: async () => true }))
      .rejects.toThrow('something already listens on 127.0.0.1:59000');
    expect(calls).toHaveLength(1);
  });

  it('starts the container with the credentials in its environment, never in argv, waits, then creates the bucket', async () => {
    const { exec, calls } = fakeDocker();
    let readyChecks = 0;
    const requests: Array<{ url: string; init: any }> = [];
    const fetchImpl = jest.fn<any>(async (url: string, init?: any) => {
      requests.push({ url, init });
      if (url.endsWith('/minio/health/ready')) {
        if (++readyChecks < 3) throw new Error('ECONNREFUSED');
        return response(200);
      }
      return response(200);
    });
    const result = await s3.startMinio({
      exec, log: () => {}, name: 'fs-test-minio-unit', credentials: CREDENTIALS, fetchImpl, sleep: async () => {}, portCheck: async () => false,
    });
    const run = calls[1];
    expect(run.command).toBe(`docker run -d --name fs-test-minio-unit -p 127.0.0.1:59000:9000 -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD ${s3.IMAGE} server /data`);
    expect(run.command).not.toContain(CREDENTIALS.secretAccessKey);
    expect(run.options.env.MINIO_ROOT_USER).toBe(CREDENTIALS.accessKeyId);
    expect(run.options.env.MINIO_ROOT_PASSWORD).toBe(CREDENTIALS.secretAccessKey);

    const put = requests[requests.length - 1];
    expect(put.url).toBe('http://127.0.0.1:59000/fs-test-blobs');
    expect(put.init.method).toBe('PUT');
    expect(put.init.redirect).toBe('manual');
    // Every request is bounded: a check that never settles is aborted and retried, never waited on forever.
    for (const request of requests) expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    expect(put.init.headers.authorization).toBe(buildS3AuthHeader({
      method: 'PUT', host: '127.0.0.1:59000', pathname: '/fs-test-blobs',
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1', amzDate: put.init.headers['x-amz-date'], ...CREDENTIALS,
    }));
    expect(readyChecks).toBe(3);
    expect(result).toEqual({
      container: 'fs-test-minio-unit',
      env: {
        FILE_SEARCH_TEST_S3_ENDPOINT: 'http://127.0.0.1:59000',
        FILE_SEARCH_TEST_S3_BUCKET: 'fs-test-blobs',
        FILE_SEARCH_TEST_S3_REGION: 'us-east-1',
        FILE_SEARCH_TEST_S3_ACCESS_KEY_ID: CREDENTIALS.accessKeyId,
        FILE_SEARCH_TEST_S3_SECRET_ACCESS_KEY: CREDENTIALS.secretAccessKey,
      },
    });
  });

  it('gives up with a clear message when MinIO never becomes ready, and removes the container by name', async () => {
    const { exec, calls } = fakeDocker();
    const fetchImpl = jest.fn<any>(async () => response(503));
    await expect(s3.startMinio({ exec, log: () => {}, name: 'fs-test-minio-unit', fetchImpl, sleep: async () => {}, portCheck: async () => false }))
      .rejects.toThrow('test MinIO fs-test-minio-unit (removed): MinIO container fs-test-minio-unit did not become ready within 60 seconds');
    expect(calls[calls.length - 1].command).toBe('docker rm -f -v fs-test-minio-unit');
  });

  it('removes the container by name when the bucket cannot be created', async () => {
    const { exec, calls } = fakeDocker();
    const fetchImpl = jest.fn<any>(async (url: string) => (url.endsWith('/minio/health/ready')
      ? response(200) : response(403, '<Error><Code>AccessDenied</Code></Error>')));
    await expect(s3.startMinio({ exec, log: () => {}, name: 'fs-test-minio-unit', fetchImpl, sleep: async () => {}, portCheck: async () => false }))
      .rejects.toThrow('test MinIO fs-test-minio-unit (removed): creating the test bucket failed: HTTP 403 AccessDenied');
    expect(calls.map((c) => c.command).filter((c) => c.startsWith('docker rm'))).toEqual(['docker rm -f -v fs-test-minio-unit']);
  });

  it('bounds docker run (and its image pull) by a timeout, with a clear message, and cleans up', async () => {
    const calls: Array<{ command: string; options: any }> = [];
    const exec = jest.fn<any>(async (command: string, options?: any) => {
      calls.push({ command, options });
      if (command.startsWith('docker run')) throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
      return { stdout: '' };
    });
    await expect(s3.startMinio({ exec, log: () => {}, name: 'fs-test-minio-unit', fetchImpl: jest.fn<any>(), portCheck: async () => false }))
      .rejects.toThrow('test MinIO fs-test-minio-unit (removed): docker run (with the image pull) did not finish within 5 minutes');
    expect(calls.find((c) => c.command.startsWith('docker run'))?.options.timeout).toBe(5 * 60 * 1000);
    expect(calls[calls.length - 1].command).toBe('docker rm -f -v fs-test-minio-unit');
  });

  it('createBucket accepts our own existing bucket, reports the S3 code otherwise, and never signs for a remote endpoint', async () => {
    const args = { endpoint: 'http://127.0.0.1:59000', bucket: 'fs-test-blobs', region: 'us-east-1', ...CREDENTIALS };
    await expect(s3.createBucket({ ...args, fetchImpl: async () => response(409, '<Error><Code>BucketAlreadyOwnedByYou</Code></Error>') })).resolves.toBeUndefined();
    await expect(s3.createBucket({ ...args, fetchImpl: async () => response(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>') }))
      .rejects.toThrow('creating the test bucket failed: HTTP 403 SignatureDoesNotMatch');
    const fetchImpl = jest.fn<any>();
    await expect(s3.createBucket({ ...args, endpoint: 'https://s3.amazonaws.com', fetchImpl })).rejects.toThrow(/127\.0\.0\.1 or localhost/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops by name with docker rm -f -v and refuses anything that is not an fs-test-minio container', async () => {
    const { exec, calls } = fakeDocker();
    await s3.stopMinio({ exec, name: 'fs-test-minio-unit' });
    expect(calls.map((c) => c.command)).toEqual(['docker rm -f -v fs-test-minio-unit']);
    for (const name of ['filesearch-test-pg', 'sail-ci-pgvector', 'siem-minio', '', undefined, 'fs-test-minio-x; docker system prune']) {
      await expect(s3.stopMinio({ exec, name })).rejects.toThrow('refusing to remove');
    }
    expect(calls).toHaveLength(1);
  });

  it('ensureFileSearchTestS3 reuses a given loopback configuration and starts nothing', async () => {
    const { exec } = fakeDocker();
    const result = await s3.ensureFileSearchTestS3({ env: FULL_ENV, exec, log: () => {} });
    expect(exec).not.toHaveBeenCalled();
    expect(result).toEqual({ container: null, env: FULL_ENV });
    await expect(s3.ensureFileSearchTestS3({ env: { ...FULL_ENV, FILE_SEARCH_TEST_S3_ENDPOINT: 'https://s3.amazonaws.com' }, exec, log: () => {} }))
      .rejects.toThrow(/127\.0\.0\.1 or localhost/);
  });

  it('formats the env for GITHUB_ENV and for a shell, with the container name for stop', () => {
    const started = { container: 'fs-test-minio-unit', env: FULL_ENV };
    expect(s3.githubEnvLines(started)).toBe(`${Object.entries(FULL_ENV).map(([k, v]) => `${k}=${v}`).join('\n')}\nFILE_SEARCH_TEST_S3_CONTAINER=fs-test-minio-unit\n`);
    expect(s3.shellExportLines(started)).toContain("export FILE_SEARCH_TEST_S3_CONTAINER='fs-test-minio-unit'\n");
  });

  it('the signer it transpiles at runtime imports Node builtins only', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../libs/aws-signing/s3Signer.ts'), 'utf8');
    const specifiers = [...source.matchAll(/(?:from\s+|require\(\s*|import\s*\(\s*|^import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(builtinModules).toContain(specifier.replace(/^node:/, ''));
  });

  it('loads the repo\'s own SigV4 signer from its TypeScript source', () => {
    const sign = s3.loadSigner();
    const params = {
      method: 'PUT', host: '127.0.0.1:59000', pathname: '/fs-test-blobs', payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1', amzDate: '20261008T120000Z', ...CREDENTIALS,
    };
    expect(sign(params)).toBe(buildS3AuthHeader(params));
  });
});

describe('the start command never passes silently', () => {
  it('exits 1 when its work stalls with nothing left to keep the process alive', () => {
    // A preload makes every child_process.exec call (the docker ps of the port check) never answer
    // and hold no handle, so main never settles and the event loop empties - what a CI step once did,
    // exiting 0 with no output. Nothing reaches docker.
    const { spawnSync } = require('child_process');
    const preload = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'fs-s3-guard-')), 'stall.js');
    fs.writeFileSync(preload, "require('child_process').exec = function () { return {}; };\n");
    const script = path.resolve(__dirname, '../../../ci/scripts/file-search-test-s3.js');
    const env = { ...process.env, GITHUB_ENV: '' };
    const result = spawnSync(process.execPath, ['-r', preload, script, 'start'], { env, encoding: 'utf8', timeout: 20000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exited before finishing');
    expect(result.stdout).toBe('');
  });
});
