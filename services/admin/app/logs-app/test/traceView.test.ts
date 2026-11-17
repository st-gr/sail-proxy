import { captureTextKey, contentState, fileLoggingTextKey, problemKey, stageList, traceFacts, traceListRows, weakKeyTextKey, withRawOnly } from '../webapp/model/traceView';

const row = (over: Record<string, unknown> = {}) => ({
  ID: '1700000000000-0', requestId: 'req-1', capturedAt: '2026-11-13T09:30:00.000Z', endpoint: '/v1/chat/completions', model: 'gpt-4o',
  keyName: 'Jane Roe key', userEmail: 'jane.roe@example.org', statusCode: 200, durationMs: 1234, inputTokens: 10, outputTokens: 20,
  masked: true, truncated: false, omitted: null, raw: false, ...over
});

describe('traceFacts', () => {
  it('names the route, the model, the key and its user, the status and the duration', () => {
    expect(traceFacts(row())).toMatchObject({
      route: '/v1/chat/completions', model: 'gpt-4o', keyName: 'Jane Roe key', userEmail: 'jane.roe@example.org',
      keyAndUser: 'Jane Roe key · jane.roe@example.org', status: '200', statusState: 'Success', durationMs: 1234,
      inputTokens: 10, outputTokens: 20, masked: true, raw: false, truncated: false, omitted: ''
    });
  });

  it('says masked, not masked and raw by text keys', () => {
    expect(traceFacts(row()).contentKeys).toEqual(['contentMasked']);
    expect(traceFacts(row({ masked: false })).contentKeys).toEqual(['contentNotMasked']);
    expect(traceFacts(row({ masked: false, raw: true })).contentKeys).toEqual(['contentNotMasked', 'contentRaw']);
  });

  it('a status of 400 and above is an error, missing facts stay empty', () => {
    expect(traceFacts(row({ statusCode: 429 })).statusState).toBe('Error');
    const bare = traceFacts(row({ statusCode: null, durationMs: null, keyName: null, userEmail: null, model: null, endpoint: null, inputTokens: null }));
    expect(bare).toMatchObject({ status: '', statusState: 'None', durationMs: null, keyAndUser: '', model: '', route: '', inputTokens: null });
    expect(traceFacts(row({ keyName: null })).keyAndUser).toBe('jane.roe@example.org');
  });

  it('booleans that arrive as 0 and 1 are read as booleans', () => {
    expect(traceFacts(row({ masked: 0, raw: 1, truncated: 1 }))).toMatchObject({ masked: false, raw: true, truncated: true });
  });
});

describe('contentState', () => {
  it('masked text is shown at once; a sealed prompt behind "Show content"; a facts-only trace has none', () => {
    expect(contentState(traceFacts(row()))).toBe('masked');
    expect(contentState(traceFacts(row({ masked: false, promptSealed: true })))).toBe('sealed');
    expect(contentState(traceFacts(row({ masked: false, promptSealed: 1 })))).toBe('sealed');
    // A raw-capture trace recorded while payload capture was off: facts only, its stages are offered.
    const factsOnly = traceFacts(row({ masked: false, promptSealed: false, raw: true, omitted: 'not-captured' }));
    expect(contentState(factsOnly)).toBe('none');
    expect(factsOnly.raw).toBe(true);
    expect(contentState(traceFacts(row({ masked: false })))).toBe('none');
  });
});

describe('stageList', () => {
  it('keeps the recorded order and marks the stages that were cut', () => {
    const index = JSON.stringify([
      { name: '00_arrival', bytes: 512, cut: false },
      { name: 'sap_request', bytes: 1536, cut: false },
      { name: 'sap_request#2', bytes: 262144, cut: true },
      { name: 'zz_client_response', bytes: 3 * 1024 * 1024, cut: false }
    ]);
    expect(stageList(index)).toEqual([
      { name: '00_arrival', size: '512 B', cut: false },
      { name: 'sap_request', size: '1.5 KB', cut: false },
      { name: 'sap_request#2', size: '256 KB', cut: true },
      { name: 'zz_client_response', size: '3 MB', cut: false }
    ]);
  });

  it('takes an array as well, and an unreadable index is no stages', () => {
    expect(stageList([{ name: 'a', bytes: 0, cut: false }])).toEqual([{ name: 'a', size: '0 B', cut: false }]);
    expect(stageList('not json')).toEqual([]);
    expect(stageList(null)).toEqual([]);
    expect(stageList('{"name":"a"}')).toEqual([]);
    expect(stageList([{ bytes: 1 }, { name: 'b' }])).toEqual([{ name: 'b', size: '', cut: false }]);
  });

  it('formats the size in the locale', () => {
    expect(stageList([{ name: 'a', bytes: 1536, cut: false }], 'de-DE')[0].size).toBe('1,5 KB');
  });
});

describe('withRawOnly', () => {
  const light = [row({ ID: 'L1', requestId: 'req-1', capturedAt: '2026-11-13T09:30:00.000Z', raw: true })];
  const raw = [
    { ID: 'R1', requestId: 'req-1', capturedAt: '2026-11-13T09:30:00.100Z' },
    { ID: 'R2', requestId: 'req-2', capturedAt: '2026-11-13T09:40:00.000Z' },
    { ID: 'R3', requestId: 'other-3', capturedAt: '2026-11-13T09:10:00.000Z' }
  ];

  it('adds the raw requests that have no light trace (payload capture off), newest first', () => {
    const rows = withRawOnly(light, raw, '');
    expect(rows.map((r) => [r.ID, r.requestId, r.rawOnly === true])).toEqual([['R2', 'req-2', true], ['L1', 'req-1', false], ['R3', 'other-3', true]]);
    expect(traceFacts(rows[0]).contentKeys).toEqual(['contentRaw']);
  });

  it('a filter text keeps the raw-only requests whose request id holds it', () => {
    expect(withRawOnly(light, raw, ' OTHER ').map((r) => r.ID)).toEqual(['L1', 'R3']);
  });
});

