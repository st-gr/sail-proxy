'use strict';

/**
 * An S3-compatible store (MinIO) for the file_search S3 suites, locally and on GitHub.
 *
 * The suites gate on FILE_SEARCH_TEST_S3_* only, never on the product FILE_SEARCH_S3_* variables:
 * a developer's gateway .env may hold real AWS keys, and no test run may reach AWS. Every endpoint
 * this helper hands out or accepts must be 127.0.0.1 or localhost.
 *
 * Image: the official MinIO images (docker.io/minio/minio, quay.io/minio/minio) are no longer
 * pullable anonymously. pgsty/minio is the MinIO community fork (github.com/pgsty/minio), AGPLv3,
 * used here for CI/tests only; same command line (`server /data`, MINIO_ROOT_USER /
 * MINIO_ROOT_PASSWORD), pinned by digest. Fallback if it disappears: versitygw (FALLBACK_IMAGE).
 *
 * Port 59000 on 127.0.0.1, console unpublished. 3000, 4004, 5432, 5556, 6379, 8080, 11434 are the
 * services, 55432/55434 the pgvector containers, 9000 a common dev and Colima listener and 19000 the
 * SIEM MinIO recipe. Before starting, the helper checks `docker ps` and the port itself and fails
 * with the holder's name rather than steal or kill anything.
 *
 * Credentials are random per run and reach the container through the environment of `docker run`,
 * never its argv. The bucket is created with one signed PUT through the repo's own SigV4 signer
 * (libs/aws-signing/s3Signer.ts), so neither the AWS SDK nor the mc client is needed.
 *
 * CLI (GitHub step, or a local shell):
 *   node ci/scripts/file-search-test-s3.js start   # with GITHUB_ENV: appends the env there and masks the secret;
 *                                                  # otherwise prints `export …` lines for eval
 *   node ci/scripts/file-search-test-s3.js stop [name]   # name defaults to FILE_SEARCH_TEST_S3_CONTAINER
 */

const { exec: execCallback } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { promisify } = require('util');

const IMAGE = 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372';
// Not wired; a single-command S3 gateway that checks SigV4: `versitygw --access … --secret … posix /data`.
const FALLBACK_IMAGE = 'versity/versitygw:v1.8.0@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499';
const CONTAINER_PREFIX = 'fs-test-minio-';
const CONTAINER_NAME_RE = /^fs-test-minio-[a-z0-9]{1,32}$/;
const HOST = '127.0.0.1';
const PORT = 59000;
const RESERVED_PORTS = [443, 3000, 4004, 4180, 5432, 5556, 6379, 8080, 9000, 11434, 19000, 55432, 55434];
const BUCKET = 'fs-test-blobs';
const REGION = 'us-east-1';
const READY_ATTEMPTS = 60;
const READY_ATTEMPT_TIMEOUT_MS = 2000;
const BUCKET_TIMEOUT_MS = 10000;
const DOCKER_RUN_TIMEOUT_MS = 5 * 60 * 1000; // covers the image pull
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The names Tasks 3-5's suites read. The container name is for `stop` only. */
const ENV = {
  endpoint: 'FILE_SEARCH_TEST_S3_ENDPOINT',
  bucket: 'FILE_SEARCH_TEST_S3_BUCKET',
  region: 'FILE_SEARCH_TEST_S3_REGION',
  accessKeyId: 'FILE_SEARCH_TEST_S3_ACCESS_KEY_ID',
  secretAccessKey: 'FILE_SEARCH_TEST_S3_SECRET_ACCESS_KEY',
  container: 'FILE_SEARCH_TEST_S3_CONTAINER',
};

/** Throws unless the endpoint is http(s) on 127.0.0.1 or localhost. */
function assertLoopbackEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error(`${ENV.endpoint} is not a URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${ENV.endpoint} must be http(s) on 127.0.0.1 or localhost: the S3 tests never leave this machine`);
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * The test S3 from FILE_SEARCH_TEST_S3_*, or null when the endpoint is unset (the suites then skip).
 * Throws on a non-loopback endpoint or a partial configuration rather than skip silently.
 */
function s3TestConfigFromEnv(env) {
  if (!env[ENV.endpoint]) return null;
  const endpoint = assertLoopbackEndpoint(env[ENV.endpoint]);
  const config = {
    endpoint,
    bucket: env[ENV.bucket],
    region: env[ENV.region],
    accessKeyId: env[ENV.accessKeyId],
    secretAccessKey: env[ENV.secretAccessKey],
  };
  const missing = Object.keys(config).filter((key) => !config[key]).map((key) => ENV[key]);
  if (missing.length) throw new Error(`${ENV.endpoint} is set but ${missing.join(', ')} is not`);
  return config;
}

function needsContainer(env) {
  return !env[ENV.endpoint];
}

