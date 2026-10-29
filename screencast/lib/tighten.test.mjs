import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuts, keeps, silencesOf, stills } from './tighten.mjs';

test('cuts are the overlaps of silence and stillness, shortened at both edges, never inside a protected range', () => {
  const c = cuts([{ start: 0, end: 10 }], [{ start: 2, end: 9 }], { minIdle: 1.5, keep: 0.4 });
  assert.deepEqual(c, [{ start: 2.4, end: 8.6 }]);
  const p = cuts([{ start: 0, end: 10 }], [{ start: 2, end: 9 }], { minIdle: 1.5, keep: 0.4 }, [{ start: 4, end: 6 }]);
  assert.deepEqual(p, [{ start: 2.4, end: 3.6 }, { start: 6.4, end: 8.6 }]);
  assert.deepEqual(cuts([{ start: 0, end: 1 }], [{ start: 0, end: 1 }], { minIdle: 1.5, keep: 0.4 }), []);
});

test('keeps is the complement of the cuts over the duration', () => {
  assert.deepEqual(keeps([{ start: 2, end: 4 }, { start: 6, end: 7 }], 10), [{ start: 0, end: 2 }, { start: 4, end: 6 }, { start: 7, end: 10 }]);
});

test('silencesOf reads ffmpeg silencedetect and stills finds runs under the threshold', () => {
  assert.deepEqual(silencesOf('[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 3.25 | silence_duration: 1.75\nsilence_start: 9\n', 10), [{ start: 1.5, end: 3.25 }, { start: 9, end: 10 }]);
  assert.deepEqual(stills([1, 2, 30, 1, 1, 1, 1, 40], { fps: 5, threshold: 8, min: 0.5 }), [{ start: 3, end: 7 }].map((r) => ({ start: r.start / 5, end: r.end / 5 })));
});

import { tightenOptions, OPTS } from './tighten.mjs';

test('a script can keep more of each idle edge (tighten_keep), within half the shortest stretch', () => {
  assert.deepEqual(tightenOptions({}), OPTS);
  assert.deepEqual(tightenOptions({ tighten_keep: '0.65' }), { ...OPTS, keep: 0.65 });
  // half a second more per stretch than the default 0.4 at each edge
  const c = cuts([{ start: 0, end: 10 }], [{ start: 2, end: 9 }], tightenOptions({ tighten_keep: '0.65' }));
  assert.deepEqual(c, [{ start: 2.65, end: 8.35 }]);
  assert.throws(() => tightenOptions({ tighten_keep: '0.8' }), /tighten_keep/);
  assert.throws(() => tightenOptions({ tighten_keep: 'x' }), /tighten_keep/);
});
