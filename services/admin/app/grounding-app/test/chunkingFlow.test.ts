/**
 * The chunking dialogs' logic with a stand-in host: the create defaults, the change dialog's fields, the estimate
 * (labelled figures, unchanged, running, model unavailable), the refusals, a stale estimate dropped after a field
 * change, the start through the owner's or the admin routes, and a running re-chunk's target.
 */
import { ChunkingFlow, emptyChunking, ChunkingHost } from '../webapp/controller/chunkingFlow';

const STRUCTURE = { type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true };
const ESTIMATE = {
  store_id: 'vs_1', current: null, target: STRUCTURE, unchanged: false, running_job_id: null, files: 3, current_chunks: 9,
  estimated_chunks: 12, estimated_embedding_tokens: 9000, context_model: 'model-a', estimated_context_input_tokens: 50000,
  estimated_context_output_tokens: 1200, embedding_model_unavailable: false
};
const ok = (body: any) => ({ ok: true, status: 200, body, error: null });
const refused = (status: number, code: string) => ({ ok: false, status, body: null, error: { status, code, message: `server: ${code}` } });

function setup(options: { admin?: boolean; noApi?: boolean } = {}) {
  const data: any = { chunking: emptyChunking() };
  const api = {
    status: jest.fn(async () => ok({ available: true, chunking: STRUCTURE }) as any),
    chunkingEstimate: jest.fn(async () => ok(ESTIMATE) as any),
    adminChunkingEstimate: jest.fn(async () => ok(ESTIMATE) as any),
    startChunking: jest.fn(async () => ok({ id: 'job_r', kind: 'reembed_store', target_chunking: STRUCTURE }) as any),
    adminStartChunking: jest.fn(async () => ok({ id: 'job_r' }) as any),
    getJob: jest.fn(async () => ok({ id: 'job_r', kind: 'reembed_store', target_chunking: STRUCTURE }) as any),
    modelCost: jest.fn(async () => ok({ priced: true, capacity_units: 3.2, cost: 0.12, currency: 'USD' }) as any)
  };
  const host: ChunkingHost = {
    getProperty: (path) => path.split('/').filter(Boolean).reduce((o: any, k) => (o == null ? undefined : o[k]), data),
    setProperty: (path, value) => {
      const keys = path.split('/').filter(Boolean);
      const last = keys.pop()!;
      keys.reduce((o: any, k) => (o[k] ??= {}), data)[last] = value;
    },
    api: async () => (options.noApi ? null : api as any),
    translator: async () => (key: string, args?: (string | number)[]) => `${key}${args ? `(${args.join('|')})` : ''}`,
    locale: () => 'en-US'
  };
  return { flow: new ChunkingFlow(host, options.admin), api, data };
}

const STORE = { id: 'vs_1', name: 'Docs', chunking: null };

describe('the create dialog', () => {
  it('starts the fields from the installation default', async () => {
    const { flow, data } = setup();
    await flow.prepareCreate();
    expect(data.chunking.form).toEqual({ type: 'structure', maxTokens: 800, overlapTokens: 0, contextual: true, vision: 'off' });
    expect(await flow.setting()).toEqual(STRUCTURE);
  });
  it('starts from static 800/400 when the status names no default or cannot be read', async () => {
    const old = setup();
    old.api.status.mockResolvedValue(ok({ available: true }));
    await old.flow.prepareCreate();
    expect(old.data.chunking.form).toEqual({ type: 'static', maxTokens: 800, overlapTokens: 400, contextual: false, vision: 'off' });

    const failed = setup();
    failed.api.status.mockResolvedValue(refused(502, 'gateway_unreachable'));
    await failed.flow.prepareCreate();
    expect(failed.data.chunking.form.type).toBe('static');
  });
  it('shows a problem instead of answering a setting', async () => {
    const { flow, data } = setup();
    await flow.prepareCreate();
    data.chunking.form.maxTokens = 50;
    expect(await flow.setting()).toBeNull();
    expect(data.chunking).toMatchObject({ message: 'chunkingProblem_max', messageType: 'Error' });
  });
  it('turns contextual off when the strategy becomes Static', async () => {
    const { flow, data } = setup();
    await flow.prepareCreate();
    data.chunking.form.type = 'static';
    flow.changed();
    expect(data.chunking.form.contextual).toBe(false);
  });
});

