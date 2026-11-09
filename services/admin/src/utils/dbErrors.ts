/** SQLite: "UNIQUE constraint failed"; Postgres: SQLSTATE 23505. */
export function isUniqueViolation(err: any): boolean {
  return err?.code === '23505' || /UNIQUE constraint failed|duplicate key value/i.test(String(err?.message ?? err ?? ''));
}
