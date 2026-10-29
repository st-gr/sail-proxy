import { toStoreRow, toStoreFileRows, toFileRows, expiryText } from '../webapp/model/rows';

const STORE = {
  id: 'vs_1', object: 'vector_store', created_at: 1767225600, name: 'Docs', usage_bytes: 2048,
  file_counts: { in_progress: 1, completed: 3, failed: 1, cancelled: 0, total: 5 },
  status: 'in_progress', expires_after: { anchor: 'last_active_at', days: 7 }, expires_at: 1767830400,
  last_active_at: 1767225600, metadata: {}
};

describe('toStoreRow', () => {
  it('maps a vector store object to a table row', () => {
    const row = toStoreRow(STORE);
    expect(row).toMatchObject({ id: 'vs_1', name: 'Docs', status: 'in_progress', statusText: 'In progress', statusState: 'Information', files: 5, failedFiles: 1, size: '2.0 KB' });
    expect(row.lastActive.replace(/\s/g, ' ')).toBe('Jan 1, 2026, 12:00 AM');
    expect(row.expires).toContain('7 days');
  });
  it('names an unnamed store by its id and survives missing counts', () => {
    expect(toStoreRow({ id: 'vs_2', status: 'completed' })).toMatchObject({ name: 'vs_2', files: 0, failedFiles: 0, size: '0 B', expires: 'Never' });
  });
});

describe('toStoreRow sharing', () => {
  it('treats a store object without sharing fields as the caller\'s own, not shared', () => {
    expect(toStoreRow(STORE)).toMatchObject({ shared: false, sharedText: '', owned: true, ownerEmail: '', readOnly: false });
  });
  it('marks a store another admin shared: badge, owner, read-only', () => {
    expect(toStoreRow({ ...STORE, is_shared: true, owned: false, owner_email: 'boss@test.com' }))
      .toMatchObject({ shared: true, sharedText: 'Shared', owned: false, ownerEmail: 'boss@test.com', readOnly: true });
  });
  it('words the single-team case in the singular', () => {
    expect(toStoreRow({ ...STORE, team_ids: ['t1'] }).teamSharedText).toBe('Shared with 1 team');
  });
  it('counts the teams a store is shared with', () => {
    const row = toStoreRow({ ...STORE, team_ids: ['t1', 't2'] });
    expect(row.teamIds).toEqual(['t1', 't2']);
    expect(row.teamSharedText).toBe('Shared with 2 teams');
    expect(toStoreRow(STORE)).toMatchObject({ teamIds: [], teamSharedText: '' });
  });
  it('keeps a store the caller owns and shared editable, with the badge', () => {
    expect(toStoreRow({ ...STORE, is_shared: true, owned: true, owner_email: 'me@test.com' })).toMatchObject({ sharedText: 'Shared', readOnly: false });
  });
  it('translates the badge', () => {
    expect(toStoreRow({ ...STORE, is_shared: true }, (key) => (key === 'sharedBadge' ? 'Freigegeben' : key)).sharedText).toBe('Freigegeben');
  });
});

describe('toStoreRow embedding', () => {
  const EMBED = { embedding_model: 'text-embedding-3-small', embedding_dim: 1536, active_generation: 2, embedding_state: 'outdated', reembed_job_id: null };
  it('shows the model, dimension, generation and state', () => {
    expect(toStoreRow({ ...STORE, ...EMBED })).toMatchObject({
      embeddingModel: 'text-embedding-3-small', embeddingDim: 1536, generation: 2, embeddingState: 'outdated',
      embeddingStateText: 'Outdated', embeddingStateColor: 'Warning', embeddingAttention: true, reembedJobId: '', reembedding: false
    });
  });
  it('offers a re-embed only to the owner of an outdated store with no re-embed running that has not expired', () => {
    expect(toStoreRow({ ...STORE, ...EMBED }).canReembed).toBe(true);
    expect(toStoreRow({ ...STORE, ...EMBED, owned: false, is_shared: true, owner_email: 'boss@test.com' }).canReembed).toBe(false);
    expect(toStoreRow({ ...STORE, ...EMBED, reembed_job_id: 'job_9' })).toMatchObject({ canReembed: false, reembedJobId: 'job_9', reembedding: true });
    expect(toStoreRow({ ...STORE, ...EMBED, status: 'expired' }).canReembed).toBe(false);
    expect(toStoreRow({ ...STORE, ...EMBED, embedding_state: 'current' })).toMatchObject({ canReembed: false, embeddingAttention: false, embeddingStateColor: 'Success' });
    expect(toStoreRow({ ...STORE, ...EMBED, embedding_state: 'dimension_mismatch' })).toMatchObject({ canReembed: false, embeddingAttention: true, embeddingStateColor: 'Error' });
  });
  it('survives a store object without the embedding fields (an older gateway)', () => {
    expect(toStoreRow(STORE)).toMatchObject({ embeddingModel: '', embeddingDim: 0, generation: 0, embeddingState: '', embeddingStateText: '', embeddingAttention: false, canReembed: false });
  });
});

