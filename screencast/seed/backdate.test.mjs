import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backdatePlan, backdateSql } from './backdate.mjs';

const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
const now = new Date('2026-10-14T12:00:00Z');

test('spreads rows over the last 30 days, more on weekdays, none in the future', () => {
  const plan = backdatePlan(ids, { days: 30, now });
  assert.equal(plan.length, 60);
  const byDay = new Map();
  for (const p of plan) {
    assert.ok(p.validFrom <= now && p.validFrom >= new Date(now.getTime() - 30 * 86400000));
    const d = p.validFrom.getUTCDay(); byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const weekend = (byDay.get(0) ?? 0) + (byDay.get(6) ?? 0);
  assert.ok(weekend < plan.length / 4, `too many weekend rows: ${weekend}`);
  assert.ok(new Set(plan.map((p) => p.validFrom.toISOString().slice(0, 10))).size >= 10, 'rows bunched on a few days');
});

test('the SQL is scoped to the listed ids and never unscoped', () => {
  const sql = backdateSql(backdatePlan(ids.slice(0, 3), { days: 30, now }), 'sap_llm_gateway_admin_apikeyusage');
  const updates = sql.split('\n').filter((l) => l.startsWith('UPDATE'));
  assert.equal(updates.length, 3);
  for (const line of updates) {
    // validto stays at the admin's open end (9999-12-31): an instant row would drop out of CAP's as-of-now reads.
    assert.doesNotMatch(line, /validto/);
    assert.match(line, /^UPDATE sap_llm_gateway_admin_apikeyusage SET validfrom = '[^']+' WHERE id = 'id-\d+';$/);
  }
  assert.ok(!/UPDATE[^\n]*;\s*$/m.test(sql.replace(/WHERE[^\n]*/g, '')), 'an UPDATE without a WHERE');
});

test('quotes in ids are escaped', () => {
  const sql = backdateSql([{ id: "a'b", validFrom: now }], 't');
  assert.match(sql, /WHERE id = 'a''b';/);
});
