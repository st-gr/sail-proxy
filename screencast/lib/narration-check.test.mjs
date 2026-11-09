import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problemsOf } from './narration-check.mjs';

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const valid = `---
video: 03-docker-compose
title: Deploy with Docker Compose
subtitle: Five services on one host
kicker: sail-proxy · deploy
target_seconds: 120
voice: marin
next: Deploy on SAP BTP Kyma
casts: up
sections:
  - 1 | 00:05 | One | one
  - 2 | 01:00 | Two | two
---

## Spoken script
[00:05] ${words(100)}

[01:02] ${words(100)}

## On-screen cues
- 00:05 x

## Recap and next
${words(30)}

## Pronunciation
none
`;
const steps = "export default async ({ section, cast }) => { await section(1); await cast('up'); await section(2); };";

test('a valid script with its cast and step file has no problems', () => {
  assert.deepEqual(problemsOf('03-docker-compose', valid, { casts: new Set(['up']), steps }), []);
});

test('missing pieces are each named once', () => {
  const p = problemsOf('03-docker-compose', valid.replace('voice: marin\n', '').replace('## Pronunciation\nnone\n', ''), { casts: new Set(['up']), steps });
  assert.ok(p.includes('03-docker-compose: front matter lacks "voice"'));
  assert.ok(p.includes('03-docker-compose: missing section "## Pronunciation"'));
});

test('cues must sit at or after their section, ascend and fit the target; words and recap stay in band', () => {
  const late = problemsOf('03-docker-compose', valid.replace('[01:02]', '[00:50]'), { casts: new Set(['up']), steps });
  assert.ok(late.some((x) => x.includes('section 2 (01:00) has no cue at or after its start')));
  const after = problemsOf('03-docker-compose', valid.replace('[01:02]', '[02:30]'), { casts: new Set(['up']), steps });
  assert.ok(after.some((x) => x.includes('is after the end of the 120 s video')));
  const few = problemsOf('03-docker-compose', valid.replace(words(100), words(10)).replace(words(100), words(10)), { casts: new Set(['up']), steps });
  assert.ok(few.some((x) => /spoken words, expected 112 to 308/.test(x)));
  const recap = problemsOf('03-docker-compose', valid.replace(`## Recap and next\n${words(30)}`, `## Recap and next\n${words(5)}`), { casts: new Set(['up']), steps });
  assert.ok(recap.some((x) => x.includes('the recap has 5 words')));
});

test('casts and sections must agree with the step file and the casts folder', () => {
  const p = problemsOf('03-docker-compose', valid, { casts: new Set(), steps: "export default async ({ section, cast }) => { await section(1); await cast('setup'); };" });
  assert.ok(p.includes('03-docker-compose: cast "up" has no videos/03-docker-compose/casts/up.cast'));
  assert.ok(p.includes('03-docker-compose: steps.js plays cast "setup" which is not in casts:'));
  assert.ok(p.includes('03-docker-compose: steps.js has 1 section() calls, the script 2 sections'));
  assert.ok(problemsOf('04-kyma', valid, { casts: new Set(['up']), steps }).includes('04-kyma: video "03-docker-compose" does not match the folder'));
});

test('target_seconds is a whole number of seconds up to a 15-minute recording', () => {
  const at = (n) => problemsOf('03-docker-compose', valid.replace('target_seconds: 120', `target_seconds: ${n}`), { casts: new Set(['up']), steps })
    .filter((x) => x.includes('target_seconds'));
  assert.deepEqual(at(740), [], 'a 12-minute recording (the clients video) is allowed');
  assert.deepEqual(at(900), []);
  assert.ok(at(901).some((x) => x.includes('must be an integer from 60 to 900')));
  assert.ok(at(59).some((x) => x.includes('must be an integer from 60 to 900')));
});

test('sections recorded from a second steps file count once per number', () => {
  const two = steps + "\nexport const extra = async ({ section }) => { await section(2); };";
  assert.deepEqual(problemsOf('03-docker-compose', valid, { casts: new Set(['up']), steps: two }), []);
});
