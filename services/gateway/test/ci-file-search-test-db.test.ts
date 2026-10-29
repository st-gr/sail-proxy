import { describe, it, expect, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../../../ci/scripts/file-search-test-db.js');

describe('ci/scripts/file-search-test-db', () => {
  it('starts its own container only when no DSN is given and it is not GitHub', () => {
    expect(db.needsContainer({})).toBe(true);
    expect(db.needsContainer({ FILE_SEARCH_TEST_DSN: 'postgresql://x' })).toBe(false);
    expect(db.needsContainer({ GITHUB_ACTIONS: 'true' })).toBe(false);
  });

  it('derives the gateway database on the same server, keeping credentials and options', () => {
    expect(db.gatewayDsnFor('postgresql://postgres:postgres@localhost:55432/filesearch_test'))
      .toBe('postgresql://postgres:postgres@localhost:55432/filesearch_ci_gateway');
    expect(db.gatewayDsnFor('postgresql://u:p%40w@db.example.test:5432/filesearch_test?sslmode=require'))
      .toBe('postgresql://u:p%40w@db.example.test:5432/filesearch_ci_gateway?sslmode=require');
  });

  it('uses port 55434 locally, clear of the Docker phase\'s 5432 and a developer\'s own 55432', () => {
    expect(db.LOCAL_TEST_DSN).toBe('postgresql://postgres:postgres@localhost:55434/filesearch_test');
  });

  it('with a given DSN starts no container and only creates the gateway database', async () => {
    const exec = jest.fn<any>();
    const createDatabase = jest.fn<any>().mockResolvedValue(undefined);
    const result = await db.ensureFileSearchTestDatabase({
      env: { FILE_SEARCH_TEST_DSN: 'postgresql://postgres:postgres@localhost:55432/filesearch_test' },
      exec, log: () => {}, createDatabase
    });
    expect(exec).not.toHaveBeenCalled();
    expect(createDatabase).toHaveBeenCalledWith('postgresql://postgres:postgres@localhost:55432/filesearch_test', 'filesearch_ci_gateway');
    expect(result).toEqual({
      testDsn: 'postgresql://postgres:postgres@localhost:55432/filesearch_test',
      gatewayDsn: 'postgresql://postgres:postgres@localhost:55432/filesearch_ci_gateway',
      container: null
    });
  });

  it('without a DSN removes a stale container, starts a fresh one and waits until it is ready', async () => {
    const commands: string[] = [];
    let readyChecks = 0;
    const exec = jest.fn<any>(async (command: string) => {
      commands.push(command);
      if (command.includes('pg_isready') && ++readyChecks < 3) throw new Error('not ready');
      return { stdout: '' };
    });
    const createDatabase = jest.fn<any>().mockResolvedValue(undefined);
    const result = await db.ensureFileSearchTestDatabase({ env: {}, exec, log: () => {}, createDatabase, sleep: async () => {} });
    expect(commands[0]).toBe('docker rm -f sail-ci-pgvector');
    expect(commands[1]).toBe('docker run -d --name sail-ci-pgvector --shm-size=1g -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=filesearch_test -p 127.0.0.1:55434:5432 pgvector/pgvector:pg16-trixie');
    expect(commands.filter((c) => c.includes('pg_isready'))).toHaveLength(3);
    expect(result.container).toBe('sail-ci-pgvector');
    expect(result.testDsn).toBe(db.LOCAL_TEST_DSN);
  });

  it('gives up with a clear message when the container never becomes ready', async () => {
    const exec = jest.fn<any>(async (command: string) => { if (command.includes('pg_isready')) throw new Error('no'); return { stdout: '' }; });
    await expect(db.ensureFileSearchTestDatabase({ env: {}, exec, log: () => {}, createDatabase: jest.fn(), sleep: async () => {} }))
      .rejects.toThrow('pgvector container sail-ci-pgvector did not become ready');
  });
});

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const dbDescribe = DSN ? describe : describe.skip;

dbDescribe('createDatabaseWithPg against a real Postgres (requires FILE_SEARCH_TEST_DSN)', () => {
  const NAME = 'filesearch_ci_fu_check';

  async function withClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg');
    const client = new Client({ connectionString: DSN });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }
  const drop = () => withClient((client) => client.query(`DROP DATABASE IF EXISTS "${NAME}"`));

  beforeAll(drop);
  afterAll(drop);

  it('creates the database and a second call for the same name does not throw', async () => {
    await db.createDatabaseWithPg(DSN, NAME);
    await expect(db.createDatabaseWithPg(DSN, NAME)).resolves.toBeUndefined();
    const found: any = await withClient((client) => client.query('SELECT 1 FROM pg_database WHERE datname = $1', [NAME]));
    expect(found.rowCount).toBe(1);
  });
});
