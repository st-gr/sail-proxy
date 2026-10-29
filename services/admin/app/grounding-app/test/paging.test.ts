import { loadWindow, refreshHead, nextPollInterval } from '../webapp/model/paging';

/** A fake newest-first list the gateway pages by an id cursor, like GET /grounding/jobs. */
function server(ids: string[]) {
  const calls: any[] = [];
  const fetchPage = async (options: { after?: string; limit: number }) => {
    calls.push(options);
    // Like the gateway: a cursor that names no job (deleted meanwhile) answers an empty page.
    const gone = options.after !== undefined && ids.indexOf(options.after) < 0;
    const start = options.after ? ids.indexOf(options.after) + 1 : 0;
    const data = gone ? [] : ids.slice(start, start + options.limit).map((id) => ({ id }));
    const hasMore = !gone && start + options.limit < ids.length;
    return { ok: true, status: 200, error: null, body: { data, has_more: hasMore, last_id: data.length ? data[data.length - 1].id : null } };
  };
  return { calls, fetchPage, ids };
}
const range = (n: number) => Array.from({ length: n }, (_v, i) => `job_${String(n - i).padStart(3, '0')}`);

describe('loadWindow', () => {
  it('reloads one page when the shown rows fit it', async () => {
    const s = server(range(50));
    const result = await loadWindow(s.fetchPage, 5, 20, 100);
    expect(s.calls).toEqual([{ limit: 20 }]);
    expect(result.body.data).toHaveLength(20);
    expect(result.body.has_more).toBe(true);
    expect(result.body.last_id).toBe('job_031');
  });

  it('reloads every loaded page, not just the first 100 rows', async () => {
    const s = server(range(250));
    const result = await loadWindow(s.fetchPage, 230, 20, 100);
    expect(s.calls).toEqual([{ limit: 100 }, { limit: 100, after: 'job_151' }, { limit: 30, after: 'job_051' }]);
    expect(result.body.data).toHaveLength(230);
    expect(result.body.data.map((r: any) => r.id)).toEqual(s.ids.slice(0, 230));
    expect(result.body.has_more).toBe(true);
    expect(result.body.last_id).toBe('job_021');
  });

  it('stops when the list ends before the window does (rows were deleted)', async () => {
    const s = server(range(130));
    const result = await loadWindow(s.fetchPage, 230, 20, 100);
    expect(result.body.data).toHaveLength(130);
    expect(result.body.has_more).toBe(false);
  });

  it('shows a job that arrived meanwhile at the top once, with no row repeated or lost below it', async () => {
    const before = range(120);
    const after = ['job_999', ...before];
    const s = server(after);
    const result = await loadWindow(s.fetchPage, 120, 20, 100);
    const got = result.body.data.map((r: any) => r.id);
    expect(got).toEqual(after.slice(0, 120));
    expect(new Set(got).size).toBe(got.length);
    expect(result.body.has_more).toBe(true);
  });

  it('returns the failure of any request', async () => {
    const error = { status: 500, code: 'boom' };
    let n = 0;
    const result = await loadWindow(async () => (++n === 2 ? { ok: false, status: 500, body: null, error } as any : { ok: true, status: 200, error: null, body: { data: [{ id: 'a' }], has_more: true, last_id: 'a' } }), 150, 20, 100);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(error);
  });

  it('does not loop on a page that answers more but no cursor', async () => {
    const fetchPage = jest.fn(async () => ({ ok: true, status: 200, error: null, body: { data: [], has_more: true, last_id: null } }));
    const result = await loadWindow(fetchPage, 150, 20, 100);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.body.has_more).toBe(false);
  });
});

describe('loadWindow, a deleted cursor', () => {
  it('starts again from the top when the cursor row is gone', async () => {
    const ids = range(150);
    const s = server(ids);
    let first = true;
    const fetchPage = async (options: any) => {
      // The row the second page continues after is deleted between the two requests.
      if (options.after && first) { first = false; ids.splice(ids.indexOf(options.after), 1); }
      return s.fetchPage(options);
    };
    const result = await loadWindow(fetchPage, 130, 20, 100);
    const got = result.body.data.map((r: any) => r.id);
    expect(new Set(got).size).toBe(got.length);
    expect(got).toEqual(ids.slice(0, 130));
  });
});

describe('refreshHead', () => {
  const toRow = (entry: any) => ({ id: entry.id, active: entry.id === 'job_active' });
  const rowsOf = (ids: string[]) => ids.map((id) => ({ id, active: id === 'job_active' }));
  const cursor = { hasMore: true, lastId: 'tail_last' };

  it('asks one request for 2,000 loaded rows with the only active job near the top, and keeps the tail', async () => {
    const ids = ['job_active', ...range(1999)];
    const s = server(ids);
    const result: any = await refreshHead(s.fetchPage, rowsOf(ids), cursor, toRow, 20, 100);
    expect(s.calls).toEqual([{ limit: 21 }]);
    expect(result.rows.map((r: any) => r.id)).toEqual(ids);
    expect(result.hasMore).toBe(true);
    expect(result.lastId).toBe('tail_last');
  });

  it('continues the tail after the last refreshed row when a job arrived at the top', async () => {
    const old = ['job_active', ...range(300)];
    const s = server(['job_new', ...old]);
    const result: any = await refreshHead(s.fetchPage, rowsOf(old), cursor, toRow, 20, 100);
    const got = result.rows.map((r: any) => r.id);
    expect(got).toEqual(['job_new', ...old]);
    expect(new Set(got).size).toBe(got.length);
  });

  it('reaches down to the deepest active job plus a page', async () => {
    const ids = [...range(120)];
    ids[89] = 'job_active';
    const s = server(ids);
    await refreshHead(s.fetchPage, rowsOf(ids), cursor, toRow, 20, 100);
    expect(s.calls).toEqual([{ limit: 100 }, { limit: 10, after: ids[99] }]);
  });

  it('asks for every loaded row when told to', async () => {
    const ids = range(250);
    const s = server(ids);
    const result: any = await refreshHead(s.fetchPage, rowsOf(ids), { hasMore: false, lastId: '' }, toRow, 20, 100, true);
    expect(result.rows).toHaveLength(250);
  });

  it('drops the stale tail when the list ended inside the refreshed head', async () => {
    const old = range(60);
    const s = server(old.slice(0, 25));
    const result: any = await refreshHead(s.fetchPage, rowsOf(old), cursor, toRow, 20, 100, true);
    expect(result.rows).toHaveLength(25);
    expect(result.hasMore).toBe(false);
  });
});

describe('nextPollInterval', () => {
  it('backs off to 15 s while nothing changes and resets on a change', () => {
    expect(nextPollInterval(3000, false)).toBe(6000);
    expect(nextPollInterval(6000, false)).toBe(12000);
    expect(nextPollInterval(12000, false)).toBe(15000);
    expect(nextPollInterval(15000, false)).toBe(15000);
    expect(nextPollInterval(15000, true)).toBe(3000);
  });
});
