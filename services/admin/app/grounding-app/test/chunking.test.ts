/**
 * A store's chunking setting in the cockpit's words: the summary (null is static 800/400), the dialog's input
 * rules (the gateway's ranges), the installation default, the estimate's figures and the re-chunk refusals.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CHUNKING_EN_TEXTS, chunkingText, defaultChunking, effectiveChunking, formToSetting, isChunkingSetting, toChunkingForm,
  toChunkingEstimate, chunkingErrorText, sameChunking, LEGACY_CHUNKING, overlapLimit, visionOf, visionCostText, VISION_MODES
} from '../webapp/model/chunking';
import { toStoreRow, rechunkable } from '../webapp/model/rows';
import { toAdminStoreRow } from '../webapp/model/admin';

const STRUCTURE = { type: 'structure' as const, max_tokens: 800, overlap_tokens: 0, contextual: true };

describe('chunkingText', () => {
  it('names the strategy with max and overlap tokens, and contextual', () => {
    expect(chunkingText({ type: 'static', max_tokens: 400, overlap_tokens: 100, contextual: false })).toBe('Static (400/100)');
    expect(chunkingText(STRUCTURE)).toBe('Structure (800/0), contextual');
    expect(chunkingText({ ...STRUCTURE, contextual: false })).toBe('Structure (800/0)');
  });
  it('shows a store from before the setting (null) and an unreadable one as static 800/400', () => {
    expect(chunkingText(null)).toBe('Static (800/400)');
    expect(chunkingText(undefined)).toBe('Static (800/400)');
    expect(chunkingText({ type: 'semantic', max_tokens: 800, overlap_tokens: 0, contextual: false })).toBe('Static (800/400)');
  });
  it('translates', () => {
    const t = (key: string, args?: (string | number)[]) => (key === 'chunkingType_structure' ? 'Struktur' : key === 'chunkingSummaryContextual' ? `${args![0]} (${args![1]}/${args![2]}), kontextbezogen` : key);
    expect(chunkingText(STRUCTURE, t)).toBe('Struktur (800/0), kontextbezogen');
  });
});

describe('the setting rules', () => {
  it('follows the gateway: max 100-4096, overlap at most half of max, contextual only with structure', () => {
    expect(isChunkingSetting(STRUCTURE)).toBe(true);
    expect(isChunkingSetting({ ...STRUCTURE, max_tokens: 99 })).toBe(false);
    expect(isChunkingSetting({ ...STRUCTURE, max_tokens: 4097 })).toBe(false);
    expect(isChunkingSetting({ ...STRUCTURE, overlap_tokens: 401 })).toBe(false);
    expect(isChunkingSetting({ ...STRUCTURE, overlap_tokens: 400 })).toBe(true);
    expect(isChunkingSetting({ ...STRUCTURE, type: 'static' })).toBe(false);
    expect(isChunkingSetting({ ...STRUCTURE, max_tokens: 800.5 })).toBe(false);
    expect(isChunkingSetting(null)).toBe(false);
  });
  it('compares two settings field by field', () => {
    expect(sameChunking(effectiveChunking(null), { ...LEGACY_CHUNKING })).toBe(true);
    expect(sameChunking(STRUCTURE, { ...STRUCTURE, contextual: false })).toBe(false);
  });
});

describe('defaultChunking', () => {
  it('takes the installation default the status names', () => {
    expect(defaultChunking({ available: true, chunking: STRUCTURE })).toEqual(STRUCTURE);
  });
  it('is static 800/400 when the gateway names none or an invalid one, or the status could not be read', () => {
    expect(defaultChunking({ available: true })).toEqual(LEGACY_CHUNKING);
    expect(defaultChunking({ chunking: { type: 'static', max_tokens: 50, overlap_tokens: 0, contextual: false } })).toEqual(LEGACY_CHUNKING);
    expect(defaultChunking(null)).toEqual(LEGACY_CHUNKING);
  });
});

describe('formToSetting', () => {
  const form = (over: any = {}) => ({ ...toChunkingForm(STRUCTURE), ...over });
  it('starts the fields from a setting, null as static 800/400', () => {
    expect(toChunkingForm(null)).toEqual({ type: 'static', maxTokens: 800, overlapTokens: 400, contextual: false, vision: 'off' });
    expect(toChunkingForm(STRUCTURE)).toEqual({ type: 'structure', maxTokens: 800, overlapTokens: 0, contextual: true, vision: 'off' });
  });
  it('accepts the fields as numbers or as typed text', () => {
    expect(formToSetting(form())).toEqual({ ok: true, setting: STRUCTURE });
    expect(formToSetting(form({ maxTokens: ' 1200 ', overlapTokens: '600', contextual: false }))).toEqual({
      ok: true, setting: { type: 'structure', max_tokens: 1200, overlap_tokens: 600, contextual: false }
    });
  });
  it('refuses max tokens outside 100-4096 or not whole', () => {
    for (const maxTokens of [99, 4097, '', 'abc', '800.5', -1]) {
      expect(formToSetting(form({ maxTokens }))).toEqual({ ok: false, problem: 'max', message: 'Max tokens must be a whole number from 100 to 4096.' });
    }
    expect(formToSetting(form({ maxTokens: 100 })).ok).toBe(true);
    expect(formToSetting(form({ maxTokens: 4096 })).ok).toBe(true);
  });
  it('refuses an overlap above half of max, naming the bound', () => {
    expect(formToSetting(form({ maxTokens: 801, overlapTokens: 401 }))).toEqual({
      ok: false, problem: 'overlap', message: 'Overlap tokens must be a whole number from 0 to half of the max tokens (400).'
    });
    expect(formToSetting(form({ maxTokens: 801, overlapTokens: 400 })).ok).toBe(true);
    expect(formToSetting(form({ overlapTokens: '' })).ok).toBe(false);
  });
  it('refuses contextual with the static strategy', () => {
    expect(formToSetting(form({ type: 'static', overlapTokens: 400 }))).toEqual({
      ok: false, problem: 'contextual', message: 'Contextual chunks need the Structure strategy.'
    });
  });
});

describe('overlapLimit', () => {
  it('is half of a valid max, rounded down, and half of the largest max otherwise', () => {
    expect(overlapLimit(800)).toBe(400);
    expect(overlapLimit('801')).toBe(400);
    expect(overlapLimit(100)).toBe(50);
    expect(overlapLimit(99)).toBe(2048);
    expect(overlapLimit('')).toBe(2048);
  });
});

describe('toChunkingEstimate', () => {
  const ESTIMATE = {
    store_id: 'vs_1', current: { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false }, target: STRUCTURE,
    unchanged: false, running_job_id: null, embedding_model: 'text-embedding-3-small', files: 12, current_chunks: 97,
    estimated_chunks: 160, estimated_embedding_tokens: 120000, context_model: 'gemini-3.5-flash-lite',
    estimated_context_input_tokens: 2100000, estimated_context_output_tokens: 32000, embedding_model_unavailable: false
  };
  it('groups the figures and offers the start', () => {
    expect(toChunkingEstimate(ESTIMATE)).toEqual({
      files: '12', currentChunks: '97', chunks: '160', embeddingTokens: '120,000', contextual: true, contextModel: 'gemini-3.5-flash-lite',
      contextInputTokens: '2,100,000', contextOutputTokens: '32,000', modelUnavailable: false, unchanged: false, missingContexts: '0', fillsContexts: false, running: false, canStart: true,
      vision: false, visionModel: '', visionFiles: '0', visionPages: '0', visionInputTokens: '0', visionOutputTokens: '0', visionCost: '', visionUnmasked: false
    });
    expect(toChunkingEstimate(ESTIMATE, 'de-DE').contextInputTokens).toBe('2.100.000');
  });
  it('has no context figures for a target without context', () => {
    expect(toChunkingEstimate({ ...ESTIMATE, target: { ...STRUCTURE, contextual: false }, context_model: null, estimated_context_input_tokens: 0 }))
      .toMatchObject({ contextual: false, contextModel: '', contextInputTokens: '0' });
  });
  it('flags the unavailable model, and offers no start when unchanged or while a job runs', () => {
    expect(toChunkingEstimate({ ...ESTIMATE, embedding_model_unavailable: true })).toMatchObject({ modelUnavailable: true, canStart: true });
    expect(toChunkingEstimate({ ...ESTIMATE, unchanged: true })).toMatchObject({ unchanged: true, canStart: false });
    expect(toChunkingEstimate({ ...ESTIMATE, running_job_id: 'job_r' })).toMatchObject({ running: true, canStart: false });
  });
  it('offers the start for the store\'s own contextual setting while chunks lack their context', () => {
    expect(toChunkingEstimate({ ...ESTIMATE, unchanged: true, chunks_without_context: 1234 }))
      .toMatchObject({ unchanged: true, fillsContexts: true, missingContexts: '1,234', canStart: true });
    expect(toChunkingEstimate({ ...ESTIMATE, unchanged: true, chunks_without_context: 3, running_job_id: 'job_r' }))
      .toMatchObject({ fillsContexts: true, canStart: false });
    expect(toChunkingEstimate({ ...ESTIMATE, unchanged: true, chunks_without_context: 0 })).toMatchObject({ fillsContexts: false, canStart: false });
    // a target without context never fills contexts, and a changed setting is a plain re-chunk
    expect(toChunkingEstimate({ ...ESTIMATE, target: { ...STRUCTURE, contextual: false }, unchanged: true, chunks_without_context: 3 }))
      .toMatchObject({ fillsContexts: false, canStart: false });
    expect(toChunkingEstimate({ ...ESTIMATE, chunks_without_context: 3 })).toMatchObject({ fillsContexts: false, canStart: true });
  });
  it('survives an empty answer', () => {
    expect(toChunkingEstimate(null)).toMatchObject({ files: '0', chunks: '0', canStart: true, contextual: false });
  });
});

describe('chunkingErrorText', () => {
  const error = (code: string, message = 'server text') => ({ status: 409, code, message });
  it('words the re-chunk refusals', () => {
    expect(chunkingErrorText(error('reembed_running'))).toBe('A re-embed or re-chunk of this vector store is already running. Wait for it to finish or cancel it first.');
    expect(chunkingErrorText(error('store_model_unavailable'))).toMatch(/^The embedding model of this vector store is no longer available/);
    expect(chunkingErrorText(error('chunking_current'))).toBe('The vector store already uses this chunking setting.');
  });
  it('words any other refusal as every other request does, and keeps an unknown one as sent', () => {
    expect(chunkingErrorText(error('store_expired'))).toBe('The vector store has expired; it can no longer be retried or re-embedded.');
    expect(chunkingErrorText(error('invalid_value', "Invalid 'chunking.max_tokens'"))).toBe("Invalid 'chunking.max_tokens'");
    // the store owner over quota: the re-chunk start's refusal in the dialog
    expect(chunkingErrorText({ status: 429, code: 'quota_exceeded', message: 'server text' })).toMatch(/^Your usage quota is used up\./);
    expect(chunkingErrorText({ status: 429, code: 'quota_exceeded', message: 'server text', resetsAt: '2026-10-14T00:00:00.000Z' }, (key, args) => `${key}:${args}`, 'de-DE')).toBe('errQuotaExceededResetsAt:14.10.2026, 00:00');
  });
  it('uses the injected bundle', () => {
    expect(chunkingErrorText(error('reembed_running'), (key) => `#${key}`)).toBe('#chunkingErrRunning');
  });
});

describe('store rows', () => {
  const store = (over: any = {}) => ({ id: 'vs_1', name: 'Docs', status: 'completed', file_counts: {}, embedding_state: 'current', chunking: STRUCTURE, ...over });
  it('carry the setting and its summary; null is a store from before the setting', () => {
    expect(toStoreRow(store())).toMatchObject({ chunking: STRUCTURE, chunkingText: 'Structure (800/0), contextual', canChangeChunking: true });
    expect(toStoreRow(store({ chunking: null }))).toMatchObject({ chunking: null, chunkingText: 'Static (800/400)', canChangeChunking: true });
  });
  it('offer Change Chunking to the owner of a store that has not expired, has its dimension and no job running', () => {
    expect(toStoreRow(store({ owned: false })).canChangeChunking).toBe(false);
    expect(toStoreRow(store({ status: 'expired' })).canChangeChunking).toBe(false);
    expect(toStoreRow(store({ reembed_job_id: 'job_1' })).canChangeChunking).toBe(false);
    expect(toStoreRow(store({ embedding_state: 'dimension_mismatch' })).canChangeChunking).toBe(false);
    expect(toStoreRow(store({ embedding_state: 'outdated' })).canChangeChunking).toBe(true);
    expect(rechunkable('current', 'in_progress', '')).toBe(true);
  });
  it('offer it to an admin for any owner\'s store', () => {
    expect(toAdminStoreRow(store({ owned: false, owner_email: 'ada@example.test' })).canChangeChunking).toBe(true);
    expect(toAdminStoreRow(store({ owned: false, status: 'expired' })).canChangeChunking).toBe(false);
  });
});

describe('English defaults', () => {
  it('are byte-identical to the default bundle', () => {
    const bundle: Record<string, string> = {};
    for (const line of readFileSync(join(__dirname, '..', 'webapp', 'i18n', 'i18n.properties'), 'utf8').split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const at = line.indexOf('=');
      bundle[line.slice(0, at)] = line.slice(at + 1);
    }
    for (const [key, value] of Object.entries(CHUNKING_EN_TEXTS)) expect([key, bundle[key]]).toEqual([key, value]);
    expect(bundle.jobKind_rechunk).toBe('Re-chunk');
  });
});

describe('vision (W3)', () => {
  const VISION = { ...STRUCTURE, vision: 'auto' as const };
  const ESTIMATE = { store_id: 'vs_1', unchanged: false, running_job_id: null, files: 4 };

  it('a setting with a mode is valid; off is left out as the gateway answers it; an unknown mode is static 800/400', () => {
    expect(isChunkingSetting(VISION)).toBe(true);
    expect(effectiveChunking(VISION)).toEqual(VISION);
    expect(effectiveChunking({ ...STRUCTURE, vision: 'off' })).toEqual(STRUCTURE);
    expect(isChunkingSetting({ ...STRUCTURE, vision: 'sometimes' })).toBe(false);
    expect(visionOf(null)).toBe('off');
    expect(visionOf(VISION)).toBe('auto');
    expect(VISION_MODES).toEqual(['off', 'no_text', 'auto', 'all']);
  });

  it('a size edit keeps the mode: the form round-trips it, and another mode is not the same setting', () => {
    const form = toChunkingForm(VISION);
    expect(form.vision).toBe('auto');
    expect(formToSetting({ ...form, maxTokens: 600 })).toEqual({ ok: true, setting: { ...VISION, max_tokens: 600 } });
    expect(formToSetting({ ...form, vision: 'off' })).toEqual({ ok: true, setting: STRUCTURE });
    expect(formToSetting({ ...form, vision: 'bogus' })).toEqual({ ok: true, setting: STRUCTURE });
    expect(formToSetting({ ...toChunkingForm(LEGACY_CHUNKING), vision: 'all' })).toMatchObject({ ok: true, setting: { type: 'static', vision: 'all' } });
    expect(sameChunking(VISION, VISION)).toBe(true);
    expect(sameChunking(VISION, STRUCTURE)).toBe(false);
    expect(sameChunking({ ...STRUCTURE, vision: 'off' }, STRUCTURE)).toBe(true);
  });

  it('the summary names the mode', () => {
    expect(chunkingText(VISION)).toBe('Structure (800/0), contextual; vision: Pages without or with little text, and table pages');
    expect(chunkingText({ ...LEGACY_CHUNKING, vision: 'no_text' })).toBe('Static (800/400); vision: Pages without text');
    expect(chunkingText(STRUCTURE)).toBe('Structure (800/0), contextual');
  });

  it('the estimate\'s vision rows and the unmasked flag, only for a target with a mode', () => {
    const body = {
      ...ESTIMATE, target: VISION, vision_model: 'gemini-3.5-flash-lite', vision_files: 4, estimated_vision_pages: 120,
      estimated_vision_input_tokens: 150000, estimated_vision_output_tokens: 491520, vision_unmasked_warning: true
    };
    expect(toChunkingEstimate(body)).toMatchObject({
      vision: true, visionModel: 'gemini-3.5-flash-lite', visionFiles: '4', visionPages: '120', visionInputTokens: '150,000',
      visionOutputTokens: '491,520', visionCost: '', visionUnmasked: true
    });
    expect(toChunkingEstimate({ ...body, target: STRUCTURE })).toMatchObject({ vision: false, visionModel: '', visionUnmasked: false });
  });

  it('the cost: up to the money figure, else up to the capacity units, else unknown', () => {
    expect(visionCostText({ priced: true, capacity_units: 2.5, cost: 0.0425, currency: 'USD' })).toBe('up to $0.0425');
    expect(visionCostText({ priced: true, capacity_units: 2.5, cost: 1.5, currency: 'EUR' }, 'de-DE')).toBe('up to 1,50 €');
    expect(visionCostText({ priced: true, capacity_units: 2.5, cost: null, currency: null })).toBe('up to 2.5 capacity units');
    expect(visionCostText({ priced: false, capacity_units: null, cost: null, currency: null }, 'en-US', undefined, 'gemini-x'))
      .toBe('Unknown: the vision model gemini-x has no price. Add a price for gemini-x in the Model Library.');
    expect(visionCostText(null, 'en-US', undefined, 'gemini-x'))
      .toBe('Unknown: the vision model gemini-x has no price. Add a price for gemini-x in the Model Library.');
  });

  it('the refusal of a start with a mode is worded', () => {
    expect(chunkingErrorText({ status: 409, code: 'vision_model_unavailable', message: 'x' })).toMatch(/^Vision transcription is not available/);
  });
});