describe('the change dialog', () => {
  it('starts from the store\'s setting and names it', async () => {
    const { flow, data } = setup();
    await flow.prepareChange({ id: 'vs_1', name: 'Docs', ownerEmail: 'ada@example.test', chunking: STRUCTURE as any });
    expect(data.chunking).toMatchObject({
      storeId: 'vs_1', storeName: 'Docs', ownerEmail: 'ada@example.test', current: 'chunkingSummaryContextual(chunkingType_structure|800|0)',
      form: { type: 'structure', maxTokens: 800, overlapTokens: 0, contextual: true }, estimate: null
    });
    await flow.prepareChange(STORE);
    expect(data.chunking).toMatchObject({ current: 'chunkingSummary(chunkingType_static|800|400)', ownerEmail: '', form: { type: 'static' } });
  });

  it('reads the estimate for the fields and offers the start', async () => {
    const { flow, api, data } = setup();
    await flow.prepareChange(STORE);
    Object.assign(data.chunking.form, { type: 'structure', overlapTokens: 0, contextual: true });
    await flow.estimate();
    expect(api.chunkingEstimate).toHaveBeenCalledWith('vs_1', STRUCTURE);
    expect(data.chunking).toMatchObject({ busy: false, message: '', estimate: { files: '3', chunks: '12', embeddingTokens: '9,000', contextual: true, contextInputTokens: '50,000', canStart: true } });
  });

  it('does not ask for an estimate while the fields have a problem', async () => {
    const { flow, api, data } = setup();
    await flow.prepareChange(STORE);
    data.chunking.form.overlapTokens = 401;
    await flow.estimate();
    expect(api.chunkingEstimate).not.toHaveBeenCalled();
    expect(data.chunking).toMatchObject({ message: 'chunkingProblem_overlap(400)', messageType: 'Error', estimate: null });
  });

  it('explains an unchanged setting and a running job instead of offering the start', async () => {
    const same = setup();
    same.api.chunkingEstimate.mockResolvedValue(ok({ ...ESTIMATE, unchanged: true }));
    await same.flow.prepareChange(STORE);
    await same.flow.estimate();
    expect(same.data.chunking).toMatchObject({ message: 'chunkingUnchanged', messageType: 'Information', estimate: { canStart: false } });
    expect(await same.flow.start()).toBeNull();
    expect(same.api.startChunking).not.toHaveBeenCalled();

    const running = setup();
    running.api.chunkingEstimate.mockResolvedValue(ok({ ...ESTIMATE, running_job_id: 'job_x' }));
    await running.flow.prepareChange(STORE);
    await running.flow.estimate();
    expect(running.data.chunking).toMatchObject({ message: 'chunkingErrRunning', messageType: 'Error', estimate: { canStart: false } });
  });

  it('offers the start for the store\'s own contextual setting while chunks lack their context, and says how many', async () => {
    const { flow, api, data } = setup();
    api.chunkingEstimate.mockResolvedValue(ok({ ...ESTIMATE, target: { ...ESTIMATE.target, contextual: true }, unchanged: true, chunks_without_context: 7 }));
    await flow.prepareChange(STORE);
    await flow.estimate();
    expect(data.chunking).toMatchObject({ message: 'chunkingFillContexts(7)', messageType: 'Information', estimate: { fillsContexts: true, canStart: true } });
  });

  it('keeps the start offered but flags an embedding model already found unavailable', async () => {
    const { flow, api, data } = setup();
    api.chunkingEstimate.mockResolvedValue(ok({ ...ESTIMATE, embedding_model_unavailable: true }));
    await flow.prepareChange(STORE);
    await flow.estimate();
    expect(data.chunking.estimate).toMatchObject({ modelUnavailable: true, canStart: true });
  });

  it('shows a refused estimate in the dialog', async () => {
    const { flow, api, data } = setup();
    api.chunkingEstimate.mockResolvedValue(refused(404, 'not_found'));
    await flow.prepareChange(STORE);
    await flow.estimate();
    expect(data.chunking).toMatchObject({ busy: false, estimate: null, message: 'errNotFound', messageType: 'Error' });
  });

  it('drops an estimate that answers after a field changed, and clears a shown one on change', async () => {
    const { flow, api, data } = setup();
    await flow.prepareChange(STORE);
    let release!: (value: any) => void;
    api.chunkingEstimate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = flow.estimate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    data.chunking.form.maxTokens = 1000;
    flow.changed();
    release(ok(ESTIMATE));
    await pending;
    expect(data.chunking).toMatchObject({ estimate: null, busy: false });

    await flow.estimate();
    expect(data.chunking.estimate).not.toBeNull();
    flow.changed();
    expect(data.chunking).toMatchObject({ estimate: null, message: '' });
  });

  it('starts the re-chunk with the estimated setting and answers its job', async () => {
    const { flow, api, data } = setup();
    await flow.prepareChange(STORE);
    Object.assign(data.chunking.form, { type: 'structure', overlapTokens: 0, contextual: true });
    await flow.estimate();
    expect(await flow.start()).toMatchObject({ id: 'job_r' });
    expect(api.startChunking).toHaveBeenCalledWith('vs_1', STRUCTURE);
    expect(data.chunking.busy).toBe(false);
  });

  it('starts with exactly the setting the estimate was read for, even if the fields were edited without a change event', async () => {
    const { flow, api, data } = setup();
    await flow.prepareChange(STORE);
    await flow.estimate();
    expect(api.chunkingEstimate).toHaveBeenCalledWith('vs_1', { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
    data.chunking.form.maxTokens = 1200;
    expect(await flow.start()).toMatchObject({ id: 'job_r' });
    expect(api.startChunking).toHaveBeenCalledWith('vs_1', { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
  });

  it('starts nothing without an estimate, or after a field change dropped it', async () => {
    const { flow, api, data } = setup();
    await flow.prepareChange(STORE);
    data.chunking.estimate = { canStart: true };
    expect(await flow.start()).toBeNull();
    await flow.estimate();
    flow.changed();
    data.chunking.estimate = { canStart: true };
    expect(await flow.start()).toBeNull();
    expect(api.startChunking).not.toHaveBeenCalled();
  });

  it('can be estimated again without a field change: a job that was running has finished', async () => {
    const { flow, api, data } = setup();
    api.chunkingEstimate.mockResolvedValueOnce(ok({ ...ESTIMATE, running_job_id: 'job_x' }));
    await flow.prepareChange(STORE);
    await flow.estimate();
    expect(data.chunking).toMatchObject({ message: 'chunkingErrRunning', estimate: { canStart: false } });
    expect(await flow.start()).toBeNull();
    await flow.estimate();
    expect(api.chunkingEstimate).toHaveBeenCalledTimes(2);
    expect(data.chunking).toMatchObject({ message: '', estimate: { canStart: true } });
    expect(await flow.start()).toMatchObject({ id: 'job_r' });
  });

  it('keeps the overlap field bounded by half of max tokens', async () => {
    const { flow, data } = setup();
    await flow.prepareChange(STORE);
    expect(data.chunking.overlapMax).toBe(400);
    data.chunking.form.maxTokens = 1001;
    flow.changed();
    expect(data.chunking.overlapMax).toBe(500);
    data.chunking.form.maxTokens = 'abc';
    flow.changed();
    expect(data.chunking.overlapMax).toBe(2048);
    await flow.prepareCreate();
    expect(data.chunking.overlapMax).toBe(400);
  });

  it.each([
    ['reembed_running', 'chunkingErrRunning', 'Error'],
    ['store_model_unavailable', 'chunkingErrModelUnavailable', 'Error'],
    ['context_model_unavailable', 'chunkingErrContextModelUnavailable', 'Error'],
    ['chunking_current', 'chunkingUnchanged', 'Information'],
    ['store_expired', 'errStoreExpired', 'Error']
  ])('maps a refused start (%s) to the dialog and asks for a new estimate', async (code, message, type) => {
    const { flow, api, data } = setup();
    api.startChunking.mockResolvedValue(refused(409, code));
    await flow.prepareChange(STORE);
    await flow.estimate();
    expect(await flow.start()).toBeNull();
    expect(data.chunking).toMatchObject({ message, messageType: type, estimate: null, busy: false });
  });

  it('uses the admin routes on the Administration screen', async () => {
    const { flow, api } = setup({ admin: true });
    await flow.prepareChange({ ...STORE, ownerEmail: 'ada@example.test' });
    await flow.estimate();
    await flow.start();
    expect(api.adminChunkingEstimate).toHaveBeenCalledWith('vs_1', { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
    expect(api.adminStartChunking).toHaveBeenCalled();
    expect(api.chunkingEstimate).not.toHaveBeenCalled();
    expect(api.startChunking).not.toHaveBeenCalled();
  });

  it('does nothing without the API (the app is unavailable)', async () => {
    const { flow, data } = setup({ noApi: true });
    await flow.prepareChange(STORE);
    await flow.estimate();
    expect(data.chunking.estimate).toBeNull();
    await flow.prepareCreate();
    expect(data.chunking.form.type).toBe('static');
  });
});

describe('runningTarget', () => {
  it('names the target of a running re-chunk, and nothing for a plain re-embed, no job or a failed read', async () => {
    const { flow, api } = setup();
    expect(await flow.runningTarget('job_r')).toBe('chunkingSummaryContextual(chunkingType_structure|800|0)');
    api.getJob.mockResolvedValueOnce(ok({ id: 'job_e', kind: 'reembed_store', target_chunking: null }));
    expect(await flow.runningTarget('job_e')).toBe('');
    api.getJob.mockResolvedValueOnce(refused(404, 'not_found'));
    expect(await flow.runningTarget('job_x')).toBe('');
    api.getJob.mockClear();
    expect(await flow.runningTarget('')).toBe('');
    expect(api.getJob).not.toHaveBeenCalled();
  });
  it('runningJob tells a re-extract apart: it names no target (the store keeps its setting)', async () => {
    const { flow, api } = setup();
    expect(await flow.runningJob('job_r')).toEqual({ target: 'chunkingSummaryContextual(chunkingType_structure|800|0)', reextract: false });
    api.getJob.mockResolvedValue(ok({ id: 'job_x', kind: 'reembed_store', target_chunking: STRUCTURE, reextract: true }));
    expect(await flow.runningJob('job_x')).toEqual({ target: '', reextract: true });
    expect(await flow.runningTarget('job_x')).toBe('');
    expect(await flow.runningJob('')).toEqual({ target: '', reextract: false });
  });
});

describe('vision (W3)', () => {
  const VISION = { ...STRUCTURE, vision: 'no_text' };
  const VISION_ESTIMATE = {
    ...ESTIMATE, target: VISION, vision_model: 'gemini-3.5-flash-lite', vision_files: 2, estimated_vision_pages: 100,
    estimated_vision_input_tokens: 125000, estimated_vision_output_tokens: 256384, vision_unmasked_warning: true
  };
  const visionStatus = (available: boolean, unmaskedWarning = false, chunking: any = STRUCTURE) =>
    ok({ available: true, chunking, vision: { available, model: 'gemini-3.5-flash-lite', unmaskedWarning } });

  it('create: the field is offered where vision is available, starting from the default mode, with the warning flag', async () => {
    const { flow, api, data } = setup();
    api.status.mockResolvedValue(visionStatus(true, true, { ...STRUCTURE, vision: 'auto' }));
    await flow.prepareCreate();
    expect(data.chunking).toMatchObject({ visionShown: true, unmaskedWarning: true });
    expect(data.chunking.form.vision).toBe('auto');
    expect(await flow.setting()).toEqual({ ...STRUCTURE, vision: 'auto' });
  });

  it('create: where vision is switched off the field is hidden and a new store gets none', async () => {
    const { flow, api, data } = setup();
    api.status.mockResolvedValue(visionStatus(false, false, { ...STRUCTURE, vision: 'auto' }));
    await flow.prepareCreate();
    expect(data.chunking.visionShown).toBe(false);
    expect(await flow.setting()).toEqual(STRUCTURE);
  });

  it('change: a store\'s mode is shown and kept through a size edit, also where vision is switched off', async () => {
    const { flow, api, data } = setup();
    api.status.mockResolvedValue(visionStatus(false));
    await flow.prepareChange({ id: 'vs_1', name: 'Docs', chunking: VISION as any });
    expect(data.chunking).toMatchObject({ visionShown: true, current: expect.stringContaining('chunkingSummaryVision') });
    data.chunking.form.maxTokens = 600;
    flow.changed();
    expect(await flow.setting()).toEqual({ ...VISION, max_tokens: 600 });
    // a store without a mode, where vision is off: no field
    const plain = setup();
    plain.api.status.mockResolvedValue(visionStatus(false));
    await plain.flow.prepareChange(STORE);
    expect(plain.data.chunking.visionShown).toBe(false);
  });

  it('estimate: the vision rows priced with the Model Library (up to), the warning flag, and the start sends the mode', async () => {
    const { flow, api, data } = setup();
    api.chunkingEstimate.mockResolvedValue(ok(VISION_ESTIMATE));
    await flow.prepareChange(STORE);
    data.chunking.form.vision = 'no_text';
    flow.changed();
    await flow.estimate();
    const target = { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false, vision: 'no_text' };
    expect(api.chunkingEstimate).toHaveBeenCalledWith('vs_1', target);
    expect(api.modelCost).toHaveBeenCalledWith('gemini-3.5-flash-lite', 125000, 256384);
    expect(data.chunking.estimate).toMatchObject({
      vision: true, visionPages: '100', visionUnmasked: true, visionCost: 'chunkingEstimateVisionCostValue($0.12)'
    });
    await flow.start();
    expect(api.startChunking).toHaveBeenCalledWith('vs_1', target);
  });

  it('estimate: a model without a price, or a failed price lookup, says the cost is unknown; no mode looks up nothing', async () => {
    const { flow, api, data } = setup();
    api.chunkingEstimate.mockResolvedValue(ok(VISION_ESTIMATE));
    api.modelCost.mockResolvedValue(ok({ priced: false, capacity_units: null, cost: null, currency: null }));
    await flow.prepareChange({ id: 'vs_1', name: 'Docs', chunking: VISION as any });
    await flow.estimate();
    expect(data.chunking.estimate.visionCost).toBe('chunkingEstimateVisionCostUnknown(gemini-3.5-flash-lite)');
    api.modelCost.mockResolvedValue(refused(500, 'price_lookup_failed'));
    await flow.estimate();
    expect(data.chunking.estimate.visionCost).toBe('chunkingEstimateVisionCostUnknown(gemini-3.5-flash-lite)');

    const plain = setup();
    await plain.flow.prepareChange(STORE);
    await plain.flow.estimate();
    expect(plain.api.modelCost).not.toHaveBeenCalled();
  });

  it('estimate: an older estimate whose price answer arrives late leaves the newer dialog alone', async () => {
    const { flow, api, data } = setup();
    let release: (v: any) => void = () => undefined;
    api.chunkingEstimate.mockResolvedValueOnce(ok({ ...VISION_ESTIMATE, running_job_id: 'job_r' }));
    api.modelCost.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await flow.prepareChange({ id: 'vs_1', name: 'Docs', chunking: VISION as any });
    const older = flow.estimate();
    await new Promise((resolve) => setImmediate(resolve));
    expect(api.modelCost).toHaveBeenCalledTimes(1);
    api.chunkingEstimate.mockResolvedValueOnce(ok(VISION_ESTIMATE));
    await flow.estimate();
    expect(data.chunking.message).toBe('');
    release(ok({ priced: true, capacity_units: 1, cost: 9, currency: 'USD' }));
    await older;
    expect(data.chunking.message).toBe('');
    expect(data.chunking.estimate.visionCost).toBe('chunkingEstimateVisionCostValue($0.12)');
  });

  it('estimate: no vision tokens costs zero in the currency a price answer named, else a bare 0', async () => {
    const { flow, api, data } = setup();
    const none = { ...VISION_ESTIMATE, estimated_vision_input_tokens: 0, estimated_vision_output_tokens: 0 };
    api.chunkingEstimate.mockResolvedValue(ok(none));
    await flow.prepareChange({ id: 'vs_1', name: 'Docs', chunking: VISION as any });
    await flow.estimate();
    expect(api.modelCost).not.toHaveBeenCalled();
    expect(data.chunking.estimate.visionCost).toBe('chunkingEstimateVisionCostValue(0)');
    api.chunkingEstimate.mockResolvedValueOnce(ok(VISION_ESTIMATE));
    api.modelCost.mockResolvedValueOnce(ok({ priced: true, capacity_units: 3.2, cost: 0.12, currency: 'EUR' }));
    await flow.estimate();
    await flow.estimate();
    expect(data.chunking.estimate.visionCost).toBe('chunkingEstimateVisionCostValue(\u20ac0.00)');
  });

  it('a refused start with a mode is worded', async () => {
    const { flow, api, data } = setup();
    api.chunkingEstimate.mockResolvedValue(ok(VISION_ESTIMATE));
    api.startChunking.mockResolvedValue(refused(409, 'vision_model_unavailable'));
    await flow.prepareChange(STORE);
    data.chunking.form.vision = 'no_text';
    await flow.estimate();
    expect(await flow.start()).toBeNull();
    expect(data.chunking).toMatchObject({ message: 'chunkingErrVisionModelUnavailable', messageType: 'Error' });
  });
});
