import { LogsApi } from '../webapp/model/api';

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }
});
const recording = (status = 200, body: unknown = {}) => {
  const calls: { url: string; init: any }[] = [];
  const api = new LogsApi('/odata/v4/admin', async (url: string, init?: any) => { calls.push({ url, init }); return answer(status, body); }, undefined, 'de-DE');
  return { api, calls };
};

describe('LogsApi requests', () => {
  it('deletes the stored log with POST and what = log, and keeps the service\'s refusal text', async () => {
    const { api, calls } = recording(200, { deleted: 4 });
    expect(await api.deleteStoredLogs('log')).toMatchObject({ ok: true, body: { deleted: 4 } });
    expect(calls[0].url).toBe('/odata/v4/admin/deleteStoredLogs');
    expect(calls[0].init).toMatchObject({ method: 'POST', body: '{"what":"log"}' });
    const refused = recording(400, { error: { code: 'LOGGING_DELETE_UNKNOWN', message: 'No.' } });
    expect((await refused.api.deleteStoredLogs('log')).error).toMatchObject({ status: 400, message: 'No.' });
  });

  it('reads entries with GET, the session and the cockpit language', async () => {
    const { api, calls } = recording(200, { value: [{ ID: 'a' }], '@odata.count': 7 });
    const result = await api.entries('/odata/v4/admin/GatewayLog?$top=1');
    expect(calls[0].url).toBe('/odata/v4/admin/GatewayLog?$top=1');
    expect(calls[0].init).toMatchObject({ method: 'GET', credentials: 'include' });
    expect(calls[0].init.headers['Accept-Language']).toBe('de-DE');
    expect(calls[0].init.headers.Accept).toBe('application/json;IEEE754Compatible=true');
    expect(result).toMatchObject({ ok: true, body: { entries: [{ ID: 'a' }], count: 7 } });
  });

  it('an answer without a count has none, and without a Date header no server time', async () => {
    const { api } = recording(200, { value: [] });
    expect((await api.entries('/x')).body).toEqual({ entries: [], count: null, serverDate: null });
  });

  it('gives the answer\'s Date header as the server time of the read', async () => {
    const api = new LogsApi('/odata/v4/admin', async () => answer(200, { value: [] }, { date: 'Wed, 11 Nov 2026 10:00:09 GMT' }));
    expect((await api.entries('/x')).body).toEqual({ entries: [], count: null, serverDate: 'Wed, 11 Nov 2026 10:00:09 GMT' });
    const bare = new LogsApi('/odata/v4/admin', async () => ({ ok: true, status: 200, text: async () => '{"value":[]}' }));
    expect((await bare.entries('/x')).body?.serverDate).toBeNull();
  });

  it('reads the settings with the function, and writes them with the actions as JSON', async () => {
    const { api, calls } = recording(200, { defaultLevel: 'DEBUG' });
    await api.getSettings();
    await api.setSettings({ logStorageEnabled: true, payloadCaptureEnabled: null, defaultLevel: null, defaultLevelMinutes: null, componentLevels: '{"A":{"level":"WARN"}}' });
    await api.resetSettings();
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', '/odata/v4/admin/getLoggingSettings()'],
      ['POST', '/odata/v4/admin/setLoggingSettings'],
      ['POST', '/odata/v4/admin/resetLoggingSettings']
    ]);
    expect(calls[1].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[1].init.body)).toEqual({ logStorageEnabled: true, payloadCaptureEnabled: null, defaultLevel: null, defaultLevelMinutes: null, componentLevels: '{"A":{"level":"WARN"}}' });
    expect(calls[2].init.body).toBe('{}');
  });
});

