/**
 * "Re-read files": the offer, the estimate's figures, the refusals in the cockpit's words, and the flow with a
 * stand-in host (the estimate and its vision price, what cannot start and why, the start and its refusal).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { reextractOffered, toReextractEstimate, reextractErrorText, reextractOutcome, REEXTRACT_EN_TEXTS } from '../webapp/model/reextract';
import { ReextractFlow, emptyReextract } from '../webapp/controller/reextractFlow';
import type { ChunkingHost } from '../webapp/controller/chunkingFlow';

const SETTING = { type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true };
const ESTIMATE = {
  store_id: 'vs_1', setting: SETTING, running_job_id: null, embedding_model: 'model-a', embedding_model_unavailable: false,
  files: 3, kept_files: 7, ocr_available: true, files_without_text: 1, current_chunks: 40, estimated_chunks: 1290,
  estimated_embedding_tokens: 120000, context_model: 'ctx-model', estimated_context_input_tokens: 2500000,
  estimated_context_output_tokens: 258000, vision_model: null, vision_files: 0, estimated_vision_pages: 0,
  estimated_vision_input_tokens: 0, estimated_vision_output_tokens: 0, vision_switched_off: false, vision_unmasked_warning: false,
  retry_files: 2
};
const ok = (body: any) => ({ ok: true, status: 200, body, error: null });
const refused = (status: number, code: string) => ({ ok: false, status, body: null, error: { status, code, message: `server: ${code}` } });

describe('reextractOffered', () => {
  it('offers the action for files to read again or failed files to queue again, and not otherwise', () => {
    expect(reextractOffered(ESTIMATE)).toBe(true);
    expect(reextractOffered({ files: 0, retry_files: 1 })).toBe(true);
    expect(reextractOffered({ files: 1, retry_files: 0 })).toBe(true);
    expect(reextractOffered({ files: 0, retry_files: 0, kept_files: 9 })).toBe(false);
    expect(reextractOffered(null)).toBe(false);
    expect(reextractOffered({ files: '2' })).toBe(true);
    expect(reextractOffered({ files: -1, retry_files: 'x' })).toBe(false);
  });
});

describe('toReextractEstimate', () => {
  it('groups the figures for the locale and names the setting', () => {
    const e = toReextractEstimate(ESTIMATE, 'de-DE');
    expect(e).toMatchObject({
      setting: 'Structure (800/0), contextual', files: '3', keptFiles: '7', filesWithoutText: '1', hasFilesWithoutText: true,
      ocrAvailable: true, retryFiles: '2', hasRetryFiles: true, reads: true, currentChunks: '40', chunks: '1.290',
      embeddingTokens: '120.000', contextual: true, contextModel: 'ctx-model', contextInputTokens: '2.500.000',
      contextOutputTokens: '258.000', vision: false, visionModel: '', running: false, modelUnavailable: false, canStart: true
    });
  });
  it('shows the vision rows for a setting with a vision mode, and the unmasked warning', () => {
    const e = toReextractEstimate({
      ...ESTIMATE, setting: { ...SETTING, vision: 'no_text' }, vision_model: 'vision-model', vision_files: 3,
      estimated_vision_pages: 150, estimated_vision_input_tokens: 187500, estimated_vision_output_tokens: 614400,
      vision_unmasked_warning: true
    });
    expect(e).toMatchObject({
      vision: true, visionModel: 'vision-model', visionFiles: '3', visionPages: '150', visionInputTokens: '187,500',
      visionOutputTokens: '614,400', visionUnmasked: true, setting: 'Structure (800/0), contextual; vision: Pages without text'
    });
  });
  it('cannot start while a job runs or with an invalid setting; failed files alone start whatever runs', () => {
    expect(toReextractEstimate({ ...ESTIMATE, running_job_id: 'job_r' })).toMatchObject({ running: true, canStart: false });
    expect(toReextractEstimate({ ...ESTIMATE, setting: null })).toMatchObject({ setting: '', canStart: false });
    expect(toReextractEstimate({ ...ESTIMATE, files: 0, running_job_id: 'job_r' }))
      .toMatchObject({ reads: false, running: false, contextual: false, canStart: true });
    expect(toReextractEstimate({ ...ESTIMATE, files: 0, retry_files: 0 })).toMatchObject({ canStart: false });
    expect(toReextractEstimate(null)).toMatchObject({ files: '0', reads: false, canStart: false });
  });
  it('warns about a store model already found not served', () => {
    expect(toReextractEstimate({ ...ESTIMATE, embedding_model_unavailable: true }).modelUnavailable).toBe(true);
  });
});

describe('reextractOutcome', () => {
  const refused = (n: number) => Array.from({ length: n }, (_v, i) => ({ file_id: `f${i}`, error: 'job_running' }));
  it('says what a start did: a job, failed files queued, or every failed file refused by the retry', () => {
    expect(reextractOutcome({ job: { id: 'job_x' }, retried_files: 0, refused_files: [] })).toEqual({ key: 'reextractStarted', refused: false });
    expect(reextractOutcome({ job: null, retried_files: 2, refused_files: [] })).toEqual({ key: 'reextractQueued', refused: false });
    expect(reextractOutcome({ job: null, retried_files: 0, refused_files: refused(1) })).toEqual({ key: 'reextractRetryRefused', refused: true });
  });
  it('names the failed files the retry refused while their batch is still read, beside a started job or queued files', () => {
    expect(reextractOutcome({ job: { id: 'job_x' }, retried_files: 0, refused_files: refused(2) }))
      .toEqual({ key: 'reextractStartedRetryRefused', args: [2], refused: true });
    expect(reextractOutcome({ job: { id: 'job_x' }, retried_files: 1, refused_files: refused(3) }))
      .toEqual({ key: 'reextractStartedRetryRefused', args: [3], refused: true });
    expect(reextractOutcome({ job: null, retried_files: 1, refused_files: refused(3) }))
      .toEqual({ key: 'reextractQueuedRetryRefused', args: [1, 3], refused: true });
    expect(reextractOutcome({ job: { id: 'job_x' } })).toEqual({ key: 'reextractStarted', refused: false });
  });
});

describe('reextractErrorText', () => {
  it('words the refusals of a start, and leaves others to errorMessage', () => {
    expect(reextractErrorText({ status: 409, code: 'nothing_to_reextract', message: '' })).toBe(REEXTRACT_EN_TEXTS.reextractNothing);
    expect(reextractErrorText({ status: 409, code: 'store_chunking_invalid', message: '' })).toBe(REEXTRACT_EN_TEXTS.reextractErrSettingInvalid);
    expect(reextractErrorText({ status: 409, code: 'reembed_running', message: '' })).toBe(REEXTRACT_EN_TEXTS.chunkingErrRunning);
    expect(reextractErrorText({ status: 409, code: 'vision_model_unavailable', message: '' })).toBe(REEXTRACT_EN_TEXTS.reextractErrVisionModelUnavailable);
    expect(reextractErrorText({ status: 409, code: 'context_model_unavailable', message: '' })).toBe(REEXTRACT_EN_TEXTS.chunkingErrContextModelUnavailable);
    expect(reextractErrorText({ status: 409, code: 'store_model_unavailable', message: '' })).toBe(REEXTRACT_EN_TEXTS.chunkingErrModelUnavailable);
    expect(reextractErrorText({ status: 409, code: 'constructor', message: 'server text' })).not.toBe('constructor');
    expect(reextractErrorText({ status: 429, code: 'quota_exceeded', message: 'server text' })).toMatch(/^Your usage quota is used up\./);
    expect(reextractErrorText({ status: 429, code: 'quota_exceeded', message: 'server text', resetsAt: '2026-10-14T00:00:00.000Z' }, (key, args) => `${key}:${args}`, 'de-DE')).toBe('errQuotaExceededResetsAt:14.10.2026, 00:00');
  });
  it('keeps its English defaults byte-identical to the bundle', () => {
    const bundle = readFileSync(join(__dirname, '..', 'webapp', 'i18n', 'i18n.properties'), 'utf8');
    for (const [key, value] of Object.entries(REEXTRACT_EN_TEXTS)) expect(bundle).toContain(`\n${key}=${value}\n`);
  });
});

function setup(admin = false) {
  const data: any = { reextract: emptyReextract() };
  const api = {
    reextractEstimate: jest.fn(async () => ok(ESTIMATE) as any),
    startReextract: jest.fn(async () => ok({ job: { id: 'job_x', reextract: true }, retried_files: 2 }) as any),
    adminReextractEstimate: jest.fn(async () => ok(ESTIMATE) as any),
    adminStartReextract: jest.fn(async () => ok({ job: { id: 'job_a', reextract: true }, retried_files: 0 }) as any),
    modelCost: jest.fn(async () => ok({ priced: true, capacity_units: 3.2, cost: 0.12, currency: 'USD' }) as any)
  };
  const host: ChunkingHost = {
    getProperty: (path) => path.split('/').filter(Boolean).reduce((o: any, k) => (o == null ? undefined : o[k]), data),
    setProperty: (path, value) => {
      const keys = path.split('/').filter(Boolean);
      const last = keys.pop()!;
      keys.reduce((o: any, k) => (o[k] ??= {}), data)[last] = value;
    },
    api: async () => api as any,
    translator: async () => (key: string, args?: (string | number)[]) => `${key}${args ? `(${args.join('|')})` : ''}`,
    locale: () => 'en-US'
  };
  return { flow: new ReextractFlow(host, admin), api, data };
}

describe('ReextractFlow', () => {
  it('admin: estimates and starts any owner\'s store through the admin routes only', async () => {
    const { flow, api, data } = setup(true);
    await flow.prepare({ id: 'vs_9', name: 'Their docs' });
    expect(api.adminReextractEstimate).toHaveBeenCalledWith('vs_9');
    expect(data.reextract.estimate).toMatchObject({ files: '3', canStart: true });
    expect(await flow.start()).toEqual({ job: { id: 'job_a', reextract: true }, retried_files: 0 });
    expect(api.adminStartReextract).toHaveBeenCalledWith('vs_9');
    expect(api.reextractEstimate).not.toHaveBeenCalled();
    expect(api.startReextract).not.toHaveBeenCalled();
  });

  it('offered: from the estimate; a failed estimate offers nothing', async () => {
    const { flow, api } = setup();
    expect(await flow.offered('vs_1')).toBe(true);
    expect(api.reextractEstimate).toHaveBeenCalledWith('vs_1');
    api.reextractEstimate.mockResolvedValueOnce(ok({ ...ESTIMATE, files: 0, retry_files: 0 }));
    expect(await flow.offered('vs_1')).toBe(false);
    api.reextractEstimate.mockResolvedValueOnce(refused(404, 'vector_store_not_found'));
    expect(await flow.offered('vs_1')).toBe(false);
    expect(await flow.offered('')).toBe(false);
  });

  it('prepare shows the estimate; no price lookup without vision; start sends it and answers the job', async () => {
    const { flow, api, data } = setup();
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    expect(data.reextract).toMatchObject({ storeId: 'vs_1', storeName: 'Docs', busy: false, message: '' });
    expect(data.reextract.estimate).toMatchObject({ files: '3', canStart: true });
    expect(api.modelCost).not.toHaveBeenCalled();
    expect(await flow.start()).toEqual({ job: { id: 'job_x', reextract: true }, retried_files: 2 });
    expect(api.startReextract).toHaveBeenCalledWith('vs_1');
  });

  it('prices the vision rows "up to", or says the price is unknown', async () => {
    const { flow, api, data } = setup();
    const vision = { ...ESTIMATE, setting: { ...SETTING, vision: 'all' }, vision_model: 'vm', estimated_vision_input_tokens: 1000, estimated_vision_output_tokens: 50 };
    api.reextractEstimate.mockResolvedValue(ok(vision));
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    expect(api.modelCost).toHaveBeenCalledWith('vm', 1000, 50);
    expect(data.reextract.estimate.visionCost).toBe('chunkingEstimateVisionCostValue($0.12)');
    api.modelCost.mockResolvedValueOnce(refused(500, 'x'));
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    expect(data.reextract.estimate.visionCost).toBe('chunkingEstimateVisionCostUnknown(vm)');
  });

  it('no vision tokens costs zero in the currency a price answer named, else a bare 0', async () => {
    const { flow, api, data } = setup();
    const base = { ...ESTIMATE, setting: { ...SETTING, vision: 'all' }, vision_model: 'vm' };
    api.reextractEstimate.mockResolvedValue(ok({ ...base, estimated_vision_input_tokens: 0, estimated_vision_output_tokens: 0 }));
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    expect(data.reextract.estimate.visionCost).toBe('chunkingEstimateVisionCostValue(0)');
    api.reextractEstimate.mockResolvedValueOnce(ok({ ...base, estimated_vision_input_tokens: 1000, estimated_vision_output_tokens: 50 }));
    api.modelCost.mockResolvedValueOnce(ok({ priced: true, capacity_units: 3.2, cost: 0.12, currency: 'EUR' }));
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    expect(data.reextract.estimate.visionCost).toBe('chunkingEstimateVisionCostValue(\u20ac0.00)');
  });

  it('explains a running job, failed files alone and nothing to read; starts nothing it cannot', async () => {
    const { flow, api, data } = setup();
    api.reextractEstimate.mockResolvedValueOnce(ok({ ...ESTIMATE, running_job_id: 'job_r' }));
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    expect(data.reextract).toMatchObject({ message: 'chunkingErrRunning', messageType: 'Error' });
    expect(await flow.start()).toBeNull();
    expect(api.startReextract).not.toHaveBeenCalled();

    api.reextractEstimate.mockResolvedValueOnce(ok({ ...ESTIMATE, files: 0 }));
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    expect(data.reextract).toMatchObject({ message: 'reextractRetryOnly(2)', messageType: 'Information' });
    expect(data.reextract.estimate.canStart).toBe(true);

    api.reextractEstimate.mockResolvedValueOnce(ok({ ...ESTIMATE, files: 0, retry_files: 0 }));
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    expect(data.reextract).toMatchObject({ message: 'reextractNothing', messageType: 'Information' });
  });

  it('a refused estimate or start is shown; a refused start drops the estimate', async () => {
    const { flow, api, data } = setup();
    api.reextractEstimate.mockResolvedValueOnce(refused(404, 'vector_store_not_found'));
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    expect(data.reextract.estimate).toBeNull();
    expect(data.reextract.messageType).toBe('Error');

    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    api.startReextract.mockResolvedValueOnce(refused(409, 'context_model_unavailable'));
    expect(await flow.start()).toBeNull();
    expect(data.reextract).toMatchObject({ estimate: null, message: 'chunkingErrContextModelUnavailable', messageType: 'Error', busy: false });
  });

  it('drops an estimate that answers after a newer dialog opened', async () => {
    const { flow, api, data } = setup();
    let release: (v: any) => void = () => {};
    api.reextractEstimate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = flow.prepare({ id: 'vs_old', name: 'Old' });
    await flow.prepare({ id: 'vs_1', name: 'Docs' });
    release(ok({ ...ESTIMATE, files: 99 }));
    await first;
    expect(data.reextract).toMatchObject({ storeId: 'vs_1' });
    expect(data.reextract.estimate.files).toBe('3');
  });
});
