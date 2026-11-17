import { deleteDoneText, deleteOutcome, deleteResultAfter, shownAfter, missingWithinWindow, tracesTouched, logTouched } from '../webapp/model/deleteNow';
import type { ApiResult } from '../webapp/model/api';

const t = (key: string, args?: (string | number)[]) => (args && args.length ? `${key}(${args.join('|')})` : key);
const format = (n: number) => `#${n}`;
type Counts = { deleted: number; logEntries: number; traces: number };
const counts = (logEntries: number, traces: number): Counts => ({ deleted: logEntries + traces, logEntries, traces });
const answer = (over: Partial<ApiResult<Counts>>): ApiResult<Counts> =>
  ({ ok: true, status: 200, body: counts(3, 0), error: null, ...over });

describe('deleteDoneText', () => {
  it('the log says none, one, or the formatted count of log entries', () => {
    expect(deleteDoneText(counts(0, 9), 'log', t, format)).toBe('deleteDoneNone');
    expect(deleteDoneText(counts(1, 9), 'log', t, format)).toBe('deleteDoneOne');
    expect(deleteDoneText(counts(1234, 9), 'log', t, format)).toBe('deleteDoneMany(#1234)');
  });

  it('the traces say none, one, or the formatted count of traces', () => {
    expect([0, 1, 7].map((n) => deleteDoneText(counts(9, n), 'traces', t, format)))
      .toEqual(['deleteDoneTracesNone', 'deleteDoneTracesOne', 'deleteDoneTracesMany(#7)']);
  });

  it('both name the two counts apart, each with its own number', () => {
    expect(deleteDoneText(counts(20, 1), 'all', t, format)).toBe('deleteDoneAll(countLogEntries(#20)|countTracesOne(#1))');
    expect(deleteDoneText(counts(1, 0), 'all', t, format)).toBe('deleteDoneAll(countLogEntriesOne(#1)|countTraces(#0))');
    expect(deleteDoneText(counts(0, 0), 'all', t, format)).toBe('deleteDoneAllNone');
  });

  it('does not guess a count that did not come back', () => {
    for (const bad of [undefined, null, '3', { deleted: 3 }, { logEntries: NaN, traces: Infinity }, { logEntries: -1, traces: -1 }]) {
      expect([deleteDoneText(bad, 'log', t, format), deleteDoneText(bad, 'traces', t, format), deleteDoneText(bad, 'all', t, format)])
        .toEqual(['deleteDoneUnknown', 'deleteDoneTracesUnknown', 'deleteDoneAllUnknown']);
    }
  });
});

describe('tracesTouched', () => {
  it('a delete of the traces or of both empties the traces list; a delete of the log does not', () => {
    expect(tracesTouched('traces')).toBe(true);
    expect(tracesTouched('all')).toBe(true);
    expect(tracesTouched('log')).toBe(false);
    expect(tracesTouched(undefined)).toBe(false);
  });
});

describe('logTouched', () => {
  it('a delete of the log or of both empties the Gateway log; a delete of the traces does not', () => {
    expect(logTouched('log')).toBe(true);
    expect(logTouched('all')).toBe(true);
    expect(logTouched('traces')).toBe(false);
    expect(logTouched(undefined)).toBe(false);
  });
});

describe('deleteOutcome', () => {
  it('a success says how many were deleted and reloads the list', () => {
    expect(deleteOutcome(answer({}), 'log', t, format)).toEqual({ ok: true, text: 'deleteDoneMany(#3)', reloadList: true });
  });

  it('a success after deleting the traces says traces', () => {
    expect(deleteOutcome(answer({ body: counts(0, 2) }), 'traces', t, format)).toEqual({ ok: true, text: 'deleteDoneTracesMany(#2)', reloadList: true });
  });

  it('a success with nothing deleted still reloads the list', () => {
    expect(deleteOutcome(answer({ body: counts(0, 0) }), 'log', t, format)).toEqual({ ok: true, text: 'deleteDoneNone', reloadList: true });
  });

  it('a failure shows the service\'s message and leaves the list as it is', () => {
    const failed = answer({ ok: false, status: 400, body: null, error: { status: 400, code: 'x', message: 'The service says no.' } });
    expect(deleteOutcome(failed, 'log', t, format)).toEqual({ ok: false, text: 'The service says no.', reloadList: false });
  });
});

describe('deleteResultAfter', () => {
  it('keeps the message on a poll and on the reload the delete itself triggers', () => {
    expect(deleteResultAfter('Three entries were deleted.', 'poll')).toBe('Three entries were deleted.');
    expect(deleteResultAfter('Three entries were deleted.', 'delete')).toBe('Three entries were deleted.');
  });

  it('hides it when the person does something else with the list', () => {
    expect(deleteResultAfter('Three entries were deleted.', 'user')).toBe('');
  });
});

describe('shownAfter', () => {
  const before = ['a', 'b', 'c'];
  it('finds a remembered row that is still shown', () => {
    expect(shownAfter(before, ['x', 'b'])).toEqual(['b']);
    expect(shownAfter(before, [])).toEqual([]);
  });
  it('a row that arrived after the delete is not a remembered row', () => {
    expect(shownAfter(before, ['new'])).toEqual([]);
  });
  it('nothing remembered, nothing to find', () => {
    expect(shownAfter([], ['new'])).toEqual([]);
  });
});

describe('missingWithinWindow', () => {
  const row = (key: string, at: number) => ({ key, at });
  const remembered = [row('a', 1), row('b', 2), row('c', 3)];
  const LIMIT = 4;   // a small view limit stands for the app's DEFAULT_LIMIT
  it('nothing is missing when every remembered row is still shown', () => {
    expect(missingWithinWindow(remembered, [row('a', 1), row('b', 2), row('c', 3), row('new', 4)], LIMIT)).toEqual([]);
  });
  it('after an unwanted delete with newer rows present and the view not full, every remembered row is missing', () => {
    expect(missingWithinWindow(remembered, [row('new1', 4), row('new2', 5)], LIMIT)).toEqual(['a', 'b', 'c']);
  });
  it('a full view excuses the oldest remembered rows pushed out by newer entries', () => {
    expect(missingWithinWindow(remembered, [row('c', 3), row('n1', 4), row('n2', 5), row('n3', 6)], LIMIT)).toEqual([]);
    expect(missingWithinWindow(remembered, [row('n1', 4), row('n2', 5), row('n3', 6), row('n4', 7)], LIMIT)).toEqual([]);
  });
  it('a full view still reports a remembered row newer than the oldest shown row', () => {
    expect(missingWithinWindow(remembered, [row('b', 2), row('n1', 4), row('n2', 5), row('n3', 6)], LIMIT)).toEqual(['c']);
  });
  it('remembered rows tied with the oldest shown row are missing in a view that is not full', () => {
    const tied = [row('a', 5), row('b', 5)];
    expect(missingWithinWindow(tied, [row('n1', 5), row('n2', 6)], LIMIT)).toEqual(['a', 'b']);
  });
  it('remembered rows tied with the oldest shown row are excused in a full view', () => {
    const tied = [row('a', 5), row('b', 5)];
    expect(missingWithinWindow(tied, [row('n1', 5), row('n2', 6), row('n3', 7), row('n4', 8)], LIMIT)).toEqual([]);
  });
  it('an empty view misses every remembered row', () => {
    expect(missingWithinWindow(remembered, [], LIMIT)).toEqual(['a', 'b', 'c']);
    expect(missingWithinWindow([], [], LIMIT)).toEqual([]);
  });
});
