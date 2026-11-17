import { downloadUrl, rawIndexQuery, rawListQuery, traceByRequestQuery, traceListQuery } from '../webapp/model/traceQuery';

const RANGE = { from: '2026-11-13T09:00:00.000Z', to: '2026-11-13T10:00:00.000Z' };
const params = (query: string) => new URLSearchParams(query);

describe('traceListQuery', () => {
  it('asks for a time range first: without one there is no query', () => {
    expect(traceListQuery(null, '')).toEqual({ ok: false, reason: 'range-required' });
    expect(traceListQuery(null, 'gpt')).toEqual({ ok: false, reason: 'range-required' });
    expect(traceListQuery({ from: '', to: '' }, '')).toEqual({ ok: false, reason: 'range-required' });
  });

  it('filters capturedAt with two chained conditions, newest first, at most 2,000 rows, with the count', () => {
    const result = traceListQuery(RANGE, '');
    expect(result.ok).toBe(true);
    const query = params((result as { ok: true; query: string }).query);
    expect(query.get('$filter')).toBe('capturedAt ge 2026-11-13T09:00:00.000Z and capturedAt le 2026-11-13T10:00:00.000Z');
    expect(query.get('$orderby')).toBe('capturedAt desc,ID desc');
    expect(query.get('$top')).toBe('2000');
    expect(query.get('$count')).toBe('true');
    expect(query.has('$search')).toBe(false);
  });

  it('reads the facts only: no prompt or answer in the list', () => {
    const query = params((traceListQuery(RANGE, '') as { ok: true; query: string }).query);
    const columns = query.get('$select')!.split(',');
    expect(columns).toEqual(expect.arrayContaining(['ID', 'capturedAt', 'requestId', 'endpoint', 'model', 'keyName', 'userEmail', 'statusCode', 'durationMs', 'masked', 'raw', 'promptSealed']));
    expect(columns).not.toContain('prompt');
    expect(columns).not.toContain('answer');
  });

  it('an open end keeps the other condition only', () => {
    const query = params((traceListQuery({ from: RANGE.from, to: '' }, '') as { ok: true; query: string }).query);
    expect(query.get('$filter')).toBe('capturedAt ge 2026-11-13T09:00:00.000Z');
  });

  it('sends the filter text as one quoted OData string, trimmed', () => {
    const query = params((traceListQuery(RANGE, '  say "hi" \\ ') as { ok: true; query: string }).query);
    expect(query.get('$search')).toBe('"say \\"hi\\" \\\\"');
  });

  it('refuses an end that is not an ISO instant (it goes into the filter unquoted)', () => {
    expect(() => traceListQuery({ from: "2026-11-13' or 1 eq 1", to: '' }, '')).toThrow(RangeError);
  });
});

describe('traceByRequestQuery and rawIndexQuery', () => {
  it('find a request\'s trace and raw stages by its request id, quotes doubled', () => {
    expect(params(traceByRequestQuery("req-1'x")).get('$filter')).toBe("requestId eq 'req-1''x'");
    const raw = params(rawIndexQuery('req-1'));
    expect(raw.get('$filter')).toBe("requestId eq 'req-1'");
    expect(raw.get('$select')).toBe('ID,requestId,sessionId,capturedAt,stageIndex,cutStages');
  });
});

describe('rawListQuery', () => {
  it('reads the raw traces of the same range, by the same chained conditions', () => {
    const query = params(rawListQuery(RANGE)!);
    expect(query.get('$filter')).toBe('capturedAt ge 2026-11-13T09:00:00.000Z and capturedAt le 2026-11-13T10:00:00.000Z');
    expect(query.get('$select')).toBe('ID,requestId,capturedAt');
    expect(query.get('$top')).toBe('2000');
    expect(rawListQuery(null)).toBeNull();
  });
});

describe('downloadUrl', () => {
  it('gives the download of a trace and of all stages of a raw trace', () => {
    expect(downloadUrl('trace', 'abc-1')).toBe('/api/logs/traces/abc-1/download');
    expect(downloadUrl('raw', 'abc-1')).toBe('/api/logs/raw/abc-1/download');
  });

  it('encodes the id and follows the deployment\'s REST base', () => {
    expect(downloadUrl('raw', '1700000000000-0/x', '/admin/api')).toBe('/admin/api/logs/raw/1700000000000-0%2Fx/download');
  });

  it('gives the download of one stage of a raw trace, the stage name encoded', () => {
    expect(downloadUrl('raw', 'abc-1', '/api', 'request#2')).toBe('/api/logs/raw/abc-1/download?stage=request%232');
    expect(downloadUrl('raw', 'abc-1', '/admin/api', 'upstream request & answer')).toBe('/admin/api/logs/raw/abc-1/download?stage=upstream%20request%20%26%20answer');
  });

  it('a trace has no stages: a stage name is not added to its download', () => {
    expect(downloadUrl('trace', 'abc-1', '/api', 'request')).toBe('/api/logs/traces/abc-1/download');
  });
});
