import { PluginsApi, basePath, messagesOf } from '../webapp/model/api';

const answer = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const recording = (status = 200, body: unknown = {}) => {
  const calls: { url: string; init: any }[] = [];
  const api = new PluginsApi('/api/plugins', async (url: string, init?: any) => { calls.push({ url, init }); return answer(status, body); });
  return { api, calls };
};

describe('basePath', () => {
  it('is prefixed behind nginx only', () => {
    expect(basePath('docker')).toBe('/admin/api/plugins');
    expect(basePath('development')).toBe('/api/plugins');
    expect(basePath(undefined)).toBe('/api/plugins');
  });
});

describe('PluginsApi requests', () => {
  it('lists with GET and the session', async () => {
    const { api, calls } = recording();
    await api.list();
    expect(calls[0].url).toBe('/api/plugins');
    expect(calls[0].init).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('uploads the raw file as application/zip', async () => {
    const { api, calls } = recording(201, { id: 'acme' });
    const file = new Blob(['zip bytes']);
    const result = await api.upload(file);
    expect(calls[0].url).toBe('/api/plugins');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/zip');
    expect(calls[0].init.body).toBe(file);
    expect(result).toMatchObject({ ok: true, status: 201, body: { id: 'acme' } });
  });

  it('enables with the version as JSON', async () => {
    const { api, calls } = recording();
    await api.enable('acme', '1.2.0');
    expect(calls[0].url).toBe('/api/plugins/acme/enable');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toEqual({ version: '1.2.0' });
  });

  it.each([
    ['disable', (api: PluginsApi) => api.disable('acme'), '/api/plugins/acme/disable', '{}'],
    ['suggested hooks', (api: PluginsApi) => api.addSuggestedHooks(['acme', 'beta']), '/api/plugins/suggested-hooks', '{"ids":["acme","beta"]}']
  ])('%s sends a JSON content type, which the route requires', async (_name, call, url, body) => {
    const { api, calls } = recording();
    await call(api);
    expect(calls[0].url).toBe(url);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(calls[0].init.body).toBe(body);
  });

  it('removes a version, encoding the path parts', async () => {
    const { api, calls } = recording();
    await api.removeVersion('acme', '1.0.0+build');
    expect(calls[0].url).toBe('/api/plugins/acme/versions/1.0.0%2Bbuild');
    expect(calls[0].init.method).toBe('DELETE');
  });
});

describe('PluginsApi failures', () => {
  it('shows a refusal by its message, whatever the code', async () => {
    const { api } = recording(409, { error: 'SOMETHING_NEW', message: 'Refused because of {reasons}.' });
    expect(await api.enable('acme', '1.0.0')).toMatchObject({ ok: false, status: 409, error: { code: 'SOMETHING_NEW', message: 'Refused because of {reasons}.' } });
  });

  it('a configuration refused by validation shows its errors too', async () => {
    const { api } = recording(400, { error: 'CONFIGURATION_INVALID', message: 'The merged configuration is not valid.', errors: ['first', 'second'] });
    const result = await api.addSuggestedHooks(['acme']);
    expect(result.error?.message).toBe('The merged configuration is not valid.\nfirst\nsecond');
  });

  it('a 413 with no JSON is the reverse proxy refusing the file', async () => {
    const { api } = recording(413, '<html>too large</html>');
    expect((await api.upload(new Blob(['x']))).error?.message).toBe('The file is larger than the server accepts.');
  });

  it('another answer with no JSON names the status', async () => {
    const { api } = recording(502, '<html>bad gateway</html>');
    expect((await api.list()).error?.message).toBe('The request failed with status 502.');
  });

  it('a network failure resolves, it does not reject', async () => {
    const api = new PluginsApi('/api/plugins', async () => { throw new Error('offline'); });
    expect(await api.list()).toEqual({ ok: false, status: 0, body: null, error: { status: 0, code: 'network', message: 'The server could not be reached.' } });
  });

  it('uses the injected translator', async () => {
    const api = new PluginsApi('/api/plugins', async () => answer(500, ''), (key, args) => `${key}:${args?.join()}`);
    expect((await api.list()).error?.message).toBe('apiRequestFailedStatus:500');
  });
});

describe('messagesOf', () => {
  it('takes the warnings of any route: objects with a message, or plain text', () => {
    expect(messagesOf({ warnings: [{ code: 'HOOKS_REFERENCE_PLUGIN', message: 'Hooks still name it.', ruleIds: ['a'] }, 'A model keeps its own list.'] }))
      .toEqual(['Hooks still name it.', 'A model keeps its own list.']);
  });
  it('is empty without warnings', () => {
    expect(messagesOf({})).toEqual([]);
    expect(messagesOf(null)).toEqual([]);
    expect(messagesOf({ warnings: 'nope' })).toEqual([]);
  });
});
