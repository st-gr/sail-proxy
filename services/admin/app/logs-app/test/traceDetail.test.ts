import { detailState, offersShowContent, openedContent, stageText } from '../webapp/model/traceDetail';
import { traceFacts, type TraceRow } from '../webapp/model/traceView';

const shown = (over: Partial<TraceRow> = {}) => {
  const row: TraceRow = { ID: '1700000000000-0', requestId: 'req-1', capturedAt: '2026-11-13T09:30:00.000Z', masked: false, raw: false, ...over };
  return { rawOnly: row.rawOnly, facts: traceFacts(row) };
};

describe('detailState', () => {
  it('a masked trace shows its text at once: no "Show content", no stages', () => {
    expect(detailState(shown({ masked: true }))).toEqual({
      hasLight: true, masked: true, raw: false, sealed: false, noContent: false,
      loadContent: true, loadStages: false, downloadTrace: true, stageActions: false
    });
  });

  it('a sealed trace offers "Show content" and loads nothing until it is pressed', () => {
    const state = detailState(shown({ promptSealed: true }));
    expect(state).toMatchObject({ sealed: true, noContent: false, loadContent: false, downloadTrace: true, stageActions: false });
    expect(offersShowContent({ ...state, contentShown: false })).toBe(true);
    expect(offersShowContent({ ...state, contentShown: true })).toBe(false);
  });

  it('a facts-only trace of a raw capture says it holds no content and offers its stages', () => {
    const state = detailState(shown({ raw: true }));
    expect(state).toEqual({
      hasLight: true, masked: false, raw: true, sealed: false, noContent: true,
      loadContent: false, loadStages: true, downloadTrace: true, stageActions: true
    });
    expect(offersShowContent({ ...state, contentShown: false })).toBe(false);
  });

  it('a masked trace captured raw shows its text and its stages', () => {
    expect(detailState(shown({ masked: true, raw: true }))).toMatchObject({ masked: true, loadContent: true, loadStages: true, stageActions: true });
  });

  it('a sealed trace captured raw offers "Show content" and its stages', () => {
    const state = detailState(shown({ promptSealed: true, raw: true }));
    expect(state).toMatchObject({ sealed: true, loadContent: false, loadStages: true, stageActions: true });
    expect(offersShowContent({ ...state, contentShown: false })).toBe(true);
  });

  it('a raw-only row (no light trace) has only its stages: no content, no trace download', () => {
    const state = detailState(shown({ raw: true, rawOnly: true }));
    expect(state).toMatchObject({ hasLight: false, sealed: false, loadContent: false, loadStages: true, downloadTrace: false, stageActions: true });
    expect(offersShowContent({ ...state, contentShown: false })).toBe(false);
  });
});

describe('openedContent', () => {
  it('shows the prompt and the answer the service returned', () => {
    expect(openedContent({ masked: true, prompt: 'Hello', answer: 'Hi', problem: null }))
      .toEqual({ prompt: 'Hello', answer: 'Hi', contentShown: true, noContent: false, problemKey: '' });
  });

  it('a seal that cannot be opened says why and shows nothing', () => {
    expect(openedContent({ masked: false, prompt: null, answer: null, problem: 'keys-differ' }))
      .toEqual({ prompt: '', answer: '', contentShown: false, noContent: false, problemKey: 'traceKeysDiffer' });
  });

  it('a trace that holds no text says so instead of showing empty fields', () => {
    expect(openedContent({ masked: true, prompt: null, answer: '', problem: null }))
      .toEqual({ prompt: '', answer: '', contentShown: true, noContent: true, problemKey: '' });
  });
});

describe('stageText', () => {
  it('indents a stage that is JSON', () => {
    expect(stageText('{"a":1}', false)).toBe('{\n  "a": 1\n}');
  });

  it('shows a cut stage and a stage that is not JSON as they are', () => {
    expect(stageText('{"a":1', true)).toBe('{"a":1');
    expect(stageText('{"a":1}', true)).toBe('{"a":1}');
    expect(stageText('plain text', false)).toBe('plain text');
  });
});
