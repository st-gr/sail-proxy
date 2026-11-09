import {
  embeddingStateText, embeddingStateColor, embeddingReasonText, estimateFigures, toSkippedRows, lastFailedReembed,
  pollsStoreOnly
} from '../webapp/model/reembed';

const DE = (key: string, args?: (string | number)[]) => {
  const texts: Record<string, string> = {
    embeddingState_outdated: 'Veraltet',
    embeddingReason_outdated: 'Das konfigurierte Modell ist {0}. Die Suche verwendet {1}, bis der Vektorspeicher neu eingebettet ist.',
    reembedSkip_expired: 'Abgelaufen'
  };
  const pattern = texts[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)])) : pattern;
};

describe('embedding state wording', () => {
  it('words and colours the three states', () => {
    expect(['current', 'outdated', 'dimension_mismatch'].map((state) => embeddingStateText(state)))
      .toEqual(['Current', 'Outdated', 'Dimension mismatch']);
    expect(['current', 'outdated', 'dimension_mismatch'].map(embeddingStateColor)).toEqual(['Success', 'Warning', 'Error']);
  });
  it('shows an unknown state as is, a missing one as nothing', () => {
    expect(embeddingStateText('rebuilding')).toBe('rebuilding');
    expect(embeddingStateColor('rebuilding')).toBe('None');
    expect(embeddingStateText(undefined)).toBe('');
    expect(embeddingStateText('toString')).toBe('toString');
  });
  it('translates', () => { expect(embeddingStateText('outdated', DE)).toBe('Veraltet'); });
});

describe('embeddingReasonText', () => {
  it('says why for each state', () => {
    expect(embeddingReasonText('current', 'text-embedding-3-small', 'text-embedding-3-small'))
      .toBe('The vector store uses the configured embedding model.');
    expect(embeddingReasonText('outdated', 'text-embedding-3-small', 'text-embedding-3-large'))
      .toBe('The configured embedding model is text-embedding-3-large. Search keeps using text-embedding-3-small until the vector store is re-embedded.');
    expect(embeddingReasonText('dimension_mismatch', 'old-model', 'new-model'))
      .toBe('The configured embedding model uses another dimension. This vector store cannot be re-embedded in place; an operator has to migrate it.');
  });
  it('still explains an outdated store when the configured model could not be read', () => {
    expect(embeddingReasonText('outdated', 'text-embedding-3-small', ''))
      .toBe('The configured embedding model has changed. Search keeps using text-embedding-3-small until the vector store is re-embedded.');
  });
  it('is empty for an unknown or missing state', () => {
    expect(embeddingReasonText('rebuilding', 'm', 'n')).toBe('');
    expect(embeddingReasonText(undefined, 'm', 'n')).toBe('');
  });
  it('translates with the models as arguments', () => {
    expect(embeddingReasonText('outdated', 'a', 'b', DE)).toBe('Das konfigurierte Modell ist b. Die Suche verwendet a, bis der Vektorspeicher neu eingebettet ist.');
  });
});

describe('estimateFigures', () => {
  it('groups a store estimate and a bulk estimate with the locale', () => {
    expect(estimateFigures({ files: 1200, chunks: 34567, estimated_tokens: 8901234, state: 'outdated' }))
      .toEqual({ stores: '0', files: '1,200', chunks: '34,567', tokens: '8,901,234' });
    expect(estimateFigures({ stores: 3, files: 1200, chunks: 34567, estimated_tokens: '8901234', skipped: [] }, 'de-DE'))
      .toEqual({ stores: '3', files: '1.200', chunks: '34.567', tokens: '8.901.234' });
  });
  it('survives a missing estimate', () => {
    expect(estimateFigures(null)).toEqual({ stores: '0', files: '0', chunks: '0', tokens: '0' });
  });
});

describe('toSkippedRows', () => {
  const skipped = [
    { store_id: 'vs_a', owner_email: 'a@test.com', reason: 'dimension_mismatch' },
    { store_id: 'vs_b', owner_email: 'b@test.com', reason: 'expired' },
    { store_id: 'vs_c', owner_email: 'c@test.com', reason: 'reembed_running' },
    { store_id: 'vs_d', owner_email: 'd@test.com', reason: 'something_new' }
  ];
  it('names each skipped store with its reason in the cockpit\'s words', () => {
    expect(toSkippedRows(skipped)).toEqual([
      { storeId: 'vs_a', ownerEmail: 'a@test.com', reason: 'dimension_mismatch', reasonText: 'Another dimension: an operator has to migrate it' },
      { storeId: 'vs_b', ownerEmail: 'b@test.com', reason: 'expired', reasonText: 'Expired' },
      { storeId: 'vs_c', ownerEmail: 'c@test.com', reason: 'reembed_running', reasonText: 'A re-embed is already running' },
      { storeId: 'vs_d', ownerEmail: 'd@test.com', reason: 'something_new', reasonText: 'something_new' }
    ]);
  });
  it('translates and survives a missing list', () => {
    expect(toSkippedRows([skipped[1]], DE)[0].reasonText).toBe('Abgelaufen');
    expect(toSkippedRows(undefined as any)).toEqual([]);
  });
});

describe('lastFailedReembed', () => {
  const job = (id: string, kind: string, storeId: string | null, state: string) => ({ id, kind, store_id: storeId, state });
  it('names the store\'s newest re-embed job when it failed', () => {
    const jobs = [job('job_3', 'file_batch', 'vs_1', 'completed'), job('job_2', 'reembed_store', 'vs_1', 'failed'), job('job_1', 'reembed_store', 'vs_1', 'completed')];
    expect(lastFailedReembed(jobs, 'vs_1')).toBe('job_2');
  });
  it('is empty when the newest re-embed of the store did not fail, or there is none', () => {
    expect(lastFailedReembed([job('job_2', 'reembed_store', 'vs_1', 'cancelled'), job('job_1', 'reembed_store', 'vs_1', 'failed')], 'vs_1')).toBe('');
    expect(lastFailedReembed([job('job_1', 'reembed_store', 'vs_2', 'failed')], 'vs_1')).toBe('');
    expect(lastFailedReembed([job('job_1', 'reembed_bulk', null, 'failed')], 'vs_1')).toBe('');
    expect(lastFailedReembed([], 'vs_1')).toBe('');
    expect(lastFailedReembed(null as any, 'vs_1')).toBe('');
  });
});

describe('pollsStoreOnly', () => {
  it('a poll reads only the store while just a re-embed runs', () => {
    expect(pollsStoreOnly(true, { reembedding: true, inProgressFiles: 0 })).toBe(true);
  });
  it('reads everything on a load that is not the timed poll, while files are ingesting, and once the re-embed is over', () => {
    expect(pollsStoreOnly(false, { reembedding: true, inProgressFiles: 0 })).toBe(false);
    expect(pollsStoreOnly(true, { reembedding: true, inProgressFiles: 2 })).toBe(false);
    expect(pollsStoreOnly(true, { reembedding: false, inProgressFiles: 0 })).toBe(false);
  });
});
