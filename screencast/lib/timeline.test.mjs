import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeline, castMarks, holdRanges, checkCues, manifestMatches, shiftTime, vtt, ffmetadata, chaptersText, updateEntry } from './timeline.mjs';

const clips = [{ section: 1, file: 'clips/section-1.mp4', seconds: 20 }, { section: 2, file: 'clips/section-2.mp4', seconds: 30.5 }];

test('timeline puts the intro first, a card before each clip and the outro last', () => {
  const tl = timeline({ clips, outroSeconds: 20 });
  assert.deepEqual(tl.pieces.map((p) => [p.kind, p.start]), [['intro', 0], ['card', 5], ['clip', 8], ['card', 28], ['clip', 31], ['outro', 61.5]]);
  assert.deepEqual(tl.sections, [{ n: 1, start: 5 }, { n: 2, start: 28 }]);
  assert.equal(tl.outroStart, 61.5); assert.equal(tl.total, 81.5);
});

test('checkCues wants a cue in every section window, none in the outro and none after the end', () => {
  const sections = [{ n: 1, start: 5 }, { n: 2, start: 28 }];
  assert.deepEqual(checkCues(sections, [{ at: 5, label: '00:05' }, { at: 29, label: '00:29' }], 60, 80), []);
  const p = checkCues(sections, [{ at: 5, label: '00:05' }, { at: 20, label: '00:20' }, { at: 70, label: '01:10' }, { at: 90, label: '01:30' }], 60, 80);
  assert.ok(p[0].includes('section 2 starts at 00:28 but has no cue between 00:28 and the outro'));
  assert.ok(p[1].includes('cue [01:10] falls inside the outro card (from 01:00)'));
  assert.ok(p[2].includes('cue [01:30] is after the end of the video (01:20)'));
});

test('manifestMatches refuses a moved cue and a count mismatch', () => {
  const spoken = [{ at: 5, label: '00:05' }, { at: 21, label: '00:21' }];
  assert.deepEqual(manifestMatches(spoken, [{ at: 5 }, { at: 21 }]), []);
  assert.match(manifestMatches(spoken, [{ at: 5 }, { at: 20 }])[0], /cue 2 is at \[00:21\] in the script but the narration was made for \[00:20\]/);
  assert.match(manifestMatches(spoken, [{ at: 5 }])[0], /2 cues but the narration has 1 segments/);
});

test('shiftTime subtracts the cuts before a time and folds a time inside a cut onto its start', () => {
  const cuts = [{ start: 10, end: 12 }, { start: 20, end: 25 }];
  assert.equal(shiftTime(5, cuts), 5); assert.equal(shiftTime(15, cuts), 13); assert.equal(shiftTime(22, cuts), 18); assert.equal(shiftTime(30, cuts), 23);
});

test('vtt, ffmetadata and chaptersText formats', () => {
  assert.equal(vtt([{ start: 5, end: 12.4, text: 'Hello.' }]), 'WEBVTT\n\n00:00:05.000 --> 00:00:12.400\nHello.\n');
  assert.equal(ffmetadata([{ t: 0, title: 'Introduction' }, { t: 5, title: 'One' }], 81.5), ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=5000\ntitle=Introduction\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=81500\ntitle=One\n');
  assert.equal(chaptersText([{ t: 0, title: 'Introduction' }, { t: 65, title: 'One' }]), '00:00 Introduction\n01:05 One\n');
});

test('updateEntry patches one catalogue entry and refuses an unknown id', () => {
  const cat = [{ id: 'a', duration: 0 }, { id: 'b', duration: 0 }];
  assert.deepEqual(updateEntry(cat, 'b', { duration: 7 }), [{ id: 'a', duration: 0 }, { id: 'b', duration: 7 }]);
  assert.throws(() => updateEntry(cat, 'c', {}), /no catalogue entry c/);
});

test('holdRanges scales a logged hold by the clip\'s video over wall-clock length and pads it', () => {
  const tl = { pieces: [{ kind: 'card', section: 1, start: 5, seconds: 3 }, { kind: 'clip', section: 1, start: 8, seconds: 20 }] };
  const timing = [{ section: 1, event: 'caption x', ms_since_clip_start: 1000 }, { section: 1, event: 'hold 2000', ms_since_clip_start: 10000 }];
  assert.deepEqual(holdRanges(timing, tl, [{ section: 1, seconds: 22, measured: 20 }]), [{ start: 18.5, end: 21.7 }]);
  assert.deepEqual(holdRanges(timing, tl, [{ section: 1, seconds: 20 }]), [{ start: 17.5, end: 20.5 }]);
});

test('castMarks places each cast start and end on the assembled timeline', () => {
  const tl = timeline({ clips: [{ section: 1, file: 'a', seconds: 20 }, { section: 2, file: 'b', seconds: 30 }], outroSeconds: 4 });
  const timing = [
    { section: 2, event: 'section 2', ms_since_clip_start: 0 },
    { section: 2, event: 'cast up', ms_since_clip_start: 2000 },
    { section: 2, event: 'cast-end up', ms_since_clip_start: 12500 },
    { section: 2, event: 'cast down', ms_since_clip_start: 14000 }
  ];
  const clip2 = tl.pieces.find((p) => p.kind === 'clip' && p.section === 2).start;
  assert.deepEqual(castMarks(timing, tl), [{ name: 'up', start: clip2 + 2, end: clip2 + 12.5 }, { name: 'down', start: clip2 + 14, end: null }]);
});
