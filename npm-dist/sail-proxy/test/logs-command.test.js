#!/usr/bin/env node
// `sail-proxy logs`: tail, --since, clear against a gateway console log file. No gateway, no network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-logs-'));
process.env.SAIL_PROXY_CONFIG_DIR = dir;
const { readLogs, clearLogs } = require('../dist/utils/log-manager');

const logFile = path.join(dir, 'logs', 'gateway.log');
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const H = 60 * 60 * 1000;
const line = (ts, text) => `${ts} [gateway-1-abc] INFO  [chatController] ${text} {"status":200}`;

const lines = [
  line(ago(5 * H), 'old one'),
  line(ago(4 * H), 'old two'),
  line(ago(3 * H), 'old three'),
  line(ago(10 * 60 * 1000), 'recent four'),
  line(ago(60 * 1000), 'recent five'),
];

const write = (content) => { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, content); };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
async function capture(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(strip(a.join(' ')));
  try { await fn(); } finally { console.log = orig; }
  return out;
}

(async () => {
  try {
    write(lines.join('\n') + '\n');

    // --tail keeps the last N lines
    let out = await capture(() => readLogs('gateway', { tail: 2 }));
    assert.deepStrictEqual(out, [lines[3], lines[4]], 'tail 2 prints the last two lines');

    // --since keeps the recent lines and drops the older ones
    out = await capture(() => readLogs('gateway', { since: '1h' }));
    assert.deepStrictEqual(out, [lines[3], lines[4]], 'since 1h prints the two recent lines');
    assert.ok(!out.some((l) => l.includes('old')), 'no older line');

    // a line without a timestamp is kept by --since
    write([lines[0], 'continuation without a timestamp', lines[4]].join('\n') + '\n');
    out = await capture(() => readLogs('gateway', { since: '1h' }));
    assert.deepStrictEqual(out, ['continuation without a timestamp', lines[4]], 'untimestamped line kept, old line dropped');

    // clearLogs empties the file (removes it; a later read finds no logs)
    write(lines.join('\n') + '\n');
    clearLogs('gateway');
    assert.ok(!fs.existsSync(logFile) || fs.readFileSync(logFile, 'utf8') === '', 'the log file is empty or gone');
    out = await capture(() => readLogs('gateway', { tail: 5 }));
    assert.ok(out.length === 1 && /No logs found/.test(out[0]), `nothing left to read: ${out}`);

    console.log('logs-command: ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
