// Unit coverage for the statement splitter that per-statement schema
// application depends on. A mis-split is silent — it yields statements that
// still execute, just not the ones that were written — so the delimiters that
// SQL treats as inert are pinned here rather than left to the schema happening
// not to contain them today.
import { splitSqlStatements, buildSchemaSql } from '../../src/fileSearch/schema.sql';

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons and drops empty fragments', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('returns a trailing statement that has no terminating semicolon', () => {
    expect(splitSqlStatements('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores a semicolon inside a line comment', () => {
    expect(splitSqlStatements('SELECT 1; -- a; b\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores a semicolon inside a block comment', () => {
    expect(splitSqlStatements('SELECT 1; /* a; b */ SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores a semicolon inside a string literal, including a doubled quote', () => {
    expect(splitSqlStatements("SELECT 'a;b'; SELECT 'it''s; fine'"))
      .toEqual(["SELECT 'a;b'", "SELECT 'it''s; fine'"]);
  });

  it('ignores a semicolon inside a quoted identifier', () => {
    expect(splitSqlStatements('SELECT "we;ird"; SELECT 2')).toEqual(['SELECT "we;ird"', 'SELECT 2']);
  });

  it('ignores semicolons inside a dollar-quoted body, tagged or not', () => {
    // The shape grantRuntimeRole already sends: a DO block whose body is full
    // of statement terminators that are not statement boundaries.
    const sql = 'DO $$ BEGIN CREATE ROLE x; ALTER ROLE x LOGIN; END $$; SELECT 1';
    expect(splitSqlStatements(sql)).toEqual([
      'DO $$ BEGIN CREATE ROLE x; ALTER ROLE x LOGIN; END $$',
      'SELECT 1',
    ]);
    expect(splitSqlStatements('DO $tag$ a; b $tag$; SELECT 1'))
      .toEqual(['DO $tag$ a; b $tag$', 'SELECT 1']);
  });

  it('splits the real schema into individually executable statements', () => {
    const statements = splitSqlStatements(buildSchemaSql(3));

    // Every statement is a complete DDL command, and none carries a stray
    // terminator — the two ways a bad split shows up.
    expect(statements.length).toBeGreaterThan(20);
    for (const statement of statements) {
      expect(statement).toMatch(/^(CREATE|ALTER|DROP)\s/);
      expect(statement.endsWith(';')).toBe(false);
    }
    // The commentary above vector_store_batches contains prose that must not
    // become a statement of its own.
    expect(statements.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS vector_store_batches'))).toBe(true);
    expect(statements.some((s) => s.includes('DERIVED from the member rows'))).toBe(false);
  });
});
