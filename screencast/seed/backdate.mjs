// Spreads usage rows over the past N days so the charts show history (pure).
// Weekends get a fifth of a weekday's share. Column names are the lower-case ones CAP's Postgres deploy creates.
export function backdatePlan(rowIds, { days = 30, now = new Date() } = {}) {
  let seed = 42; const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const slots = [];
  for (let d = days - 1; d >= 0; d--) {          // today counts as one of the N days
    const day = new Date(now.getTime() - d * 86400000);
    slots.push({ day, weight: [0, 6].includes(day.getUTCDay()) ? 0.2 : 1 });
  }
  const total = slots.reduce((s, x) => s + x.weight, 0);
  return rowIds.map((id) => {
    let pick = rand() * total, slot = slots[slots.length - 1];
    for (const s of slots) { pick -= s.weight; if (pick <= 0) { slot = s; break; } }
    const t = new Date(slot.day); t.setUTCHours(8 + Math.floor(rand() * 10), Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
    return { id, validFrom: t > now ? new Date(t.getTime() - 86400000) : t }; // later today → same time yesterday
  });
}

/**
 * One UPDATE per row, each scoped to its own id. Only validfrom moves: the admin writes validto = 9999-12-31,
 * and CAP's temporal reads filter as of now, so a validto in the past would hide the row from every chart.
 */
export function backdateSql(plan, table) {
  return plan.map(({ id, validFrom }) => {
    const iso = validFrom.toISOString();
    return `UPDATE ${table} SET validfrom = '${iso}' WHERE id = '${String(id).replace(/'/g, "''")}';`;
  }).join('\n') + '\n';
}
