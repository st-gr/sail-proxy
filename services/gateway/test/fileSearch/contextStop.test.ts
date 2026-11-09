// The per-file context stop a chunking records (contextStop.ts): only the file's own time and token
// limits count; a token-limit stop is final at once, a time-limit stop gets one retry by the fill.
import { FINAL_CONTEXT_STOPS, recordedContextStop } from '../../src/fileSearch/contextStop';

describe('recordedContextStop', () => {
  it('records a stop at the file\'s time limit as a first try', () => {
    expect(recordedContextStop('deadline', null, false)).toBe('deadline');
    expect(recordedContextStop('deadline', 'budget', false)).toBe('deadline'); // another setting: a first try again
    expect(recordedContextStop('deadline', null, true)).toBe('deadline'); // same setting, nothing stopped before
  });

  it('marks the fill\'s retry of a time-limit stop that stops again', () => {
    expect(recordedContextStop('deadline', 'deadline', true)).toBe('deadline_retried');
    expect(recordedContextStop('deadline', 'deadline_retried', true)).toBe('deadline_retried');
  });

  it('a token-limit stop is final at the first stop: the same budget would stop a retry again', () => {
    expect(recordedContextStop('budget', null, false)).toBe('budget');
    expect(recordedContextStop('budget', 'deadline', true)).toBe('budget');
    expect(FINAL_CONTEXT_STOPS).toEqual(['budget', 'deadline_retried']);
  });

  it('records nothing when the writer tried every chunk, or stopped for an outage or an abort', () => {
    for (const previous of [null, 'deadline', 'budget']) {
      expect(recordedContextStop(undefined, previous, true)).toBeNull();
      expect(recordedContextStop('failing', previous, true)).toBeNull();
      expect(recordedContextStop('no_deployment', previous, true)).toBeNull();
      expect(recordedContextStop('aborted', previous, true)).toBeNull();
    }
  });
});
