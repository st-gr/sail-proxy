import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, section, paragraphs, toSeconds, toLabel, wordCount } from './script.mjs';

const SAMPLE = `---
video: 03-docker-compose
title: Deploy with Docker Compose
subtitle: Gateway, cockpit, nginx, Dex and PostgreSQL on one host
kicker: sail-proxy · deploy
target_seconds: 300
voice: marin
next: Deploy on SAP BTP Kyma
casts: setup, up
sections:
  - 1 | 00:05 | What you get | The services and what each does
  - 2 | 00:40 | Set up and start | The setup script and the first start
---

## Spoken script
[00:05] One. Two.

[00:41] Three, four and five.

## On-screen cues
- 00:05 the home page

## Recap and next
That was it. Next: Kyma.

## Pronunciation
Kyma: KEE-ma
`;

test('parseScript reads the flat keys, the casts list and the section lines', () => {
  const { meta } = parseScript(SAMPLE);
  assert.equal(meta.title, 'Deploy with Docker Compose');
  assert.equal(meta.target_seconds, '300');
  assert.deepEqual(meta.casts, ['setup', 'up']);
  assert.deepEqual(meta.sections, [
    { n: 1, start: 5, label: '00:05', title: 'What you get', outcome: 'The services and what each does' },
    { n: 2, start: 40, label: '00:40', title: 'Set up and start', outcome: 'The setup script and the first start' }
  ]);
});

test('parseScript splits the spoken paragraphs at their cues and reads recap and pronunciation', () => {
  const s = parseScript(SAMPLE);
  assert.deepEqual(s.spoken, [{ at: 5, label: '00:05', text: 'One. Two.' }, { at: 41, label: '00:41', text: 'Three, four and five.' }]);
  assert.equal(s.recap, 'That was it. Next: Kyma.');
  assert.equal(s.pronunciation.trim(), 'Kyma: KEE-ma');
  assert.equal(section(s.body, 'Missing'), undefined);
  assert.throws(() => parseScript('no front matter'), /front matter/);
  assert.throws(() => paragraphs('no cue here'), /cue/);
});

test('time helpers and the word count', () => {
  assert.equal(toSeconds('01:05'), 65); assert.equal(toLabel(65), '01:05'); assert.equal(toLabel(5.6), '00:06');
  assert.equal(wordCount('[00:05] one two\n<!-- note -->\nthree'), 3);
});
