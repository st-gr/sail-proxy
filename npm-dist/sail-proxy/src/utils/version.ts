/**
 * Version comparison for x.y.z[-pre] strings (leading "v" ignored). Same semantics as the admin
 * shell's compareVersions, but pre-release identifiers follow semver: numeric identifiers
 * compare numerically (rc.10 > rc.2), numeric < alphanumeric, a shorter set is lower.
 * npm-dist cannot import admin code, so this is a separate copy.
 * Returns <0, 0 or >0 like a sort comparator.
 */
function parse(v: string): { core: number[]; pre: string[] } {
  const clean = String(v).trim().replace(/^v/i, '').split('+')[0];
  const dash = clean.indexOf('-');
  const corePart = dash === -1 ? clean : clean.slice(0, dash);
  const prePart = dash === -1 ? '' : clean.slice(dash + 1);
  const core = corePart.split('.').map((p) => parseInt(p, 10) || 0);
  while (core.length < 3) core.push(0);
  return { core, pre: prePart ? prePart.split('.') : [] };
}

export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
