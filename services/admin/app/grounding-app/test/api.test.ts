import { GroundingApi, basePath, errorOf } from '../webapp/model/api';

function response(status: number, body: any): any {
  return { ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('no body'); return body; } };
}

describe('basePath', () => {
  it('uses the /admin prefix behind nginx and the bare path in local dev', () => {
    expect(basePath('docker')).toBe('/admin/api/grounding');
    expect(basePath('development')).toBe('/api/grounding');
    expect(basePath(undefined)).toBe('/api/grounding');
  });
});

describe('errorOf', () => {
  it('reads the gateway\'s OpenAI-shaped error', () => {
    expect(errorOf(409, { error: { message: 'The file is attached.', type: 'invalid_request_error', code: 'file_in_use' } }))
      .toEqual({ status: 409, code: 'file_in_use', message: 'The file is attached.' });
  });
  it('reads the admin layer\'s flat error', () => {
    expect(errorOf(502, { error: 'gateway_unreachable', message: 'The gateway could not be reached.' }))
      .toEqual({ status: 502, code: 'gateway_unreachable', message: 'The gateway could not be reached.' });
  });
  it('still says something for a body it cannot read', () => {
    expect(errorOf(500, null)).toEqual({ status: 500, code: 'http_500', message: 'The request failed with status 500.' });
  });
  it('explains a 413 that carries no JSON: the reverse proxy refused the upload', () => {
    expect(errorOf(413, null)).toEqual({ status: 413, code: 'http_413', message: 'The file is larger than the server accepts.' });
  });
});

