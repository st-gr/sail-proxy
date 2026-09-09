/**
 * The Admin Cockpit's home tiles: this month's requests, tokens and SAP cost for the signed-in user
 * (scope `self`) or for every user (scope `all`, administrators). Read from the per-user daily
 * buckets (UserUsageDaily, usageCounters.ts) — one row per user, UTC day and cost currency — so the
 * figures are the ones the quotas count and the cost is exact per currency: the headline `sapCost`
 * is the total in the quota currency (the active SAP capacity-unit price's), and any other currency
 * that carries cost this month is named in `otherCurrencies` rather than summed into a number that
 * would be in no currency at all. Reads only, no fan-out: the buckets of one month are small.
 */
import { monthStart } from './quotaWindows';
import { quotaCurrency } from './userQuotaService';
import { BUCKETS, utcDay, round, BucketRow } from './usageCounters';

const cds = require('@sap/cds');

export interface UsageSummary {
  scope: 'self' | 'all';
  monthStart: string;            // 'YYYY-MM-DD', UTC
  requests: number;
  tokens: number;
  users: number;                 // distinct users with usage this month (1 for scope self)
  sapCost: number;               // in sapCostCurrency only
  sapCostCurrency: string;
  otherCurrencies: string[];     // currencies with cost this month that sapCost does not include
}

export type SummaryRow = Pick<BucketRow, 'email' | 'currency' | 'requests' | 'tokens' | 'sapCost'>;

/** Fold bucket rows into the summary figures; pure. Rows priced in no currency ('') count towards requests and tokens only. */
export function foldSummary(rows: SummaryRow[], currency: string): Pick<UsageSummary, 'requests' | 'tokens' | 'users' | 'sapCost' | 'sapCostCurrency' | 'otherCurrencies'> {
  let requests = 0; let tokens = 0; let sapCost = 0;
  const users = new Set<string>();
  const others = new Set<string>();
  for (const r of rows) {
    requests += Number(r.requests) || 0;
    tokens += Number(r.tokens) || 0;
    users.add(r.email);
    const cost = Number(r.sapCost) || 0;
    if (r.currency === currency) sapCost = round(sapCost + cost);
    else if (r.currency && cost > 0) others.add(r.currency);
  }
  return { requests, tokens, users: users.size, sapCost, sapCostCurrency: currency, otherCurrencies: [...others].sort() };
}

export interface SummaryScope { email: string; isAdmin: boolean; now?: Date; }

/** This month's usage for one user, or for everyone when the caller is an administrator. */
export async function usageSummary(db: any, scope: SummaryScope): Promise<UsageSummary> {
  const now = scope.now ?? new Date();
  const since = utcDay(monthStart(now));
  const currency = await quotaCurrency(now);
  const { SELECT } = cds.ql;
  const where: Record<string, any> = { day: { '>=': since } };
  if (!scope.isAdmin) where.email = scope.email;
  const rows: any[] = await db.run(SELECT.from(BUCKETS).columns('email', 'currency', 'requests', 'tokens', 'sapCost').where(where));
  const folded = foldSummary((rows ?? []).map((r) => ({
    email: r.email, currency: r.currency ?? '', requests: Number(r.requests) || 0, tokens: Number(r.tokens) || 0, sapCost: Number(r.sapCost) || 0
  })), currency);
  return { scope: scope.isAdmin ? 'all' : 'self', monthStart: since, ...folded, users: scope.isAdmin ? folded.users : 1 };
}