function containerName(suffix = crypto.randomBytes(4).toString('hex')) {
  const name = `${CONTAINER_PREFIX}${suffix}`;
  if (!CONTAINER_NAME_RE.test(name)) throw new Error(`invalid MinIO container name: ${name}`);
  return name;
}

function randomCredentials() {
  return {
    accessKeyId: `fstest${crypto.randomBytes(7).toString('hex')}`,
    secretAccessKey: crypto.randomBytes(24).toString('base64url'),
  };
}

/** Containers whose published ports include `port`, from `docker ps`. */
async function dockerPortHolders(exec, port) {
  const { stdout } = await exec('docker ps --format "{{.Names}}\t{{.Ports}}"');
  const pattern = new RegExp(`:${port}->`);
  return String(stdout).split('\n')
    .map((line) => line.split('\t'))
    .filter(([name, ports]) => name && ports && pattern.test(ports))
    .map(([name]) => name);
}

/** True when something accepts connections on host:port. */
function portAnswers(port, host = HOST) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (answer) => { socket.destroy(); resolve(answer); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * The repo's SigV4 signer. Loaded on first use and transpiled from its TypeScript source:
 * ci-pipeline.js requires this module before the dependencies (typescript among them) are installed.
 */
let signer = null;
function loadSigner() {
  if (signer) return signer;
  const root = path.resolve(__dirname, '..', '..');
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const ts = require(require.resolve('typescript', { paths: [root] }));
  const file = path.join(root, 'libs', 'aws-signing', 's3Signer.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', outputText)(mod.exports, require, mod);
  signer = mod.exports.buildS3AuthHeader;
  return signer;
}

function amzDateNow() {
  return new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Creates the bucket with one signed `PUT /<bucket>`; an existing bucket of ours is fine. */
async function createBucket({ endpoint, bucket, region, accessKeyId, secretAccessKey, fetchImpl = fetch, sign = loadSigner() }) {
  const base = assertLoopbackEndpoint(endpoint);
  const { host } = new URL(base);
  const pathname = `/${bucket}`;
  const amzDate = amzDateNow();
  const authorization = sign({ method: 'PUT', host, pathname, payloadSha256: EMPTY_SHA256, accessKeyId, secretAccessKey, region, amzDate });
  const response = await fetchImpl(`${base}${pathname}`, {
    method: 'PUT',
    headers: { 'x-amz-date': amzDate, 'x-amz-content-sha256': EMPTY_SHA256, authorization },
    redirect: 'manual',
    signal: AbortSignal.timeout(BUCKET_TIMEOUT_MS),
  });
  if (response.status === 200) return;
  const body = await response.text();
  if (response.status === 409 && body.includes('BucketAlreadyOwnedByYou')) return;
  const code = /<Code>([A-Za-z0-9_.-]{1,64})<\/Code>/.exec(body)?.[1] ?? 'no S3 error code';
  throw new Error(`creating the test bucket failed: HTTP ${response.status} ${code}`);
}

async function waitUntilReady({ endpoint, fetchImpl, sleep, name }) {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    try {
      // Bounded per attempt: on a GitHub runner a check against the just-started container once never
      // settled (and held nothing open), so the process ended mid-wait with exit 0.
      const response = await fetchImpl(`${endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(READY_ATTEMPT_TIMEOUT_MS) });
      if (response.status === 200) return;
    } catch (error) {
      // not listening yet
    }
    await sleep(1000);
  }
  throw new Error(`MinIO container ${name} did not become ready within ${READY_ATTEMPTS} seconds`);
}

/**
 * Starts a fresh MinIO container and creates the bucket. Returns the container name and the
 * FILE_SEARCH_TEST_S3_* env. Fails, touching nothing, when the port is taken.
 */
async function startMinio({
  exec, log, name = containerName(), credentials = randomCredentials(), fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), portCheck = portAnswers, sign,
}) {
  if (!CONTAINER_NAME_RE.test(name)) throw new Error(`invalid MinIO container name: ${name}`);
  const holders = await dockerPortHolders(exec, PORT);
  if (holders.length) {
    throw new Error(`port ${PORT} is already published by container(s) ${holders.join(', ')}; if it is a stale run, remove it with \`docker rm -f -v <name>\``);
  }
  if (await portCheck(PORT)) throw new Error(`something already listens on ${HOST}:${PORT}; the test MinIO needs that port`);

  const endpoint = `http://${HOST}:${PORT}`;
  // An ordinary (referenced) timer keeps the process alive until the container is ready and the bucket
  // exists, whatever the HTTP client does with its own handles meanwhile.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    try {
      await exec(`docker run -d --name ${name} -p ${HOST}:${PORT}:9000 -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD ${IMAGE} server /data`, {
        env: { ...process.env, MINIO_ROOT_USER: credentials.accessKeyId, MINIO_ROOT_PASSWORD: credentials.secretAccessKey },
        timeout: DOCKER_RUN_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(error.killed
        ? `docker run (with the image pull) did not finish within ${DOCKER_RUN_TIMEOUT_MS / 60000} minutes`
        : `docker run failed: ${String(error.stderr || error.message).trim()}`);
    }
    log(`${name}: container created, waiting for readiness`);
    await waitUntilReady({ endpoint, fetchImpl, sleep, name });
    log(`${name}: ready, creating the bucket`);
    await createBucket({ endpoint, bucket: BUCKET, region: REGION, ...credentials, fetchImpl, ...(sign ? { sign } : {}) });
  } catch (error) {
    // Ours by name, so ours to remove; the caller gets the cause.
    await stopMinio({ exec, name });
    throw new Error(`test MinIO ${name} (removed): ${error.message}`);
  } finally {
    clearInterval(keepAlive);
  }
  log(`Started ${name} (${IMAGE.split('@')[0]}) on ${HOST}:${PORT}, bucket ${BUCKET}`);
  return {
    container: name,
    env: {
      [ENV.endpoint]: endpoint,
      [ENV.bucket]: BUCKET,
      [ENV.region]: REGION,
      [ENV.accessKeyId]: credentials.accessKeyId,
      [ENV.secretAccessKey]: credentials.secretAccessKey,
    },
  };
}

/** Removes the container (and its anonymous volume) by name; never anything else. */
async function stopMinio({ exec, name }) {
  if (!CONTAINER_NAME_RE.test(name || '')) throw new Error(`refusing to remove ${name}: not a ${CONTAINER_PREFIX}* container`);
  try {
    await exec(`docker rm -f -v ${name}`);
  } catch (error) {
    // already gone
  }
}

/**
 * For ci-pipeline.js: starts a container when no FILE_SEARCH_TEST_S3_ENDPOINT is given, otherwise
 * checks the given configuration (the GitHub step started one). Returns { container, env }.
 */
async function ensureFileSearchTestS3({ env, exec, log, name, ...rest }) {
  if (!needsContainer(env)) {
    const config = s3TestConfigFromEnv(env);
    return {
      container: null,
      env: {
        [ENV.endpoint]: config.endpoint,
        [ENV.bucket]: config.bucket,
        [ENV.region]: config.region,
        [ENV.accessKeyId]: config.accessKeyId,
        [ENV.secretAccessKey]: config.secretAccessKey,
      },
    };
  }
  return startMinio({ exec, log, name, ...rest });
}

/** Lines for $GITHUB_ENV. Values are single-line by construction. */
function githubEnvLines(started) {
  return Object.entries({ ...started.env, [ENV.container]: started.container }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

function shellExportLines(started) {
  return Object.entries({ ...started.env, [ENV.container]: started.container }).map(([key, value]) => `export ${key}='${value}'`).join('\n') + '\n';
}

async function main(argv) {
  const exec = promisify(execCallback);
  const log = (message) => process.stderr.write(`${message}\n`);
  const [command, arg] = argv;
  if (command === 'start') {
    const started = await startMinio({ exec, log });
    if (process.env.GITHUB_ENV) {
      process.stdout.write(`::add-mask::${started.env[ENV.secretAccessKey]}\n`);
      fs.appendFileSync(process.env.GITHUB_ENV, githubEnvLines(started));
      log(`Exported ${Object.values(ENV).join(', ')} to GITHUB_ENV`);
    } else {
      process.stdout.write(shellExportLines(started));
    }
  } else if (command === 'stop') {
    const name = arg || process.env[ENV.container];
    if (!name) {
      log(`No container to stop (${ENV.container} is unset)`);
      return;
    }
    await stopMinio({ exec, name });
    log(`Removed ${name}`);
  } else {
    throw new Error('usage: file-search-test-s3.js start | stop [name]');
  }
}

if (require.main === module) {
  // A CI step once exited 0 with no output and no GITHUB_ENV lines while its container ran on, so
  // the event loop must have emptied before main settled. Never let that pass as success.
  let settled = false;
  process.on('beforeExit', () => {
    if (settled) return;
    settled = true;
    process.stderr.write('file-search-test-s3.js exited before finishing (see the last stage logged above)\n');
    process.exitCode = 1;
  });
  main(process.argv.slice(2)).then(() => {
    settled = true;
  }, (error) => {
    settled = true;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  IMAGE, FALLBACK_IMAGE, DOCKER_RUN_TIMEOUT_MS, CONTAINER_PREFIX, HOST, PORT, RESERVED_PORTS, BUCKET, REGION, ENV,
  assertLoopbackEndpoint, s3TestConfigFromEnv, needsContainer, containerName, randomCredentials,
  dockerPortHolders, portAnswers, loadSigner, createBucket, startMinio, stopMinio, ensureFileSearchTestS3,
  githubEnvLines, shellExportLines,
};
