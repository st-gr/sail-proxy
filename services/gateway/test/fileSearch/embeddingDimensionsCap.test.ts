// W4 Task 1: file_search.embedding_dimensions is capped at 4000 (pgvector indexes halfvec up to 4000, vector
// up to 2000). The schema bounds it, buildSchemaSql refuses a wider column, and the migration reports a wider
// setting as unavailable with a clear log line instead of dying on a raw pgvector error.
import * as fs from 'fs';
import * as path from 'path';
import {
  buildSchemaSql, embeddingDimensionsProblem, MAX_EMBEDDING_DIMENSIONS, splitSqlStatements,
} from '../../src/fileSearch/schema.sql';

let mockDimensions = 1536;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => ({ enabled: true, embeddingDimensions: mockDimensions }),
}));
const mockError = jest.fn();
const mockWarn = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: mockWarn, error: mockError, debug: jest.fn() }),
}));
const mockPool = jest.fn();
jest.mock('pg', () => ({ Pool: function Pool(...args: unknown[]) { mockPool(...args); throw new Error('no database in this test'); } }));

// eslint-disable-next-line import/first
import { runMigration, __resetForTests } from '../../src/fileSearch/db';
// eslint-disable-next-line import/first
import { unavailableCause } from '../../src/fileSearch/unavailableCause';

const ADMIN = path.join(__dirname, '../../../admin');
const schemaProperty = (text: string) => JSON.parse(text).$defs.capabilitiesGroup.properties.file_search.properties.embedding_dimensions;

describe('the schema bounds embedding_dimensions', () => {
  it('states maximum 4000, equal to the code constant', () => {
    const p = schemaProperty(fs.readFileSync(path.join(ADMIN, 'src/schemas/api-config-schema.json'), 'utf8'));
    expect(MAX_EMBEDDING_DIMENSIONS).toBe(4000);
    expect(p).toMatchObject({ minimum: 1, maximum: MAX_EMBEDDING_DIMENSIONS, default: 1536 });
  });

  it('the browser copy states the same bound', () => {
    const ts = fs.readFileSync(path.join(ADMIN, 'app/config-app/webapp/model/apiConfigSchema.ts'), 'utf8');
    const block = /"embedding_dimensions": \{[^}]*\}/.exec(ts)?.[0] ?? '';
    expect(block).toContain('"maximum": 4000');
  });
});

describe('buildSchemaSql width bound', () => {
  it.each([1, 1536, 2000, 3072, 4000])('accepts %i', (n) => {
    expect(buildSchemaSql(n)).toContain(`embedding  vector(${n})`);
  });

  it.each([4001, 16000, 0, -1, 1.5, NaN])('refuses %p with a message naming the limit', (n) => {
    expect(() => buildSchemaSql(n)).toThrow(/embedding_dimensions must be a whole number from 1 to 4000/);
  });

  it('offers the plain-vector HNSW index (the fallback on pgvector < 0.7) only where pgvector can (up to 2000 dimensions)', () => {
    const has = (n: number) => splitSqlStatements(buildSchemaSql(n)).some((s) => s.includes('USING hnsw (embedding vector_cosine_ops)'));
    expect(has(1536)).toBe(true);
    expect(has(2000)).toBe(true);
    expect(has(2001)).toBe(false);
    expect(has(3072)).toBe(false);
  });
});

describe('embeddingDimensionsProblem', () => {
  it('is null in range and a message out of range', () => {
    expect(embeddingDimensionsProblem(3072)).toBeNull();
    expect(embeddingDimensionsProblem(4001)).toMatch(/1 to 4000 \(got 4001\)/);
    expect(embeddingDimensionsProblem('3072')).toMatch(/got 3072/);
    expect(embeddingDimensionsProblem(undefined)).not.toBeNull();
  });
});

describe('runMigration with a wide setting', () => {
  beforeEach(() => {
    __resetForTests();
    mockError.mockClear();
    mockWarn.mockClear();
    mockPool.mockClear();
    process.env.FILE_SEARCH_DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
  });
  afterEach(() => { delete process.env.FILE_SEARCH_DATABASE_URL; });

  it('4001: returns false before touching the database and logs why', async () => {
    mockDimensions = 4001;
    await expect(runMigration()).resolves.toBe(false);
    expect(mockPool).not.toHaveBeenCalled();
    expect(mockError.mock.calls[0][1]).toMatch(/UNAVAILABLE.*1 to 4000 \(got 4001\)/);
    expect(unavailableCause()).toBe('embedding_dimensions');
  });

  it('4001 with a privileged migration DSN: same, no throw', async () => {
    mockDimensions = 4001;
    process.env.FILE_SEARCH_MIGRATION_DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';
    await expect(runMigration()).resolves.toBe(false);
    delete process.env.FILE_SEARCH_MIGRATION_DATABASE_URL;
    expect(mockPool).not.toHaveBeenCalled();
    expect(unavailableCause()).toBe('embedding_dimensions');
  });

  it('3072: proceeds to the database (the failure here is the stubbed pool); the halfvec index serves it, no warning', async () => {
    mockDimensions = 3072;
    await expect(runMigration()).rejects.toThrow('no database in this test');
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockError.mock.calls.map((c) => c[1]).join('\n')).not.toMatch(/1 to 4000/);
  });
});