describe('expiryText', () => {
  it('says never without a policy', () => { expect(expiryText(null, null)).toBe('Never'); });
  it('names the policy and the date', () => {
    expect(expiryText({ anchor: 'last_active_at', days: 1 }, 1767225600).replace(/\s/g, ' ')).toBe('1 day after last use (Jan 1, 2026, 12:00 AM)');
    expect(expiryText({ anchor: 'last_active_at', days: 30 }, null)).toBe('30 days after last use');
  });
});

describe('toStoreFileRows', () => {
  it('joins the store\'s files with the file list for names and sizes', () => {
    const rows = toStoreFileRows(
      [{ id: 'file-a', status: 'failed', usage_bytes: 0, last_error: { message: 'Unsupported file type' } },
       { id: 'file-gone', status: 'completed', usage_bytes: 100, last_error: null }],
      { 'file-a': { id: 'file-a', filename: 'slides.pptx', bytes: 1024 } }
    );
    expect(rows).toEqual([
      { id: 'file-a', filename: 'slides.pptx', status: 'failed', statusText: 'Failed', statusState: 'Error', size: '1.0 KB', error: 'Unsupported file type',
        contextIncomplete: false, contextIncompleteTooltip: '' },
      { id: 'file-gone', filename: 'file-gone', status: 'completed', statusText: 'Completed', statusState: 'Success', size: '100 B', error: '',
        contextIncomplete: false, contextIncompleteTooltip: '' }
    ]);
  });
  it('marks a file whose context writer stopped at its limit, and whether the fill already retried it', () => {
    const rows = toStoreFileRows([
      { id: 'f1', status: 'completed', context_stopped: 'deadline' },
      { id: 'f2', status: 'completed', context_stopped: 'deadline_retried' },
      { id: 'f3', status: 'completed', context_stopped: null },
      { id: 'f4', status: 'completed' }
    ], {});
    expect(rows.map((r) => r.contextIncomplete)).toEqual([true, true, false, false]);
    expect(rows[0].contextIncompleteTooltip).toMatch(/tries once more/);
    expect(rows[1].contextIncompleteTooltip).toMatch(/does not try again/);
    // a token-limit stop is final at once: the same budget would stop a retry again
    expect(toStoreFileRows([{ id: 'f5', status: 'completed', context_stopped: 'budget' }], {})[0].contextIncompleteTooltip)
      .toMatch(/does not try again/);
    expect(rows[2].contextIncompleteTooltip).toBe('');
    const keys: string[] = [];
    toStoreFileRows([{ id: 'f1', status: 'completed', context_stopped: 'deadline' }, { id: 'f2', status: 'completed', context_stopped: 'budget' }],
      {}, (key) => { keys.push(key); return key; });
    expect(keys).toEqual(expect.arrayContaining(['fileContextIncompleteTooltip', 'fileContextIncompleteFinalTooltip']));
  });
});

describe('toFileRows', () => {
  it('lists each file with the stores it is attached to', () => {
    const rows = toFileRows(
      [{ id: 'file-a', filename: 'note.txt', bytes: 5, created_at: 1767225600 }, { id: 'file-b', filename: 'b.md', bytes: 2048, created_at: 1767225600 }],
      { 'file-a': [{ store_id: 'vs_1', store_name: 'Docs', status: 'completed' }, { store_id: 'vs_2', store_name: null, status: 'failed' }], 'file-b': [] }
    );
    expect(rows[0]).toMatchObject({ id: 'file-a', filename: 'note.txt', size: '5 B', bytes: 5, stores: 'Docs, vs_2', storeCount: 2 });
    expect(rows[1]).toMatchObject({ id: 'file-b', stores: '', storeCount: 0 });
  });
  it('treats a missing attachment map entry as no stores', () => {
    expect(toFileRows([{ id: 'file-a', filename: 'note.txt', bytes: 5, created_at: 0 }], {})[0]).toMatchObject({ stores: '', storeCount: 0 });
  });
});

describe('the cockpit language', () => {
  it('passes the locale to every size and date of a row', () => {
    const store = toStoreRow({ id: 'vs_1', usage_bytes: 1536, created_at: 1767225600, last_active_at: 1767225600, expires_after: { days: 7 }, expires_at: 1767225600 }, undefined, 'de');
    expect(store).toMatchObject({ size: '1,5 KB', created: '01.01.2026, 00:00', lastActive: '01.01.2026, 00:00', expires: '7 days after last use (01.01.2026, 00:00)' });
    expect(toStoreFileRows([{ id: 'f', status: 'completed', usage_bytes: 1536 }], {}, undefined, 'de')[0].size).toBe('1,5 KB');
    expect(toFileRows([{ id: 'f', filename: 'a.md', bytes: 1536, created_at: 1767225600 }], {}, 'de')[0]).toMatchObject({ size: '1,5 KB', created: '01.01.2026, 00:00' });
  });
});
