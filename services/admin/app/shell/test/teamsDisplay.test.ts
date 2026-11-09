import { toTeamsView } from '../webapp/model/teamsDisplay';
const pool = (over: any = {}) => ({ limits: { spendPerMonth: 20, tokensPerMonth: 5000000, ...over.limits }, used: { month: { sapCost: 0.4, tokens: 1200, requests: 3 } }, sapCostCurrency: 'USD' });
describe('toTeamsView', () => {
  it('one line per membership, primary and admin marked, with the month pool figures', () => {
    const v = toTeamsView([{ teamId: 'a', name: 'Alpha', role: 'admin', isPrimary: true, pool: pool() }, { teamId: 'b', name: 'Beta', role: 'member', isPrimary: false, pool: pool({ limits: { spendPerMonth: null, tokensPerMonth: null } }) }]);
    expect(v.available).toBe(true);
    expect(v.lines[0]).toEqual({ teamId: 'a', name: 'Alpha', membershipText: 'Alpha · primary · team admin', poolText: 'Alpha: 0.40 USD / 20.00 USD · 1,200 / 5,000,000 tokens this month' });
    expect(v.lines[1].membershipText).toBe('Beta');
    expect(v.lines[1].poolText).toBe('Beta: 0.40 USD / unlimited · 1,200 / unlimited tokens this month');
  });
  it('no memberships or no response: not available', () => {
    expect(toTeamsView([])).toEqual({ available: false, lines: [] });
    expect(toTeamsView(null)).toEqual({ available: false, lines: [] });
  });
});
