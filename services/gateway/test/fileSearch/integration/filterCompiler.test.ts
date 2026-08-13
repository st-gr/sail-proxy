// Proves the compiler's output is actually valid, correctly-filtering SQL against
// a real pgvector database — a stronger check than string equality against an
// expected fragment. Skips cleanly when no live database is configured.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { compileFilter } from '../../../src/fileSearch/filterCompiler';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

d('filterCompiler output against a real jsonb column (requires FILE_SEARCH_TEST_DSN pointing at pgvector)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const storeId = `store-${crypto.randomUUID()}`;

  async function seedFile(fileId: string, attributes: Record<string, unknown> | null): Promise<void> {
    const sha256 = crypto.createHash('sha256').update(fileId).digest('hex');
    await pool.query(
      `INSERT INTO file_blobs (sha256, size_bytes, storage) VALUES ($1, 1, 'inline')
       ON CONFLICT (sha256) DO NOTHING`,
      [sha256],
    );
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
       VALUES ($1, 'tester@example.com', $1, 'assistants', $2, 1)
       ON CONFLICT (id) DO NOTHING`,
      [fileId, sha256],
    );
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, attributes) VALUES ($1, $2, $3)
       ON CONFLICT (store_id, file_id) DO UPDATE SET attributes = EXCLUDED.attributes`,
      [storeId, fileId, attributes],
    );
  }

  async function matchingFileIds(filter: unknown): Promise<string[]> {
    const { sql, params } = compileFilter(filter, 2);
    const { rows } = await pool.query(
      `SELECT vsf.file_id FROM vector_store_files vsf WHERE vsf.store_id = $1 AND ${sql} ORDER BY vsf.file_id`,
      [storeId, ...params],
    );
    return rows.map((r) => r.file_id);
  }

  beforeAll(async () => {
    fixture = await createIsolatedSchema(DSN!, 3);
    pool = fixture.pool;
    await pool.query('INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim) VALUES ($1, $2, $3, 3) ON CONFLICT (id) DO NOTHING', [storeId, 'tester@example.com', 'test-model']);

    await seedFile('f-legal-2019', { category: 'legal', year: 2019 });
    await seedFile('f-legal-2021', { category: 'legal', year: 2021 });
    await seedFile('f-hr-2021', { category: 'hr', year: 2021 });
    // TWO different shapes of "this file has no `category`", because they are
    // different SQL and the ne/nin tests below must cover both: `attributes` is
    // a NULLABLE jsonb column, so a file attached with no attributes stores SQL
    // NULL, while a file attached with `{}` stores a real, empty object. A
    // missing-key arm written `NOT (attributes ? $k)` handles the second and
    // silently drops the first.
    await seedFile('f-noattrs', null);
    await seedFile('f-emptyattrs', {});
    // A file whose "year" is not numeric at all — another client's upload
    // (or a bug elsewhere) can put arbitrary JSON under any attribute key.
    await seedFile('f-badyear', { category: 'legal', year: 'abc' });
  });

  afterAll(async () => {
    // Dropping the whole isolated schema (see schemaFixture.ts) makes explicit
    // row cleanup unnecessary — this also closes the earlier-flagged gap where
    // this suite's own seeded fs_files/file_blobs rows outlived the test run.
    await fixture.teardown();
  });

  it('eq filters to the exact matching row', async () => {
    const ids = await matchingFileIds({ type: 'eq', key: 'category', value: 'hr' });
    expect(ids).toEqual(['f-hr-2021']);
  });

  it('numeric gt filters using a guarded ::numeric cast, not lexical string comparison', async () => {
    // Lexical comparison of '2019' vs '9' style strings would misbehave; the cast
    // to numeric is what makes this correct.
    const ids = await matchingFileIds({ type: 'gt', key: 'year', value: 2020 });
    expect(ids.sort()).toEqual(['f-hr-2021', 'f-legal-2021']);
  });

  it('an ordinal filter does not error when one row in the store has a non-numeric value under the same key', async () => {
    // This is the regression this test exists to catch: a bare
    // `(text)::numeric` cast throws `[22P02] invalid input syntax for type
    // numeric` for the whole query the instant it hits f-badyear's
    // year: "abc" — a legitimate filter would 500 for the entire store just
    // because one unrelated file has an odd value under the same attribute
    // key. The guarded (jsonb_typeof) form must instead simply skip that row.
    const ids = await matchingFileIds({ type: 'gt', key: 'year', value: 2020 });
    expect(ids.sort()).toEqual(['f-hr-2021', 'f-legal-2021']);
    expect(ids).not.toContain('f-badyear');
  });

  it('in filters against a bound array', async () => {
    const ids = await matchingFileIds({ type: 'in', key: 'category', value: ['hr'] });
    expect(ids).toEqual(['f-hr-2021']);
  });

  it('nested and/or compiles to a real, correctly-scoped predicate', async () => {
    const ids = await matchingFileIds({
      type: 'and',
      filters: [
        { type: 'eq', key: 'category', value: 'legal' },
        { type: 'gte', key: 'year', value: 2021 },
      ],
    });
    expect(ids).toEqual(['f-legal-2021']);
  });

  it('a key crafted to look like an injection attempt executes as inert data and matches nothing', async () => {
    const evil = "x') OR 1=1 --";
    const ids = await matchingFileIds({ type: 'eq', key: evil, value: 'v' });
    expect(ids).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ne/nin NULL semantics — the decision Task 12 settled.
  //
  // A file with no `category` is not "a file whose category is legal", so `ne
  // category legal` must return it. SQL's own reading is the opposite and it is
  // SILENT: `(attributes->>'category') <> 'legal'` is NULL for a row without the
  // key, and WHERE drops NULL rows without complaint. Nothing errors, the query
  // is fast, and the caller simply never sees the files. That is why these are
  // asserted against real rows rather than against a SQL string.
  //
  // The corpus deliberately carries BOTH attribute-less shapes (see the seeds
  // above) — a fixture with only one of them would pass with half the fix.
  // -------------------------------------------------------------------------

  it('ne INCLUDES rows lacking the attribute entirely (both the NULL column and the empty object)', async () => {
    const ids = await matchingFileIds({ type: 'ne', key: 'category', value: 'legal' });
    expect(ids.sort()).toEqual(['f-emptyattrs', 'f-hr-2021', 'f-noattrs']);
    // Not vacuous: the rows that DO have category=legal are still excluded.
    expect(ids).not.toContain('f-legal-2019');
    expect(ids).not.toContain('f-legal-2021');
    expect(ids).not.toContain('f-badyear');
  });

  it('nin INCLUDES rows lacking the attribute entirely (both the NULL column and the empty object)', async () => {
    const ids = await matchingFileIds({ type: 'nin', key: 'category', value: ['legal', 'hr'] });
    expect(ids.sort()).toEqual(['f-emptyattrs', 'f-noattrs']);
    // Every row that HAS one of the listed values is still excluded.
    expect(ids).not.toContain('f-hr-2021');
    expect(ids).not.toContain('f-legal-2021');
  });

  it('eq still EXCLUDES rows lacking the attribute — the asymmetry with ne/nin is the point', async () => {
    const ids = await matchingFileIds({ type: 'eq', key: 'category', value: 'legal' });
    expect(ids.sort()).toEqual(['f-badyear', 'f-legal-2019', 'f-legal-2021']);
    expect(ids).not.toContain('f-noattrs');
    expect(ids).not.toContain('f-emptyattrs');
  });

  it('ne on a key NO row in the store carries returns every row, rather than none', async () => {
    // The starkest form of the bug: filtering on an attribute nobody set used to
    // return an empty page, which reads exactly like "the store is empty".
    const ids = await matchingFileIds({ type: 'ne', key: 'no-such-key', value: 'x' });
    expect(ids.sort()).toEqual(['f-badyear', 'f-emptyattrs', 'f-hr-2021', 'f-legal-2019', 'f-legal-2021', 'f-noattrs']);
  });

  it('ne composes inside and/or with correct placeholder numbering (the arm binds the key twice)', async () => {
    // The arm added a third bound parameter per `ne` leaf. If the index bumps
    // and the pushes disagree, the params silently misbind and this returns the
    // wrong rows rather than erroring.
    const ids = await matchingFileIds({
      type: 'and',
      filters: [
        { type: 'ne', key: 'category', value: 'legal' },
        { type: 'eq', key: 'year', value: 2021 },
      ],
    });
    expect(ids).toEqual(['f-hr-2021']);
  });

  // The array-membership operators, seeded to MIRROR the live probe that
  // established their semantics (2026-08-06): two files with a scalar `tag`,
  // one with an array `tags`, and one with no attributes at all. The
  // expectations below are the file sets OpenAI actually returned.
  describe('array-membership operators (contains / ncontains / containsany / ncontainsany)', () => {
    beforeAll(async () => {
      await seedFile('m_alpha', { tag: 'alpha-beta', n: 1, flag: true });
      await seedFile('m_beta', { tag: 'beta-gamma', n: 2, flag: false });
      await seedFile('m_gamma', { tags: ['gamma', 'delta'], n: 3 });
      await seedFile('m_bare', null);
    });

    it('contains matches membership in an ARRAY attribute', async () => {
      const ids = await matchingFileIds({ type: 'contains', key: 'tags', value: 'gamma' });
      expect(ids).toContain('m_gamma');
      expect(ids).not.toContain('m_alpha');
    });

    it('contains is NOT substring matching on a scalar attribute', async () => {
      // OpenAI 400s this ("requires metadata key 'tag' to be a list"). We cannot
      // 400 — the attribute's type is per-row data, not a property of the
      // request — so we return no match. Either way "alpha-beta" must NOT match
      // a substring probe, which is the reading the operator name invites.
      const ids = await matchingFileIds({ type: 'contains', key: 'tag', value: 'beta' });
      expect(ids).not.toContain('m_alpha');
      expect(ids).not.toContain('m_beta');
    });

    it('containsany matches any element of the array', async () => {
      const ids = await matchingFileIds({ type: 'containsany', key: 'tags', value: ['gamma', 'zzz'] });
      expect(ids).toEqual(['m_gamma']);
    });

    it('containsany is ANY, not ALL', async () => {
      // `@>` with a multi-element array means "contains ALL", which would return
      // nothing here. Probed behaviour is any-of.
      const ids = await matchingFileIds({ type: 'containsany', key: 'tags', value: ['gamma', 'absent'] });
      expect(ids).toEqual(['m_gamma']);
    });

    it('ncontainsany returns rows that lack the key ENTIRELY', async () => {
      // The measured surprise: OpenAI returned the files with no `tags` key at
      // all. Same arm as ne/nin above.
      const ids = await matchingFileIds({ type: 'ncontainsany', key: 'tags', value: ['gamma'] });
      expect(ids).toEqual(expect.arrayContaining(['m_alpha', 'm_beta', 'm_bare']));
      expect(ids).not.toContain('m_gamma');
    });

    it('ncontains likewise includes the attribute-less rows', async () => {
      const ids = await matchingFileIds({ type: 'ncontains', key: 'tags', value: 'gamma' });
      expect(ids).toEqual(expect.arrayContaining(['m_alpha', 'm_beta', 'm_bare']));
      expect(ids).not.toContain('m_gamma');
    });

    it('compares elements by jsonb type, so 1 does not match "1"', async () => {
      await seedFile('m_nums', { tags: [1, 2] });
      expect(await matchingFileIds({ type: 'contains', key: 'tags', value: 1 })).toContain('m_nums');
      expect(await matchingFileIds({ type: 'contains', key: 'tags', value: '1' })).not.toContain('m_nums');
    });

    it('rejects a non-array value for containsany', async () => {
      expect(() => compileFilter({ type: 'containsany', key: 'tags', value: 'gamma' }, 2))
        .toThrow(/must be an array/);
    });
  });
});
