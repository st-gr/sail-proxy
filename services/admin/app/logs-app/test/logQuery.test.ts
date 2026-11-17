import { entriesUrl, exportUrl, levelFilter, levelsAtOrAbove, pollQuery, restBase } from '../webapp/model/logQuery';

const BASE = '/odata/v4/admin';
const paramsOf = (url: string) => new URLSearchParams(url.slice(url.indexOf('?') + 1));

describe('levelsAtOrAbove', () => {
  it('takes the level as a minimum: WARN means WARN and ERROR', () => {
    expect(levelsAtOrAbove('WARN')).toEqual(['WARN', 'ERROR']);
    expect(levelsAtOrAbove('trace')).toEqual(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR']);
    expect(levelsAtOrAbove('ERROR')).toEqual(['ERROR']);
  });

  it('is empty for all levels or an unknown one', () => {
    expect(levelsAtOrAbove('')).toEqual([]);
    expect(levelsAtOrAbove('LOUD')).toEqual([]);
  });
});

describe('levelFilter', () => {
  it('is an OData condition over the levels at or above', () => {
    expect(levelFilter('WARN')).toBe("(level eq 'WARN' or level eq 'ERROR')");
    expect(levelFilter('')).toBeNull();
  });
});

describe('entriesUrl', () => {
  it('reads the newest entries first, with the columns the page shows', () => {
    const params = paramsOf(entriesUrl(BASE, { top: 2000 }));
    expect(entriesUrl(BASE, { top: 2000 }).startsWith('/odata/v4/admin/GatewayLog?')).toBe(true);
    expect(params.get('$select')).toBe('ID,loggedAt,seq,level,component,requestId,message,error,storedAt');
    expect(params.get('$orderby')).toBe('loggedAt desc,seq desc,ID desc');
    expect(params.get('$top')).toBe('2000');
    expect(params.has('$filter')).toBe(false);
    expect(params.has('$search')).toBe(false);
    expect(params.has('$count')).toBe(false);
  });

  it('a poll asks for what was stored after its cursor, with the same search and level', () => {
    const url = entriesUrl(BASE, { top: 2000, storedAfter: '2026-11-11T10:00:04.000Z', level: 'WARN', search: 'timeout' });
    expect(url).toContain(`$filter=${encodeURIComponent("storedAt gt 2026-11-11T10:00:04.000Z and (level eq 'WARN' or level eq 'ERROR')")}`);
    const params = paramsOf(url);
    expect(params.get('$filter')).toBe("storedAt gt 2026-11-11T10:00:04.000Z and (level eq 'WARN' or level eq 'ERROR')");
    expect(params.get('$search')).toBe('"timeout"');
    expect(params.get('$orderby')).toBe('loggedAt desc,seq desc,ID desc');
    expect(params.get('$select')).toBe('ID,loggedAt,seq,level,component,requestId,message,error,storedAt');
  });

  it('a time range is from and to, both included, and can ask for the count', () => {
    const params = paramsOf(entriesUrl(BASE, { top: 50, from: '2026-11-11T10:30:00.000Z', to: '2026-11-11T11:30:00.000Z', count: true }));
    expect(params.get('$filter')).toBe('loggedAt ge 2026-11-11T10:30:00.000Z and loggedAt le 2026-11-11T11:30:00.000Z');
    expect(params.get('$count')).toBe('true');
  });

  it('sends the whole search as one OData quoted string, encoded (the service searches its text literally)', () => {
    const url = entriesUrl(BASE, { top: 10, search: '  50% a&b "x" #1 + ü \\n ' });
    expect(url).toContain('$search=%2250%25%20a%26b%20%5C%22x%5C%22%20%231%20%2B%20%C3%BC%20%5C%5Cn%22');
    expect(paramsOf(url).get('$search')).toBe('"50% a&b \\"x\\" #1 + ü \\\\n"');
    expect(paramsOf(entriesUrl(BASE, { top: 10, search: '"open' })).get('$search')).toBe('"\\"open"');
    expect(paramsOf(entriesUrl(BASE, { top: 10, search: '   ' })).has('$search')).toBe(false);
  });

  it('refuses a time that is not an ISO instant rather than put it into the filter', () => {
    expect(() => entriesUrl(BASE, { top: 10, storedAfter: "2026-11-11' or 1 eq 1" })).toThrow(RangeError);
  });
});

describe('exportUrl', () => {
  it('names the time range, the search and the level, encoded', () => {
    const url = exportUrl('/admin/api', { from: '2026-11-11T10:30:00.000Z', to: '2026-11-11T11:30:00.000Z', search: 'a&b c', level: 'WARN' });
    expect(url.startsWith('/admin/api/logs/gateway/export?')).toBe(true);
    const params = paramsOf(url);
    expect(params.get('from')).toBe('2026-11-11T10:30:00.000Z');
    expect(params.get('to')).toBe('2026-11-11T11:30:00.000Z');
    expect(params.get('search')).toBe('a&b c');
    expect(params.get('level')).toBe('WARN');
    expect(url).toContain('search=a%26b%20c');
  });

  it('leaves out what is not chosen', () => {
    expect(exportUrl('/api', {})).toBe('/api/logs/gateway/export');
    expect(exportUrl('/api', { search: ' ', level: '' })).toBe('/api/logs/gateway/export');
  });
});

describe('restBase', () => {
  it('is prefixed behind nginx only (Docker and Kyma)', () => {
    expect(restBase('docker')).toBe('/admin/api');
    expect(restBase('development')).toBe('/api');
    expect(restBase(undefined)).toBe('/api');
  });
});

describe('pollQuery', () => {
  it('polls with the applied search and level (what the shown rows and the highlighting use), after the cursor', () => {
    expect(pollQuery('2026-11-11T10:00:04.000Z', { search: 'timeout', level: 'WARN' }, 2000)).toEqual({ top: 2000, search: 'timeout', level: 'WARN', storedAfter: '2026-11-11T10:00:04.000Z' });
  });

  it('without a cursor polls without a time', () => {
    expect(pollQuery(null, { search: '', level: '' }, 2000)).toEqual({ top: 2000, search: '', level: '' });
  });
});
