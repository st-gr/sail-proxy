import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problemsOf } from './check-videos.mjs';

const entry = (over = {}) => ({ id: '03-docker-compose', title: 'Deploy with Docker Compose', subtitle: 's', targetSeconds: 300, youtubeId: null, duration: 0, vtt: false, poster: false, chapters: [{ t: null, title: 'Introduction' }, { t: null, title: 'What you get' }], ...over });
const script = { meta: { title: 'Deploy with Docker Compose', sections: [{ n: 1, title: 'What you get' }] } };
const page = '## Deploy with Docker Compose\n<VideoEmbed video="03-docker-compose" />\n';

test('a consistent catalogue has no problems', () => {
  assert.deepEqual(problemsOf({ catalog: [entry()], scripts: { '03-docker-compose': script }, page, exists: () => true }), []);
});

test('ids, titles, chapters, flags and the page are checked', () => {
  const p = problemsOf({
    catalog: [entry({ id: 'bad id', youtubeId: 'short', duration: -1, vtt: true, poster: true, chapters: [{ t: 5, title: 'Introduction' }, { t: 2, title: 'Other' }] }), entry({ id: '04-kyma' })],
    scripts: { 'bad id': script }, page: '', exists: () => false
  });
  assert.ok(p.includes('bad id: id must look like 03-docker-compose'));
  assert.ok(p.includes('bad id: youtubeId must be 11 characters or null'));
  assert.ok(p.includes('bad id: duration must be a whole number of seconds, 0 or more'));
  assert.ok(p.includes('bad id: the first chapter must start at 0'));
  assert.ok(p.includes('bad id: chapter times must ascend'));
  assert.ok(p.includes('bad id: chapters after Introduction must match the script sections (What you get)'));
  assert.ok(p.includes('bad id: vtt is set but docs/public/videos/bad id.vtt is missing'));
  assert.ok(p.includes('bad id: poster is set but docs/public/videos/bad id.jpg is missing'));
  assert.ok(p.includes('bad id: not embedded in guide/videos.md'));
  assert.ok(p.includes('04-kyma: not embedded in guide/videos.md'));
  assert.ok(p.includes('duplicate title "Deploy with Docker Compose"'));
});

test('a script folder without a catalogue entry is an orphan', () => {
  const p = problemsOf({ catalog: [entry()], scripts: { '03-docker-compose': script }, page, exists: () => true, folders: ['03-docker-compose', '09-typo'] });
  assert.deepEqual(p, ['orphan script folder 09-typo']);
});

test('a produced entry needs its script, an unproduced one may lack it', () => {
  const run = (over) => problemsOf({ catalog: [entry(over)], scripts: {}, page, exists: () => true, folders: [] });
  assert.deepEqual(run({}), []);
  for (const over of [{ duration: 120 }, { vtt: true }, { poster: true }, { youtubeId: 'abcdefghijk' }]) assert.deepEqual(run(over), ['03-docker-compose: no script']);
});
