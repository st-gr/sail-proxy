import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMappings } from './grant-identities.mjs';

const stock = '{"admin@example.com":"admin","user@example.com":"user"}';
const env = `LOCAL_USER_MAPPING=${stock}\nCOOKIE_SECRET=abc\nROLE_MAPPING=${stock}\n`;
const ids = {
  admin: { email: 'mara@example.com' },
  users: [{ email: 'a@example.com' }, { email: 'b@example.com' }, { email: 'c@example.com' }]
};
const parse = (text, key) => JSON.parse(new RegExp(`^${key}=(.*)$`, 'm').exec(text)[1]);

test('both mappings gain the four identities and keep the stock entries', () => {
  const out = mergeMappings(env, ids);
  for (const key of ['LOCAL_USER_MAPPING', 'ROLE_MAPPING']) {
    assert.deepEqual(parse(out, key), {
      'admin@example.com': 'admin', 'user@example.com': 'user',
      'mara@example.com': 'admin', 'a@example.com': 'user', 'b@example.com': 'user', 'c@example.com': 'user'
    });
  }
  assert.ok(out.includes('COOKIE_SECRET=abc\n'));
});

test('is idempotent, existing entries win and a missing line is appended', () => {
  const once = mergeMappings(env, ids);
  assert.equal(mergeMappings(once, ids), once);
  const kept = mergeMappings('ROLE_MAPPING={"a@example.com":"admin"}\n', ids);
  assert.equal(parse(kept, 'ROLE_MAPPING')['a@example.com'], 'admin');
  assert.ok(/^LOCAL_USER_MAPPING=/m.test(kept));
});
