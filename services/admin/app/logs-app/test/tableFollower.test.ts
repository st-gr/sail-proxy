import TableFollower from '../webapp/controller/TableFollower';

function fakeTable(rows = 10) {
  let first = 0;
  const sets: number[] = [];
  return {
    table: { getRows: () => new Array(rows), getFirstVisibleRow: () => first, setFirstVisibleRow: (i: number) => { sets.push(i); first = i; } },
    sets,
    scrollTo: (i: number) => { first = i; }
  };
}

describe('TableFollower', () => {
  it('forgets the row it meant to set when the table already shows it (no event comes), so the next scroll by the person counts', () => {
    const fake = fakeTable(10);
    const follower = new TableFollower(() => fake.table as any, () => 'newestLast', () => undefined);
    fake.scrollTo(90);
    follower.scrollToNewest(100);          // already at 90: the table fires no event
    expect(fake.sets).toEqual([]);
    follower.onFirstVisibleRowChanged(90, 100);
    expect(follower.following).toBe(true);
    follower.onFirstVisibleRowChanged(50, 100);  // the person scrolls up
    expect(follower.following).toBe(false);
  });

  it('ignores the event of a row it set itself', () => {
    const fake = fakeTable(10);
    let changes = 0;
    const follower = new TableFollower(() => fake.table as any, () => 'newestLast', () => undefined, () => { changes++; });
    follower.following = false;
    follower.scrollToNewest(100);
    expect(fake.sets).toEqual([90]);
    expect(follower.following).toBe(true);
    expect(changes).toBe(1);
    follower.onFirstVisibleRowChanged(90, 100);
    expect(changes).toBe(1);
  });

  it('tells when following changes because the person scrolled', () => {
    const fake = fakeTable(10);
    let changes = 0;
    const follower = new TableFollower(() => fake.table as any, () => 'newestLast', () => undefined, () => { changes++; });
    follower.onFirstVisibleRowChanged(10, 100);
    expect(follower.following).toBe(false);
    expect(changes).toBe(1);
    follower.onFirstVisibleRowChanged(20, 100);
    expect(changes).toBe(1);
  });
});
