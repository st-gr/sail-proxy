/**
 * Hermetic coverage of the rebuild-index preflight session (rebuildIndex.ts): which statements it sends, in which
 * order, against a fake pg Client. The build itself is proven against a database in integration/rebuildIndex.test.ts.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const sent: string[] = [];
let reltuples = 30;
let indexDefinition: string | null = null;
/** The preflight statement that fails, its SQLSTATE and on which of its runs (1: the first preflight). */
let failure: { match: string; code: string; on: number } | null = null;
let runs = 0;
jest.mock('pg', () => ({
  __esModule: true,
  Client: class {
    async connect(): Promise<void> {}
    async end(): Promise<void> {}
    escapeIdentifier(s: string): string { return `"${s}"`; }
    async query(sql: string): Promise<{ rows: any[] }> {
      sent.push(sql);
      if (failure && sql.includes(failure.match)) {
        runs += 1;
        if (runs === failure.on) throw Object.assign(new Error('the server message'), { code: failure.code });
      }
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
      if (sql.includes('pg_extension')) return { rows: [{ extversion: '0.8.0' }] };
      if (sql.includes('pg_has_role')) return { rows: [{ schema: 'public', owner: true, role: 'owner', dimensions: 4 }] };
      if (sql.includes('reltuples')) return { rows: [{ n: String(reltuples) }] };
      if (sql.includes('count(*)')) return { rows: [{ n: '12' }] };
      if (sql.includes('maintenance_work_mem')) return { rows: [{ mwm: '64MB', bytes: String(64 * 2 ** 20) }] };
      if (sql.includes('pg_get_indexdef')) {
        return { rows: indexDefinition && !sql.includes('_v2') ? [{ definition: indexDefinition, valid: true, size: '8192' }] : [] };
      }
      return { rows: [] };
    }
  },
}));

// eslint-disable-next-line import/first
import { rebuildVectorIndex, parseRebuildIndexArgs, RebuildIndexError } from '../../src/fileSearch/rebuildIndex';

async function dryRun(argv: string[] = []): Promise<string[]> {
  const lines: string[] = [];
  await expect(rebuildVectorIndex('postgresql://fake', parseRebuildIndexArgs(['--dry-run', ...argv]), {
    write: (l) => { lines.push(l); },
  })).resolves.toBe('dry-run');
  return lines;
}

describe('rebuild-index preflight', () => {
  beforeEach(() => {
    sent.length = 0;
    reltuples = 30;
    indexDefinition = null;
    failure = null;
    runs = 0;
  });

  it('--dry-run bounds its own statements: the session timeouts come first', async () => {
    await dryRun();
    expect(sent.slice(0, 2)).toEqual(["SET statement_timeout = '30s'", "SET lock_timeout = '2s'"]);
    expect(sent.filter((s) => /^SET (statement|lock)_timeout/.test(s))).toHaveLength(2);
  });

  it('the planner estimate is used when the table has been analysed', async () => {
    const out = (await dryRun()).join('\n');
    expect(sent.some((s) => s.startsWith('SELECT count(*)'))).toBe(false);
    expect(out).toMatch(/chunks \(estimate\) +30\n/);
  });

  it.each([[-1, 'PG 14+ never analysed'], [0, 'PG 13 and older never analysed']])(
    'reltuples %i (%s) falls back to a count', async (n) => {
      reltuples = n;
      const out = (await dryRun()).join('\n');
      expect(sent.filter((s) => s.startsWith('SELECT count(*)'))).toHaveLength(1);
      expect(out).toMatch(/chunks \(estimate\) +12\n/);
    },
  );

  it('notes an index built with a non-default ef_construction or m', async () => {
    indexDefinition = 'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw '
      + "(((embedding)::halfvec(4)) halfvec_cosine_ops) WITH (m='16', ef_construction='64')";
    const out = (await dryRun(['--ef-construction', '64'])).join('\n');
    expect(out).toMatch(/nothing to do/);
    expect(out).toMatch(/note +idx_chunks_hnsw was built with ef_construction 64 \(default 200\): lower recall than the defaults .*; rebuild-index without --m or --ef-construction rebuilds it with the defaults/);
  });

  it('says nothing about the build parameters of a default index', async () => {
    indexDefinition = 'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw '
      + "(((embedding)::halfvec(4)) halfvec_cosine_ops) WITH (m='16', ef_construction='200')";
    const out = (await dryRun()).join('\n');
    expect(out).toMatch(/nothing to do/);
    expect(out).not.toMatch(/default 200|lower recall/);
  });

  const DEFAULT_INDEX = 'CREATE INDEX idx_chunks_hnsw ON public.vector_store_chunks USING hnsw '
    + "(((embedding)::halfvec(4)) halfvec_cosine_ops) WITH (m='16', ef_construction='200')";
  const run = (argv: string[]) => rebuildVectorIndex('postgresql://fake', parseRebuildIndexArgs(argv), { write: () => {} });

  it('a statement timeout (57014) on a never-analysed table names ANALYZE and says nothing changed', async () => {
    reltuples = -1;
    failure = { match: 'count(*)', code: '57014', on: 1 };
    const refusal = run(['--dry-run']);
    await expect(refusal).rejects.toBeInstanceOf(RebuildIndexError);
    await expect(refusal).rejects.toThrow(/did not finish within 30s.*ANALYZE vector_store_chunks.*retry.*changed nothing/);
  });

  it('a lock timeout (55P03) says another session holds the chunk table and to retry when it is free', async () => {
    failure = { match: 'pg_get_indexdef', code: '55P03', on: 1 };
    const refusal = run(['--dry-run']);
    await expect(refusal).rejects.toBeInstanceOf(RebuildIndexError);
    await expect(refusal).rejects.toThrow(/another session holds a lock on the chunk table.*retry when it is free.*changed nothing/);
  });

  it('any other preflight failure keeps its own message', async () => {
    failure = { match: 'pg_extension', code: '08006', on: 1 };
    await expect(run(['--dry-run'])).rejects.toThrow(/^the server message$/);
  });

  it('the second preflight, under the run lock, still runs bounded: the timeouts are lifted only after it', async () => {
    indexDefinition = DEFAULT_INDEX;
    await expect(run([])).resolves.toBe('unchanged');
    const second = sent.findIndex((s, i) => s.includes('pg_extension') && i > sent.findIndex((t) => t.includes('pg_try_advisory_lock')));
    const lifted = sent.indexOf('SET statement_timeout = 0');
    expect(second).toBeGreaterThan(0);
    const lastRead = sent.reduce((last, s, i) => (s.includes('pg_get_indexdef') ? i : last), -1);
    expect(lifted).toBeGreaterThan(lastRead);
    expect(sent.indexOf('SET lock_timeout = 0')).toBeGreaterThan(second);
  });

  it('a lock timeout in the second preflight is the same actionable refusal, and the run lock is released', async () => {
    indexDefinition = DEFAULT_INDEX;
    failure = { match: 'pg_get_indexdef', code: '55P03', on: 3 }; // the first preflight reads two indexes
    await expect(run([])).rejects.toThrow(/another session holds a lock on the chunk table/);
    expect(sent.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
  });
});
