import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForUsage, usageJobs, backdateUsage } from './usage.mjs';

const fakeClient = (counts) => { let i = 0; return { entity: async () => ({ status: 200, json: { '@odata.count': counts[Math.min(i++, counts.length - 1)] } }) }; };
const keyIds = ['11111111-1111-1111-1111-111111111111'];

test('waits for the count to settle, not merely to reach the number of successful calls', async () => {
  const n = await waitForUsage({ client: fakeClient([3, 5, 7, 7, 7, 7]), keyIds, since: null, expected: 5, log: () => {}, quietMs: 15, stepMs: 10, maxMs: 1000 });
  assert.equal(n, 7);
});

test('the call list: one in five chats on Claude, embeddings and tool calls after', () => {
  const jobs = usageJobs(['a', 'b'], { claude: 'c', cheapChat: 'g', embedding: 'e' }, { chat: 10, embed: 2, tools: 1 });
  assert.equal(jobs.length, 13);
  assert.equal(jobs.filter((j) => j.body.model === 'c').length, 2);
  assert.equal(jobs.filter((j) => j.path === 'embeddings').length, 2);
  assert.ok(jobs.at(-1).body.tools);
});

test('the backdate selects only the listed keys and refuses anything that is not a UUID', () => {
  const sent = [];
  const run = (sql) => { sent.push(sql); return sent.length === 1 ? 'r1\nr2\n' : ''; };
  assert.equal(backdateUsage({ keyIds, since: '2026-10-14T00:00:00Z', log: () => {}, run, now: new Date('2026-10-14T12:00:00Z') }), 2);
  assert.match(sent[0], /WHERE apikey_id IN \('11111111-1111-1111-1111-111111111111'\) AND validfrom >= /);
  assert.match(sent[1], /^BEGIN;\nUPDATE .* WHERE id = 'r1';\nUPDATE .* WHERE id = 'r2';\nCOMMIT;\n$/);
  assert.throws(() => backdateUsage({ keyIds: ["x' OR 1=1 --"], since: 'x', log: () => {}, run }), /UUID/);
});
