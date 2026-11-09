#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs'); const path = require('path');
const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js'));
let failed = 0;
for (const f of files) {
  process.stdout.write(`# ${f}\n`);
  try { execFileSync('node', [path.join(dir, f)], { stdio: 'inherit' }); }
  catch { failed++; }
}
console.log(failed ? `# ${failed} test file(s) failed` : '# all test files passed');
process.exit(failed ? 1 : 0);