describe('LogsApi, payload traces and raw capture', () => {
  it('deletes the traces or everything with what = traces | all', async () => {
    const { api, calls } = recording(200, { deleted: 2 });
    await api.deleteStoredLogs('traces');
    await api.deleteStoredLogs('all');
    expect(calls.map((c) => c.init.body)).toEqual(['{"what":"traces"}', '{"what":"all"}']);
  });

  it('opens a trace and a stage with GET, the ids as quoted OData strings', async () => {
    const { api, calls } = recording(200, { masked: true, prompt: 'p', answer: 'a', problem: null });
    expect(await api.openPayloadTrace("17-0'x")).toMatchObject({ ok: true, body: { masked: true, prompt: 'p' } });
    await api.openRawStage('17-0', 'sap_request#2');
    expect(calls[0]).toMatchObject({ url: "/odata/v4/admin/openPayloadTrace(ID='17-0''x')", init: { method: 'GET' } });
    expect(calls[1].url).toBe("/odata/v4/admin/openRawStage(ID='17-0',stage='sap_request%232')");
  });

  it('starts, stops and lists raw capture sessions', async () => {
    const { api, calls } = recording(200, { value: [{ ID: 's1' }] });
    await api.startRawCapture({ apiKeyIds: ['k1'], emails: [], minutes: 15, reason: 'Ticket 42' });
    await api.stopRawCapture('s1');
    expect(await api.activeRawCapture()).toMatchObject({ ok: true, body: [{ ID: 's1' }] });
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', '/odata/v4/admin/startRawCapture'],
      ['POST', '/odata/v4/admin/stopRawCapture'],
      ['GET', '/odata/v4/admin/activeRawCapture()']
    ]);
    expect(JSON.parse(calls[0].init.body)).toEqual({ apiKeyIds: ['k1'], emails: [], minutes: 15, reason: 'Ticket 42' });
    expect(JSON.parse(calls[1].init.body)).toEqual({ ID: 's1' });
  });

  it('a download gives the file and its name, or the code of the refusal', async () => {
    const file = { ok: true, status: 200, blob: async () => 'BLOB', headers: { get: (n: string) => (n === 'Content-Disposition' ? 'attachment; filename="raw-trace-req-1.json"' : null) } };
    const calls: any[] = [];
    const api = new LogsApi('/odata/v4/admin', async (url: string, init?: any) => { calls.push({ url, init }); return file; });
    expect(await api.download('/api/logs/raw/1/download')).toEqual({ ok: true, blob: 'BLOB', fileName: 'raw-trace-req-1.json' });
    expect(calls[0].init).toMatchObject({ method: 'GET', credentials: 'include' });
    const refused = new LogsApi('/odata/v4/admin', async () => answer(409, { error: 'keys-differ', message: 'English text' }));
    expect(await refused.download('/x')).toEqual({ ok: false, status: 409, code: 'keys-differ' });
    const offline = new LogsApi('/odata/v4/admin', async () => { throw new Error('offline'); });
    expect(await offline.download('/x')).toEqual({ ok: false, status: 0, code: 'network' });
  });

  it('a cut stage keeps the server\'s text file: its name and its type are not changed', async () => {
    const blob = { type: 'text/plain; charset=utf-8' };
    const headers: Record<string, string> = { 'Content-Disposition': 'attachment; filename="raw-trace-req-1-request.txt"', 'Content-Type': 'text/plain; charset=utf-8' };
    const api = new LogsApi('/odata/v4/admin', async () => ({ ok: true, status: 200, blob: async () => blob, headers: { get: (n: string) => headers[n] ?? null } }));
    const result = await api.download('/api/logs/raw/1/download?stage=request');
    expect(result).toEqual({ ok: true, blob, fileName: 'raw-trace-req-1-request.txt' });
  });

  it('without a file name from the server, the fallback name follows the answer\'s type', async () => {
    const answerOf = (type: string | null) => new LogsApi('/odata/v4/admin', async () => ({
      ok: true, status: 200, blob: async () => 'BLOB', headers: { get: (n: string) => (n === 'Content-Type' ? type : null) }
    }));
    expect(await answerOf('text/plain; charset=utf-8').download('/x')).toMatchObject({ fileName: 'download.txt' });
    expect(await answerOf('application/json; charset=utf-8').download('/x')).toMatchObject({ fileName: 'download.json' });
    expect(await answerOf(null).download('/x')).toMatchObject({ fileName: 'download.json' });
  });
});

describe('LogsApi failures', () => {
  it('shows a refusal of the service by its message and keeps its code', async () => {
    const { api } = recording(400, { error: { code: 'LOGGING_LEVEL_INVALID', message: 'Die Stufe "LOUD" gibt es nicht.' } });
    expect((await api.setSettings({ logStorageEnabled: null, payloadCaptureEnabled: null, defaultLevel: 'LOUD', defaultLevelMinutes: null, componentLevels: null })).error)
      .toEqual({ status: 400, code: 'LOGGING_LEVEL_INVALID', message: 'Die Stufe "LOUD" gibt es nicht.' });
  });

  it('a refusal for a missing role says that the page is for administrators', async () => {
    const { api } = recording(403, { error: { code: '403', message: 'Forbidden' } });
    expect((await api.entries('/x')).error).toEqual({ status: 403, code: 'forbidden', message: 'Only administrators can see this page.' });
  });

  it('another answer without JSON names the status', async () => {
    const { api } = recording(502, '<html>bad gateway</html>');
    expect((await api.getSettings()).error?.message).toBe('The request failed with status 502.');
  });

  it('a network failure resolves, it does not reject', async () => {
    const api = new LogsApi('/odata/v4/admin', async () => { throw new Error('offline'); });
    expect(await api.entries('/x')).toEqual({ ok: false, status: 0, body: null, error: { status: 0, code: 'network', message: 'The server could not be reached.' } });
  });

  it('uses the injected translator', async () => {
    const api = new LogsApi('/odata/v4/admin', async () => answer(500, ''), (key, args) => `${key}:${args?.join()}`);
    expect((await api.getSettings()).error?.message).toBe('apiRequestFailedStatus:500');
  });
});

describe('LogsApi.deployTarget', () => {
  it('asks whoami, which tells Docker and Kyma from local development', async () => {
    const { api, calls } = recording(200, { deployTarget: 'docker' });
    expect(await api.deployTarget()).toBe('docker');
    expect(calls[0]).toMatchObject({ url: '/odata/v4/admin/whoami', init: { method: 'POST', body: '{}' } });
  });

  it('guesses local development when whoami does not answer', async () => {
    expect(await recording(500, '').api.deployTarget()).toBe('development');
    expect(await recording(200, {}).api.deployTarget()).toBe('development');
    expect(await new LogsApi('/odata/v4/admin', async () => { throw new Error('offline'); }).deployTarget()).toBe('development');
  });
});
