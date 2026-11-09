#!/usr/bin/env node
/**
 * sync-commits.js replays every file of a commit, whatever its size: a file over Node's 1 MB execSync buffer
 * (a 2.8 MB screenshot) was skipped with a warning while the sync still reported success.
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tool = path.join(__dirname, 'sync-commits.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-commits-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const repo = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
};

try {
  const source = repo('source');
  const dest = repo('dest');
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(source, 'big.bin'), big);
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'add a large file');

  execFileSync('node', [tool, '--source', source, '--dest', dest], { input: 'yes\n', stdio: ['pipe', 'pipe', 'pipe'] });

  assert.strictEqual(git(dest, 'log', '-1', '--format=%s').trim(), 'add a large file');
  assert.ok(fs.existsSync(path.join(dest, 'big.bin')), 'the large file is synced');
  assert.ok(fs.readFileSync(path.join(dest, 'big.bin')).equals(big), 'with its full content');
  assert.strictEqual(git(dest, 'rev-parse', 'HEAD^{tree}'), git(source, 'rev-parse', 'HEAD^{tree}'));
  console.log('sync-commits large file: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