describe('traceListRows', () => {
  const light = [row({ ID: 'L1', requestId: 'req-1', capturedAt: '2026-11-13T09:30:00.000Z' })];
  const raw = [{ ID: 'R2', requestId: 'req-2', capturedAt: '2026-11-13T09:40:00.000Z' }];
  const LIMIT = 3;

  it('a light read that was not cut gets the raw-only rows', () => {
    expect(traceListRows({ entries: light, count: 1 }, raw, '', LIMIT)).toMatchObject({ cut: false, total: 1, rawLeftOut: false });
    expect(traceListRows({ entries: light, count: 1 }, raw, '', LIMIT).rows.map((r) => r.ID)).toEqual(['R2', 'L1']);
  });

  // The gateway stamps a raw trace when the request starts and its light trace when it ends, so a raw
  // trace is never newer than its light trace: one newer than the oldest light row shown has its light
  // trace among the rows shown, or none.
  const shown = [
    light[0],
    row({ ID: 'L2', requestId: 'req-3', capturedAt: '2026-11-13T09:20:00.000Z' }),
    row({ ID: 'L3', requestId: 'req-4', capturedAt: '2026-11-13T09:10:00.000Z' })
  ];
  const mixed = [
    ...raw,
    { ID: 'R5', requestId: 'req-5', capturedAt: '2026-11-13T09:10:00.000Z' },
    { ID: 'R6', requestId: 'req-6', capturedAt: '2026-11-13T09:05:00.000Z' }
  ];

  it('a cut light read gets the raw-only rows newer than its oldest row, and says that others are left out', () => {
    const result = traceListRows({ entries: shown, count: 5 }, mixed, '', 10);
    expect(result).toMatchObject({ cut: true, total: 5, rawLeftOut: true });
    expect(result.rows.map((r) => r.ID)).toEqual(['R2', 'L1', 'L2', 'L3']);
  });

  it('a cut light read with every raw-only row newer than its oldest row leaves nothing out', () => {
    const result = traceListRows({ entries: shown, count: 5 }, raw, '', 10);
    expect(result).toMatchObject({ cut: true, rawLeftOut: false });
    expect(result.rows.map((r) => r.ID)).toEqual(['R2', 'L1', 'L2', 'L3']);
  });

  it('a raw-only row left out by the filter text is not counted as left out by the cut', () => {
    expect(traceListRows({ entries: shown, count: 5 }, mixed, 'req-2', 10)).toMatchObject({ rawLeftOut: false });
  });

  it('a raw read that filled the limit may miss raw-only rows: it says so', () => {
    expect(traceListRows({ entries: light, count: 1 }, raw, '', 1)).toMatchObject({ cut: false, rawLeftOut: true });
  });

  it('without a count, a read that filled the limit counts as cut', () => {
    expect(traceListRows({ entries: shown, count: null }, [], '', LIMIT)).toMatchObject({ cut: true, total: null });
    expect(traceListRows({ entries: light, count: null }, [], '', LIMIT)).toMatchObject({ cut: false });
  });
});

describe('captureTextKey and weakKeyTextKey', () => {
  it('payload capture as the record says, else as the configuration says', () => {
    expect(captureTextKey({ payloadCaptureEnabled: null, configurationPayloadCaptureEnabled: true })).toBe('captureOn');
    expect(captureTextKey({ payloadCaptureEnabled: false, configurationPayloadCaptureEnabled: true })).toBe('captureOff');
    expect(captureTextKey({ payloadCaptureEnabled: true, configurationPayloadCaptureEnabled: false })).toBe('captureOn');
    expect(captureTextKey({ payloadCaptureEnabled: null, configurationPayloadCaptureEnabled: null })).toBe('captureOff');
  });

  it('warns for every seal key that is not strong (D1)', () => {
    expect(weakKeyTextKey('strong')).toBe('');
    expect(weakKeyTextKey('missing')).toBe('weakKeyMissing');
    expect(weakKeyTextKey('too-short')).toBe('weakKeyTooShort');
    expect(weakKeyTextKey('publicly-known')).toBe('weakKeyPubliclyKnown');
    expect(weakKeyTextKey(null)).toBe('');
  });
});

describe('fileLoggingTextKey', () => {
  it('warns while the gateway writes payload files, and says nothing otherwise', () => {
    expect(fileLoggingTextKey(true)).toBe('payloadFilesOn');
    expect(fileLoggingTextKey(false)).toBe('');
    expect(fileLoggingTextKey(null)).toBe('');
    expect(fileLoggingTextKey(undefined)).toBe('');
  });
});

describe('problemKey', () => {
  it('translates the codes of openPayloadTrace, openRawStage and the downloads', () => {
    expect(problemKey('keys-differ')).toBe('traceKeysDiffer');
    expect(problemKey('malformed')).toBe('traceMalformed');
    expect(problemKey('not_found')).toBe('traceNotFound');
    expect(problemKey('download_failed')).toBe('traceReadFailed');
    expect(problemKey(undefined)).toBe('traceReadFailed');
  });
});