describe('GroundingApi', () => {
  it('sends JSON with credentials and resolves ok with the body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { id: 'vs_1' }));
    const result = await new GroundingApi('/api/grounding', fetchImpl).createStore('Docs', 7);
    expect(result).toEqual({ ok: true, status: 200, body: { id: 'vs_1' }, error: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/grounding/stores');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ name: 'Docs', expires_after: { anchor: 'last_active_at', days: 7 } });
  });

  it('creates a store without an expiry policy when no days are given', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { id: 'vs_1' }));
    await new GroundingApi('/api/grounding', fetchImpl).createStore('Docs');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ name: 'Docs' });
  });

  it('creates a store with its chunking setting when one is given', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { id: 'vs_1' }));
    const chunking = { type: 'structure' as const, max_tokens: 800, overlap_tokens: 0, contextual: true };
    await new GroundingApi('/api/grounding', fetchImpl).createStore('Docs', undefined, chunking);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ name: 'Docs', chunking });
  });

  it('estimates and starts a re-chunk, for the owner and through the admin routes', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {}));
    const api = new GroundingApi('/api/grounding', fetchImpl);
    const setting = { type: 'structure' as const, max_tokens: 600, overlap_tokens: 0, contextual: true };
    await api.chunkingEstimate('vs/1', setting);
    await api.startChunking('vs_1', setting);
    await api.adminChunkingEstimate('vs_2', { ...setting, contextual: false });
    await api.adminStartChunking('vs_2', setting);
    expect(fetchImpl.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['/api/grounding/stores/vs%2F1/chunking/estimate?type=structure&max_tokens=600&overlap_tokens=0&contextual=true', 'GET'],
      ['/api/grounding/stores/vs_1/chunking', 'POST'],
      ['/api/grounding/admin/stores/vs_2/chunking/estimate?type=structure&max_tokens=600&overlap_tokens=0&contextual=false', 'GET'],
      ['/api/grounding/admin/stores/vs_2/chunking', 'POST']
    ]);
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ chunking: setting });
    expect(JSON.parse(fetchImpl.mock.calls[3][1].body)).toEqual({ chunking: setting });
  });

  it('estimates and starts a re-extract, for the owner and through the admin routes (no body)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {}));
    const api = new GroundingApi('/api/grounding', fetchImpl);
    await api.reextractEstimate('vs/1');
    await api.startReextract('vs_1');
    await api.adminReextractEstimate('vs_2');
    await api.adminStartReextract('vs_2');
    expect(fetchImpl.mock.calls.map((call) => [call[0], call[1].method, call[1].body])).toEqual([
      ['/api/grounding/stores/vs%2F1/reextract/estimate', 'GET', undefined],
      ['/api/grounding/stores/vs_1/reextract', 'POST', undefined],
      ['/api/grounding/admin/stores/vs_2/reextract/estimate', 'GET', undefined],
      ['/api/grounding/admin/stores/vs_2/reextract', 'POST', undefined]
    ]);
  });

  it('sends a vision mode in the estimate query and the start body (off stays out), and asks the admin for a price', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {}));
    const api = new GroundingApi('/api/grounding', fetchImpl);
    const setting = { type: 'static' as const, max_tokens: 800, overlap_tokens: 400, contextual: false, vision: 'auto' as const };
    await api.chunkingEstimate('vs_1', setting);
    await api.chunkingEstimate('vs_1', { ...setting, vision: 'off' });
    await api.startChunking('vs_1', setting);
    await api.modelCost('gemini-3.5-flash-lite', 125000.4, 4096);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      '/api/grounding/stores/vs_1/chunking/estimate?type=static&max_tokens=800&overlap_tokens=400&contextual=false&vision=auto',
      '/api/grounding/stores/vs_1/chunking/estimate?type=static&max_tokens=800&overlap_tokens=400&contextual=false',
      '/api/grounding/stores/vs_1/chunking',
      '/api/grounding/model-cost?model=gemini-3.5-flash-lite&input_tokens=125000&output_tokens=4096'
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ chunking: setting });
  });

  it('calls the blob storage routes: the overview, the connection test and the migration start with its target', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {}));
    const api = new GroundingApi('/api/grounding', fetchImpl);
    await api.adminBlobStorage();
    await api.adminBlobStorageTest();
    await api.adminBlobMigrate('s3');
    expect(fetchImpl.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['/api/grounding/admin/blob-storage', 'GET'], ['/api/grounding/admin/blob-storage/test', 'POST'], ['/api/grounding/admin/blob-storage/migrate', 'POST']
    ]);
    expect(fetchImpl.mock.calls[1][1].body).toBeUndefined();
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ target: 's3' });
  });

  it('never rejects: a failed request and a network error are results', async () => {
    const failing = new GroundingApi('/api/grounding', jest.fn().mockResolvedValue(response(404, { error: { code: 'not_found', message: 'No such store.' } })));
    expect(await failing.getStore('vs_x')).toEqual({ ok: false, status: 404, body: { error: { code: 'not_found', message: 'No such store.' } }, error: { status: 404, code: 'not_found', message: 'No such store.' } });
    const offline = new GroundingApi('/api/grounding', jest.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await offline.status()).toEqual({ ok: false, status: 0, body: null, error: { status: 0, code: 'network_error', message: 'The server could not be reached.' } });
  });

  it('takes its own error texts from the injected translator', async () => {
    const t = (key: string, args?: (string | number)[]) => `${key}${args ? `:${args.join(',')}` : ''}`;
    const offline = new GroundingApi('/api/grounding', jest.fn().mockRejectedValue(new TypeError('Failed to fetch')), t);
    expect((await offline.status()).error?.message).toBe('apiServerUnreachable');
    const tooLarge = new GroundingApi('/api/grounding', jest.fn().mockResolvedValue(response(413, undefined)), t);
    expect((await tooLarge.status()).error?.message).toBe('apiFileTooLarge');
    const failing = new GroundingApi('/api/grounding', jest.fn().mockResolvedValue(response(500, undefined)), t);
    expect((await failing.status()).error?.message).toBe('apiRequestFailedStatus:500');
  });

  it('follows has_more until the list is complete', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(200, { object: 'list', data: [{ id: 'a' }, { id: 'b' }], has_more: true, last_id: 'b' }))
      .mockResolvedValueOnce(response(200, { object: 'list', data: [{ id: 'c' }], has_more: false, last_id: 'c' }));
    const result = await new GroundingApi('/api/grounding', fetchImpl).listFiles();
    expect(result.body).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(['/api/grounding/files?limit=100&order=desc', '/api/grounding/files?limit=100&order=desc&after=b']);
  });

  it('stops paging when a page fails and reports that failure', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(200, { data: [{ id: 'a' }], has_more: true, last_id: 'a' }))
      .mockResolvedValueOnce(response(503, { error: { code: 'file_search_unavailable', message: 'file_search is unavailable.' } }));
    const result = await new GroundingApi('/api/grounding', fetchImpl).listStores();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('file_search_unavailable');
    expect(result.body).toBeNull();
  });

  it('encodes ids in paths', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {}));
    const api = new GroundingApi('/api/grounding', fetchImpl);
    await api.detachFile('vs/1', 'file a');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/grounding/stores/vs%2F1/files/file%20a');
    expect(api.downloadUrl('file a')).toBe('/api/grounding/files/file%20a/content');
  });

  it('asks for attachments in groups of 100 ids and merges the answers', async () => {
    const ids = Array.from({ length: 150 }, (_v, i) => `file-${i}`);
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(200, { data: { 'file-0': [{ store_id: 'vs_1', store_name: 'Docs', status: 'completed' }] } }))
      .mockResolvedValueOnce(response(200, { data: { 'file-149': [] } }));
    const result = await new GroundingApi('/api/grounding', fetchImpl).fileAttachments(ids);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(`/api/grounding/file-attachments?file_ids=${ids.slice(0, 100).join('%2C')}`);
    expect(result.body).toEqual({ 'file-0': [{ store_id: 'vs_1', store_name: 'Docs', status: 'completed' }], 'file-149': [] });
  });

  it('uploads as multipart with purpose assistants and no JSON content type', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { id: 'file-new' }));
    await new GroundingApi('/api/grounding', fetchImpl).uploadFile(new Blob(['hello']), 'note.txt');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/grounding/files');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('purpose')).toBe('assistants');
    expect((init.body.get('file') as File).name).toBe('note.txt');
  });

  it('asks for detach when deleting an attached file', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { deleted: true }));
    const api = new GroundingApi('/api/grounding', fetchImpl);
    await api.deleteFile('file-a', true);
    await api.deleteFile('file-b', false);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(['/api/grounding/files/file-a?detach=true', '/api/grounding/files/file-b']);
  });

  describe('jobs, retries and search', () => {
    const calls = async (run: (api: GroundingApi) => Promise<any>, body: any = {}) => {
      const fetchImpl = jest.fn().mockResolvedValue(response(200, body));
      const result = await run(new GroundingApi('/api/grounding', fetchImpl));
      return { result, url: fetchImpl.mock.calls[0][0], init: fetchImpl.mock.calls[0][1] };
    };

    it('lists one page of jobs with limit, cursor and state, and keeps the envelope', async () => {
      const page = { object: 'list', data: [{ id: 'job_1' }], has_more: true, last_id: 'job_1' };
      const { result, url, init } = await calls((api) => api.listJobs({ limit: 20, after: 'job_0', state: 'running' }), page);
      expect(url).toBe('/api/grounding/jobs?limit=20&after=job_0&state=running');
      expect(init.method).toBe('GET');
      expect(result.body).toEqual(page);
    });
    it('lists jobs without options', async () => {
      expect((await calls((api) => api.listJobs())).url).toBe('/api/grounding/jobs');
    });
    it('reads, cancels and retries a job', async () => {
      expect((await calls((api) => api.getJob('job_1'))).url).toBe('/api/grounding/jobs/job_1');
      const cancel = await calls((api) => api.cancelJob('job_1'));
      expect([cancel.url, cancel.init.method, cancel.init.body]).toEqual(['/api/grounding/jobs/job_1/cancel', 'POST', undefined]);
      const retry = await calls((api) => api.retryJob('job_1'));
      expect([retry.url, retry.init.method]).toEqual(['/api/grounding/jobs/job_1/retry', 'POST']);
    });
    it('retries one file, encoding both ids', async () => {
      const { url, init } = await calls((api) => api.retryFile('vs/1', 'file a'));
      expect([url, init.method]).toEqual(['/api/grounding/stores/vs%2F1/files/file%20a/retry', 'POST']);
    });
    it('searches a store with the built request', async () => {
      const { url, init } = await calls((api) => api.searchStore('vs_1', { query: 'refunds', max_num_results: 5 }));
      expect([url, init.method]).toEqual(['/api/grounding/stores/vs_1/search', 'POST']);
      expect(JSON.parse(init.body)).toEqual({ query: 'refunds', max_num_results: 5 });
    });
    it('creates a file batch from file ids', async () => {
      const { url, init } = await calls((api) => api.createFileBatch('vs_1', ['file-a', 'file-b']));
      expect([url, init.method]).toEqual(['/api/grounding/stores/vs_1/file_batches', 'POST']);
      expect(JSON.parse(init.body)).toEqual({ file_ids: ['file-a', 'file-b'] });
    });
    it('lists a batch\'s files, optionally only the failed ones, following pages', async () => {
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(response(200, { data: [{ id: 'a' }], has_more: true, last_id: 'a' }))
        .mockResolvedValueOnce(response(200, { data: [{ id: 'b' }], has_more: false, last_id: 'b' }));
      const result = await new GroundingApi('/api/grounding', fetchImpl).listBatchFiles('vs_1', 'vsfb_1', 'failed');
      expect(result.body).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
        '/api/grounding/stores/vs_1/file_batches/vsfb_1/files?limit=100&order=desc&filter=failed',
        '/api/grounding/stores/vs_1/file_batches/vsfb_1/files?limit=100&order=desc&filter=failed&after=a'
      ]);
    });
    it('estimates and starts the re-embed of the caller\'s store', async () => {
      const estimate = await calls((api) => api.reembedEstimate('vs/1'), { files: 1, chunks: 2, estimated_tokens: 3, state: 'outdated' });
      expect([estimate.url, estimate.init.method, estimate.result.body.files]).toEqual(['/api/grounding/stores/vs%2F1/reembed/estimate', 'GET', 1]);
      const start = await calls((api) => api.reembedStore('vs_1'));
      expect([start.url, start.init.method, start.init.body]).toEqual(['/api/grounding/stores/vs_1/reembed', 'POST', undefined]);
    });
    it('reads the caller\'s own storage', async () => {
      const { url, init } = await calls((api) => api.storage());
      expect([url, init.method]).toEqual(['/api/grounding/storage', 'GET']);
    });
  });

  describe('administration', () => {
    const calls = async (run: (api: GroundingApi) => Promise<any>, body: any = {}) => {
      const fetchImpl = jest.fn().mockResolvedValue(response(200, body));
      const result = await run(new GroundingApi('/api/grounding', fetchImpl));
      return { result, url: fetchImpl.mock.calls[0][0], init: fetchImpl.mock.calls[0][1] };
    };
    it('reads the overview', async () => {
      const { url, init } = await calls((api) => api.overview());
      expect([url, init.method]).toEqual(['/api/grounding/admin/overview', 'GET']);
    });
    it('lists stores with no query, or with owner, status, shared, embedding_state, after and limit encoded', async () => {
      expect((await calls((api) => api.adminStores())).url).toBe('/api/grounding/admin/stores');
      expect((await calls((api) => api.adminStores({ owner: 'a+b@test.com', status: 'failed', shared: false, embedding_state: 'outdated', after: 'vs_1', limit: 50 }))).url)
        .toBe('/api/grounding/admin/stores?owner=a%2Bb%40test.com&status=failed&shared=false&embedding_state=outdated&after=vs_1&limit=50');
      expect((await calls((api) => api.adminStores({ shared: true, owner: '' }))).url).toBe('/api/grounding/admin/stores?shared=true');
    });
    it('lists files, failed ingestions, storage and jobs as single pages', async () => {
      expect((await calls((api) => api.adminFiles({ owner: 'x@test.com', limit: 20 }))).url).toBe('/api/grounding/admin/files?owner=x%40test.com&limit=20');
      expect((await calls((api) => api.adminFailed({ after: 'vs_1/file-a' }))).url).toBe('/api/grounding/admin/failed?after=vs_1%2Ffile-a');
      expect((await calls((api) => api.adminStorage({ after: 'a@test.com' }))).url).toBe('/api/grounding/admin/storage?after=a%40test.com');
      expect((await calls((api) => api.adminJobs({ owner: 'x@test.com', state: 'running' }))).url).toBe('/api/grounding/admin/jobs?owner=x%40test.com&state=running');
    });
    it('does not follow pages: one request per call', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(response(200, { data: [{ id: 'a' }], has_more: true, last_id: 'a' }));
      const result = await new GroundingApi('/api/grounding', fetchImpl).adminFiles();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.body.has_more).toBe(true);
    });
    it('deletes a store and a file, encoding the ids', async () => {
      const store = await calls((api) => api.adminDeleteStore('vs/1'));
      expect([store.url, store.init.method]).toEqual(['/api/grounding/admin/stores/vs%2F1', 'DELETE']);
      const file = await calls((api) => api.adminDeleteFile('file a'));
      expect([file.url, file.init.method]).toEqual(['/api/grounding/admin/files/file%20a', 'DELETE']);
    });
    it('retries a failed ingestion, shares and unshares', async () => {
      const retry = await calls((api) => api.adminRetry('vs/1', 'file a'));
      expect([retry.url, retry.init.method]).toEqual(['/api/grounding/admin/stores/vs%2F1/files/file%20a/retry', 'POST']);
      const share = await calls((api) => api.share('vs_1'));
      expect([share.url, share.init.method]).toEqual(['/api/grounding/admin/stores/vs_1/share', 'POST']);
      const unshare = await calls((api) => api.unshare('vs_1'));
      expect([unshare.url, unshare.init.method]).toEqual(['/api/grounding/admin/stores/vs_1/unshare', 'POST']);
    });
    it('reads one page of a re-embed job\'s failures, the owner\'s and any owner\'s, encoding id and cursor', async () => {
      const own = await calls((api) => api.jobFailures('job/1', { after: 'job_c/file-a', limit: 50 }));
      expect([own.url, own.init.method]).toEqual(['/api/grounding/jobs/job%2F1/failures?after=job_c%2Ffile-a&limit=50', 'GET']);
      expect((await calls((api) => api.jobFailures('job_1'))).url).toBe('/api/grounding/jobs/job_1/failures');
      const any = await calls((api) => api.adminJobFailures('job_b', { limit: 50 }));
      expect([any.url, any.init.method]).toEqual(['/api/grounding/admin/jobs/job_b/failures?limit=50', 'GET']);
    });
    it('reads one job of any owner, encoding its id', async () => {
      const { url, init } = await calls((api) => api.adminGetJob('job/1'));
      expect([url, init.method]).toEqual(['/api/grounding/admin/jobs/job%2F1', 'GET']);
    });
    it('reads every failed member of one batch of any owner, following the pages', async () => {
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(response(200, { data: [{ id: 'vs_1/file-a' }], has_more: true, last_id: 'vs_1/file-a' }))
        .mockResolvedValueOnce(response(200, { data: [{ id: 'vs_1/file-b' }], has_more: false, last_id: 'vs_1/file-b' }));
      const result = await new GroundingApi('/api/grounding', fetchImpl).adminBatchFailures('vsfb/1');
      expect(fetchImpl.mock.calls.map((c: any[]) => c[0])).toEqual([
        '/api/grounding/admin/failed?limit=100&order=desc&batch_id=vsfb%2F1',
        '/api/grounding/admin/failed?limit=100&order=desc&batch_id=vsfb%2F1&after=vs_1%2Ffile-a'
      ]);
      expect(result.body).toEqual([{ id: 'vs_1/file-a' }, { id: 'vs_1/file-b' }]);
    });
    it('re-embeds one store, estimates and starts the bulk re-embed, cancels and retries a re-embed job', async () => {
      const one = await calls((api) => api.adminReembedStore('vs/1'));
      expect([one.url, one.init.method, one.init.body]).toEqual(['/api/grounding/admin/stores/vs%2F1/reembed', 'POST', undefined]);
      const storeEstimate = await calls((api) => api.adminReembedStoreEstimate('vs/1'), { files: 2, chunks: 5, estimated_tokens: 40, state: 'outdated' });
      expect([storeEstimate.url, storeEstimate.init.method, storeEstimate.result.body])
        .toEqual(['/api/grounding/admin/stores/vs%2F1/reembed/estimate', 'GET', { files: 2, chunks: 5, estimated_tokens: 40, state: 'outdated' }]);
      const estimate = await calls((api) => api.adminReembedEstimate(), { stores: 2, skipped: [] });
      expect([estimate.url, estimate.init.method, estimate.result.body]).toEqual(['/api/grounding/admin/reembed-outdated/estimate', 'GET', { stores: 2, skipped: [] }]);
      const bulk = await calls((api) => api.adminReembedOutdated());
      expect([bulk.url, bulk.init.method]).toEqual(['/api/grounding/admin/reembed-outdated', 'POST']);
      const cancel = await calls((api) => api.adminCancelJob('job 1'));
      expect([cancel.url, cancel.init.method]).toEqual(['/api/grounding/admin/jobs/job%201/cancel', 'POST']);
      const retry = await calls((api) => api.adminRetryJob('job_1'));
      expect([retry.url, retry.init.method]).toEqual(['/api/grounding/admin/jobs/job_1/retry', 'POST']);
    });
    it('returns the gateway\'s refusal for a non-admin', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(response(403, { error: { message: 'This operation requires a grounding administrator.', type: 'permission_error', code: 'grounding_admin_required' } }));
      const result = await new GroundingApi('/api/grounding', fetchImpl).overview();
      expect(result.error).toMatchObject({ status: 403, code: 'grounding_admin_required' });
    });
  });
});
