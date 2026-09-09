/**
 * The Assignments tab narrows its rows client-side (J): libraryUsers() hands the whole list over
 * in one call, so the search box filters the array rather than asking the server again.
 */
import { matchesUserQuery, filterUsers, runPerUser } from '../webapp/model/userFilter';

const rows = [
  { email: 'Ada@example.com', catalogName: 'Research' },
  { email: 'bob@example.com', catalogName: null },
  { email: 'carol@other.org', catalogName: 'RESEARCH team' }
];

describe('matchesUserQuery', () => {
  it('matches the e-mail case-insensitively', () => {
    expect(matchesUserQuery(rows[0], 'ada')).toBe(true);
    expect(matchesUserQuery(rows[0], 'ADA@EXAMPLE')).toBe(true);
    expect(matchesUserQuery(rows[1], 'ada')).toBe(false);
  });
  it('matches the assigned catalog name case-insensitively', () => {
    expect(matchesUserQuery(rows[2], 'research')).toBe(true);
    expect(matchesUserQuery(rows[0], 'RESEARCH')).toBe(true);
  });
  it('never matches a row with no catalog on a catalog-name query, and survives missing fields', () => {
    expect(matchesUserQuery(rows[1], 'research')).toBe(false);
    expect(matchesUserQuery({}, 'anything')).toBe(false);
  });
  it('keeps every row for an empty or blank query', () => {
    expect(matchesUserQuery(rows[1], '')).toBe(true);
    expect(matchesUserQuery(rows[1], '   ')).toBe(true);
  });
});

describe('filterUsers', () => {
  it('narrows to the matching rows, keeping the server order', () => {
    expect(filterUsers(rows, 'research').map(r => r.email)).toEqual(['Ada@example.com', 'carol@other.org']);
    expect(filterUsers(rows, 'example.com').map(r => r.email)).toEqual(['Ada@example.com', 'bob@example.com']);
  });
  it('keeps all rows for an empty query and none for an unmatched one', () => {
    expect(filterUsers(rows, '')).toHaveLength(3);
    expect(filterUsers(rows, '   ')).toHaveLength(3);
    expect(filterUsers(rows, 'nobody')).toEqual([]);
  });
});

describe('runPerUser', () => {
  it('counts what went through and names who did not, without aborting', async () => {
    const outcome = await runPerUser(['a', 'b', 'c'], (email) =>
      email === 'b' ? Promise.reject(new Error('refused')) : Promise.resolve());
    expect(outcome).toEqual({ done: 2, failed: ['b'] });
  });
  it('runs strictly in sequence — the server prunes on each call', async () => {
    const order: string[] = [];
    let running = 0;
    await runPerUser(['a', 'b', 'c'], async (email) => {
      expect(running).toBe(0);
      running++;
      await Promise.resolve();
      order.push(email);
      running--;
    });
    expect(order).toEqual(['a', 'b', 'c']);
  });
  it('does nothing for an empty selection', async () => {
    await expect(runPerUser([], () => Promise.reject(new Error('never called')))).resolves.toEqual({ done: 0, failed: [] });
  });
});
