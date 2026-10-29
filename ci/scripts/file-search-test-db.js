'use strict';

/**
 * A Postgres with pgvector for the pipeline's file_search work.
 *
 * GitHub provides one as a service container and sets FILE_SEARCH_TEST_DSN. Locally nothing did,
 * so the Postgres integration suites were skipped and the Phase 5 gateway had no file_search at
 * all. This starts a throwaway container when no DSN is given.
 *
 * Two databases on the one server, on purpose:
 *   - FILE_SEARCH_TEST_DSN's database is for the jest suites. Each creates its own schema and
 *     first asserts that `public` holds no file_search tables.
 *   - `filesearch_ci_gateway` is for the Phase 5 gateway, which migrates into `public`.
 * Sharing one database would fail every suite's clean-public check.
 *
 * Port 55434 locally: 5432 is the Docker phase's Postgres, and 55432 is commonly a developer's
 * own test database. GitHub's service container stays on 55432.
 */

const path = require('path');

const CONTAINER_NAME = 'sail-ci-pgvector';
const IMAGE = 'pgvector/pgvector:pg16-trixie';
const LOCAL_TEST_DSN = 'postgresql://postgres:postgres@localhost:55434/filesearch_test';
const GATEWAY_DATABASE = 'filesearch_ci_gateway';
const READY_ATTEMPTS = 60;

function needsContainer(env) {
  return !env.FILE_SEARCH_TEST_DSN && !env.GITHUB_ACTIONS;
}

function gatewayDsnFor(testDsn) {
  const url = new URL(testDsn);
  url.pathname = `/${GATEWAY_DATABASE}`;
  return url.toString();
}

/** CREATE DATABASE if it is missing, through the gateway's own pg driver. */
async function createDatabaseWithPg(testDsn, database) {
  const gatewayDir = path.resolve(__dirname, '..', '..', 'services', 'gateway');
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const { Client } = require(require.resolve('pg', { paths: [gatewayDir] }));
  const client = new Client({ connectionString: testDsn });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (found.rowCount === 0) await client.query(`CREATE DATABASE "${database}"`);
  } finally {
    await client.end();
  }
}

async function ensureFileSearchTestDatabase({ env, exec, log, createDatabase = createDatabaseWithPg, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let testDsn = env.FILE_SEARCH_TEST_DSN;
  let container = null;

  if (needsContainer(env)) {
    try { await exec(`docker rm -f ${CONTAINER_NAME}`); } catch (error) { /* there was none */ }
    // --shm-size: parallel HNSW builds and parallel queries in concurrently running suites share the
    // container's /dev/shm; Docker's 64 MB default runs out ("could not resize shared memory").
    await exec(`docker run -d --name ${CONTAINER_NAME} --shm-size=1g -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=filesearch_test -p 127.0.0.1:55434:5432 ${IMAGE}`);
    container = CONTAINER_NAME;
    let ready = false;
    // -h 127.0.0.1 on purpose: the image first runs a temporary server that listens on its unix
    // socket only and then restarts, so a socket-based pg_isready reports ready too early.
    for (let attempt = 0; attempt < READY_ATTEMPTS && !ready; attempt++) {
      try {
        await exec(`docker exec ${CONTAINER_NAME} pg_isready -h 127.0.0.1 -U postgres -d filesearch_test`);
        ready = true;
      } catch (error) {
        await sleep(1000);
      }
    }
    if (!ready) throw new Error(`pgvector container ${CONTAINER_NAME} did not become ready within ${READY_ATTEMPTS} seconds`);
    testDsn = LOCAL_TEST_DSN;
    log(`Started ${CONTAINER_NAME} (${IMAGE}) on 127.0.0.1:55434`);
  } else if (!testDsn) {
    throw new Error('FILE_SEARCH_TEST_DSN is not set although this is GitHub Actions: the workflow must provide the pgvector service');
  }

  await createDatabase(testDsn, GATEWAY_DATABASE);
  return { testDsn, gatewayDsn: gatewayDsnFor(testDsn), container };
}

module.exports = { CONTAINER_NAME, IMAGE, LOCAL_TEST_DSN, GATEWAY_DATABASE, needsContainer, gatewayDsnFor, createDatabaseWithPg, ensureFileSearchTestDatabase };
