#!/usr/bin/env node
const assert = require('assert');
const path = require('path');
const { resolveBinary } = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'which.js'));
let f = 0;
function check(name, fn){ try { fn(); console.log('ok - '+name); } catch(e){ f++; console.error('not ok - '+name+'\n  '+e.message); } }

check('resolveBinary finds node on PATH', () => {
  const p = resolveBinary('node', 'hint');
  assert.ok(typeof p === 'string' && p.length > 0);
});
check('resolveBinary throws with the install hint for a missing binary', () => {
  assert.throws(
    () => resolveBinary('definitely-not-a-real-binary-xyz123', 'install me'),
    /install me/
  );
});
process.exit(f ? 1 : 0);
