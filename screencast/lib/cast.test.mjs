import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrub, scrubEvents, coalesce, serialize, castText, castSeconds, keys, resolveSend, castHeader, verify, unwrapped, secretsEnv, maskRedraw, recordCast, blankEvents, MASK as MASK_TEXT } from './cast.mjs';

const KEY = 'sk-' + 'live' + '0123456789abcdefghijklmn';
const LONG = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo' + 'wMTIzNDU2Nzg5YWJjZGVmZ2hpams=';

test('scrub applies the map, then masks labelled secrets, key values and long tokens', () => {
  assert.equal(scrub('host real.example.internal up', { 'real.example.internal': 'sail.example.com' }), 'host sail.example.com up');
  assert.equal(scrub('OAUTH2_PROXY_COOKIE_SECRET=abcdefgh12345678', {}), 'OAUTH2_PROXY_COOKIE_SECRET=••••••••');
  assert.equal(scrub('  Client Secret: ******** done', {}), '  Client Secret: •••••••• done');
  assert.equal(scrub(`Bearer ${KEY}`, {}), 'Bearer sk-demo-00000000000000000000');
  assert.equal(scrub(`KYMA_DEPLOY_CONFIG=${LONG}`, {}), 'KYMA_DEPLOY_CONFIG=<redacted>');
  assert.equal(scrub(`blob ${LONG} end`, {}), 'blob <redacted> end');
  assert.equal(scrub('secret/gateway-env created', {}), 'secret/gateway-env created');
  assert.equal(scrub('Status: Running  Health: Healthy', {}), 'Status: Running  Health: Healthy');
  assert.equal(scrub('pod gateway-7d9f8b6c5d-x2k9q 1/1 Running', {}), 'pod gateway-7d9f8b6c5d-x2k9q 1/1 Running');
  // A label never reaches over a line break, and a bracketed placeholder or a rule line is not a value.
  assert.equal(scrub('All security tokens validated\r\n\r\n=====================', {}), 'All security tokens validated\r\n\r\n=====================');
  assert.equal(scrub('   - Password: [User-provided password]', {}), '   - Password: [User-provided password]');
  assert.equal(scrub('   - Password: abcdefgh12345678', {}), '   - Password: ••••••••');
  // Only a bracketed run with a space and an all-= run are exempt; any other value starting with [ or = is masked.
  assert.equal(scrub('Password: [' + 'hunter2' + 'hunter2]', {}), 'Password: ••••••••');
  assert.equal(scrub('TOKEN==' + 'hunter2' + 'hunter2x', {}), 'TOKEN=••••••••');
  // …while a real labelled value is still masked.
  const pw = 'hunter2' + 'hunter2';
  assert.equal(scrub(`PASSWORD=${pw}`, {}), 'PASSWORD=••••••••');
  assert.equal(scrub('token: ' + 'abcdefgh' + '12345678', {}), 'token: ••••••••');
});

test('the label rule leaves colour codes, local URLs and the sail-proxy command alone and still masks a secret', () => {
  assert.equal(scrub('\x1b[1mAPI Keys:\x1b[22m\x1b[39m\r\n=========', {}), '\x1b[1mAPI Keys:\x1b[22m\x1b[39m\r\n=========');
  assert.equal(scrub('  • API Keys: \x1b[39mhttp://localhost:3100/api/admin/api-keys', {}), '  • API Keys: \x1b[39mhttp://localhost:3100/api/admin/api-keys');
  assert.equal(scrub('  - Create an API key: \x1b[39m\x1b[36msail-proxy apikey create "my-app"', {}), '  - Create an API key: \x1b[39m\x1b[36msail-proxy apikey create "my-app"');
  const secret = 'real-' + 'secret-' + '123';
  assert.equal(scrub(`Client Secret: \x1b[39m${secret}`, {}), 'Client Secret: \x1b[39m••••••••');
  // verify reuses the rule: the unscrubbed line is refused, the harmless ones pass.
  assert.ok(verify([[0, `Client Secret: \x1b[39m${secret}\r\n`]], {}).includes('labelled secret'));
  assert.deepEqual(verify([[0, '\x1b[1mAPI Keys:\x1b[22m\x1b[39m\r\n=========\r\n  • API Keys: \x1b[39mhttp://localhost:3100/api/admin/api-keys\r\n']], {}), []);
});

test('coalesce joins chunks that arrive within the gap and keeps the first timestamp', () => {
  const ev = coalesce([[0.1, 'a'], [0.12, 'b'], [0.2, 'c'], [1.0, 'd']], 50);
  assert.deepEqual(ev, [[0.1, 'ab'], [0.2, 'c'], [1.0, 'd']]);
  // chained, not anchored: each chunk is within the gap of the one before, so the burst is one event
  assert.deepEqual(coalesce([[0, 'a'], [0.03, 'b'], [0.06, 'c'], [0.09, 'd']], 50), [[0, 'abcd']]);
});

test('a long token split over chained chunks is one event after coalesce and masked after scrubEvents', () => {
  const chunks = [[0, 'KYMA_DEPLOY_CONFIG='], [0.03, LONG.slice(0, 30)], [0.06, LONG.slice(30) + '\r\n']];
  const ev = coalesce(chunks, 50);
  assert.equal(ev.length, 1);
  assert.deepEqual(scrubEvents(ev, {}), [[0, 'KYMA_DEPLOY_CONFIG=<redacted>\r\n']]);
});

test('scrubEvents masks a secret split across events 200 ms apart, replacement first, remainder removed', () => {
  const out = scrubEvents([[0, 'COOKIE_SECRET=abcd'], [0.2, 'efgh12345678\r\n']], {});
  assert.deepEqual(out, [[0, 'COOKIE_SECRET=••••••••'], [0.2, '\r\n']]);
  assert.deepEqual(scrubEvents([[0, 'host real.exa'], [0.3, 'mple.internal up']], { 'real.example.internal': 'sail.example.com' }), [[0, 'host sail.example.com'], [0.3, ' up']]);
  const single = ['pod', 'a1b2c3d4' + 'e5f60718', 'key', KEY, [10, 1, 2, 3].join('.'), 'Secret: abcdefgh12'].join(' ');
  assert.equal(scrubEvents([[0, single]], { x: 'y' })[0][1], scrub(single, { x: 'y' }), 'one event behaves as scrub');
});

test('a typed value echoed character by character is replaced by its show text and verify passes', () => {
  const value = 'zebra-quartz-nine';
  const events = [[0, 'pw: '], ...[...value].map((c, i) => [0.1 + i * 0.083, c]), [2, '\r\n']];
  const extra = [[value, 'PW']];
  const out = scrubEvents(events, {}, extra);
  assert.equal(castText(out), 'pw: PW\r\n');
  assert.deepEqual(verify(out, {}, extra), []);
  assert.deepEqual(verify(events, {}, extra), ['typed value']);
});

test('verify refuses a long token and an unmasked labelled secret in the joined text', () => {
  assert.ok(verify([[0, 'a '], [0.2, LONG]], {}).includes('long token'));
  assert.ok(verify([[0, 'COOKIE_SECRET=abcd'], [0.2, 'efgh1234']], {}).includes('labelled secret'));
  assert.deepEqual(verify([[0, 'COOKIE_SECRET=••••••••']], {}), []);
});

test('serialize writes asciicast v2 with rounded times and castSeconds reads the last one back', () => {
  const text = serialize(castHeader({ cols: 100, rows: 28, title: 't' }), [[0, '$ '], [1.23456, 'x\r\n']]);
  const lines = text.trimEnd().split('\n');
  assert.equal(JSON.parse(lines[0]).version, 2);
  assert.equal(JSON.parse(lines[0]).width, 100);
  assert.equal(JSON.parse(lines[0]).idle_time_limit, 2);
  assert.deepEqual(JSON.parse(lines[2]), [1.235, 'o', 'x\r\n']);
  assert.equal(castSeconds(text), 1.235);
  assert.equal(castText([[0, 'a'], [1, 'b']]), 'ab');
});

test('keys turns key names into control sequences and resolveSend reads the environment', () => {
  assert.equal(keys('y<enter>'), 'y\r');
  assert.equal(keys('<down><down><enter>'), '\x1b[B\x1b[B\r');
  assert.equal(keys('<ctrl-c>'), '\x03');
  assert.equal(resolveSend({ env: 'DOCS_TEST_VALUE' }, { DOCS_TEST_VALUE: 'v' }), 'v');
  assert.throws(() => resolveSend({ env: 'DOCS_MISSING' }, {}, () => ({})), /DOCS_MISSING is not set/);
  assert.equal(resolveSend({ env: 'DOCS_FILE_VALUE' }, {}, () => ({ DOCS_FILE_VALUE: 'f' })), 'f', 'the secrets file is the fallback');
  assert.equal(resolveSend('plain', {}), 'plain');
});

test('verify refuses a cast whose joined text still holds a real value, even across two events', () => {
  const map = { 'real-secret-value': 'mock' };
  assert.deepEqual(verify([[0, 'ok']], map), []);
  assert.deepEqual(verify([[0, 'real-secr'], [0.2, 'et-value']], map), ['map entry shown as "mock"']);
  assert.ok(verify([[0, `k ${KEY}`]], {}).includes('api key'));
});

test('verify refuses a value that a line wrap split, and passes a clean wrapped command', () => {
  // readline wraps a long command line at the terminal edge: the echo carries "\r\n" (or " \r") and escape
  // sequences inside the value. With cols = 20 the wrapped line is exactly 20 characters long.
  const cols = 20;
  const edge = (prefix, v) => { const at = cols - prefix.length; return `${prefix}${v.slice(0, at)}\r\n${v.slice(at)}`; };
  assert.equal(edge('$ Bearer ', KEY).split('\r\n')[0].length, cols);
  assert.ok(verify([[0, `${edge('$ Bearer ', KEY)}\r\n`]], {}, [], cols).includes('api key'));
  assert.ok(verify([[0, `$ curl -H "Bearer ${KEY.slice(0, 7)} \r\x1b[K${KEY.slice(7)}"`]], {}).includes('api key'));
  assert.ok(verify([[0, `$ curl -H "Bearer ${KEY.slice(0, 9)} \b${KEY.slice(9)}"`]], {}).includes('api key'));
  assert.ok(verify([[0, `$ curl -H "Bearer ${KEY.slice(0, 9)}  \b\b${KEY.slice(9)}"`]], {}).includes('api key'));
  const typedValue = 'zebra-quartz-nine';
  assert.deepEqual(verify([[0, `${edge('pw: ', typedValue)}\r\n`]], {}, [[typedValue, 'PW']], cols), ['typed value']);
  // A line that ends before the edge is not joined: the value split there is two ordinary lines.
  assert.deepEqual(verify([[0, `pw: zebra-\r\nquartz-nine\r\n`]], {}, [[typedValue, 'PW']], cols), []);
  const clean = `$ curl -s http://localhost:8080/gateway/openai/v1/chat/completions -H "Authorization: Bearer sk-demo-${'0'.repeat(20)}" -d '{"model": "gpt-5-mini"}'`;
  assert.deepEqual(verify([[0, `${clean.slice(0, 100)}\r\n${clean.slice(100)}\r\n`]], {}), []);
  assert.equal(unwrapped('a\x1b[31mb\x1b[0m \rc\x1b]0;t\x07d'), 'abcd');
  assert.equal(unwrapped('ab\r\ncd', 2), 'abcd');
  assert.equal(unwrapped('ab\r\ncd', 3), 'ab\ncd');
});

test('unwrapped joins only at the edge: whole rows, the wrap space, and non-ASCII lines from one column short', () => {
  assert.equal(unwrapped(`${'x'.repeat(150)}\r\nnext`, 100), `${'x'.repeat(150)}\nnext`);
  assert.equal(unwrapped(`${'x'.repeat(200)}\r\nnext`, 100), `${'x'.repeat(200)}next`);
  // An emoji is one code point but two columns: the probe's 19 counted columns reach the edge of 20.
  const typedValue = 'zebra-quartz-nine';
  const probe = `\u{1F511} pw: ${typedValue.slice(0, 13)}\r\n${typedValue.slice(13)}\r\n`;
  assert.equal([...probe.split('\r\n')[0]].length, 19);
  assert.deepEqual(verify([[0, probe]], {}, [[typedValue, 'PW']], 20), ['typed value']);
});

test('verify passes ordinary adjacent output lines that only a full join would turn into a finding', () => {
  const lines = (...l) => [[0, l.join('\r\n') + '\r\n']];
  assert.deepEqual(verify(lines('Auth URL: https://auth.example.sap/oauth/token', 'Client ID: sb-demo-client', 'Client Secret: \u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022', 'SAP AI Region: eu10'), {}), []);
  assert.deepEqual(verify(lines('  \u2022 OpenRouter: http://localhost:3100/openrouter/api/v1/chat/completions', 'Embeddings:'), {}), []);
  assert.deepEqual(verify(lines('\u2713 New API Key:', '  sk-demo-00000000000000000000'), {}), []);
  assert.deepEqual(verify(lines('session id: 01a13c49-3f8e-78c1-a6f9-42f54415813b', '--------'), {}), []);
});

test('a labelled exemption covers the whole value: sail-proxy-anything and a URL with credentials are masked', () => {
  assert.equal(scrub('Password: sail-proxy-' + 'abcdefghijkl', {}), 'Password: ••••••••');
  assert.equal(scrub('Token: http://localhost:3100@' + 'evil.com', {}), 'Token: ••••••••');
  assert.equal(scrub('Token: http://localhost:3100/x@' + 'evil.com', {}), 'Token: ••••••••');
  assert.equal(scrub('• API Keys: http://localhost:3100/api/admin/api-keys', {}), '• API Keys: http://localhost:3100/api/admin/api-keys');
  // a query or a fragment ends the exemption: a short secret in it stays masked
  assert.equal(scrub('Token: http://localhost:3100/cb?code=' + 'abc123', {}), 'Token: ••••••••');
  assert.equal(scrub('Token: http://127.0.0.1:4004/cb#t=' + 'abc123', {}), 'Token: ••••••••');
  assert.equal(scrub('Create an API key: sail-proxy apikey create "my-app"', {}), 'Create an API key: sail-proxy apikey create "my-app"');
  assert.ok(verify([[0, 'Password: sail-proxy-' + 'abcdefghijkl\n']], {}).includes('labelled secret'));
});

test('typed values are applied longest first, so a value that is a prefix of another is fully masked', () => {
  const out = scrubEvents([[0, 'a hunter2hunter2 b hunter2 c']], {}, [['hunter2', 'SHORT'], ['hunter2hunter2', 'LONG']]);
  assert.equal(castText(out), 'a LONG b SHORT c');
});

test('secretsEnv reads KEY=value lines, strips one pair of quotes and refuses a file that is not mode 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
  const file = join(dir, 'secrets.env');
  try {
    writeFileSync(file, ['# comment', 'A_B=plain', 'C="double quoted"', "D='single quoted'", 'E="unbalanced', 'F=\'mixed"', 'G="a"b"', 'lower=x', ''].join('\n'));
    chmodSync(file, 0o644);
    assert.throws(() => secretsEnv(file), /must be mode 600/);
    chmodSync(file, 0o600);
    assert.deepEqual(secretsEnv(file), { A_B: 'plain', C: 'double quoted', D: 'single quoted', E: '"unbalanced', F: '\'mixed"', G: 'a"b' });
    assert.deepEqual(secretsEnv(join(dir, 'missing.env')), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a value redrawn whole on every key has each echoed prefix replaced by the same share of its show text', () => {
  // built at run time: the secret gate refuses an address outside 203.0.113.0/24 in a committed file
  const real = ['198', '51', '100', '23/32'].join('.'); const shown = '203.0.113.7/32';
  const line = (v, n = v.length) => `\x1b[2K\x1b[G\x1b[32m?\x1b[39m \x1b[1mIP allowlist (e.g. 203.0.113.12/32):\x1b[22m\x1b[0m \x1b[0m${v}\x1b[${44 + n}D\x1b[${44 + n}C`;
  const out = [...real].map((_, i) => maskRedraw(line(real.slice(0, i + 1)), { real, shown, k: i + 1 }));
  assert.ok(out.every((o) => o.includes('e.g. 203.0.113.12/32')), 'the prompt text and the escape codes stay');
  assert.equal(out[out.length - 1], line(shown, real.length));
  assert.ok(!out.join('').includes(real.slice(0, 12)));
  // a chunk holding two redraws (coalesced) and a redraw lagging two keys are masked too; a surviving prefix of 4 or more is a miss
  const share = (j) => shown.slice(0, Math.round((j * shown.length) / real.length));
  assert.equal(maskRedraw(line('198.5') + line('198.51'), { real, shown, k: 6 }), line(share(5), 5) + line(share(6), 6));
  assert.equal(maskRedraw(line('198.5'), { real, shown, k: 7 }), line(share(5), 5));
  assert.equal(maskRedraw(line('1'), { real, shown, k: 1 }), line('1'), 'a one-character prefix is left alone');
  assert.ok(verify([[0, line('198.5')]], {}, [[real, shown, true]]).includes('typed value'));
  assert.ok(verify([[0, line('198.')]], {}, [[real, shown, true]]).includes('typed value'));
  // a redraw that lags one key behind is masked too
  assert.equal(maskRedraw(line('198.5'), { real, shown, k: 6 }), line(shown.slice(0, Math.round((5 * shown.length) / real.length)), 5));
  const events = out.map((o, i) => [i * 0.1, o]);
  assert.deepEqual(verify(events, {}, [[real, shown, true]]), []);
  assert.ok(verify([[0, line('198.51.100')]], {}, [[real, shown, true]]).includes('typed value'), 'an unmasked prefix from half the length on is a miss');
});

test('a cast that fails waiting for a prompt hands the output so far to the operator', async () => {
  const err = await recordCast({ cols: 80, rows: 10, env: { HOME: tmpdir() }, commands: [{ cmd: 'echo partial-out; sleep 5', input: [{ waitFor: 'never-shown', send: 'x', timeoutMs: 1500 }] }] }).then(() => null, (e) => e);
  assert.match(err.message, /timeout after 1500 ms waiting for "never-shown"/);
  assert.ok(castText(err.raw).includes('partial-out'));
});

test('a masked prompt that redraws its asterisks on every key: the label sees through code blank code, the reader view splits erased lines', () => {
  const line = (n) => `\x1b[2K\x1b[G\x1b[32m?\x1b[39m \x1b[1mDocker registry password/token:\x1b[22m\x1b[0m \x1b[0m${'*'.repeat(n)}\x1b[${40 + n}D\x1b[${40 + n}C`;
  assert.equal(scrub(line(12), {}), line(0).replace('\x1b[40D', `${MASK_TEXT}\x1b[52D`).replace('\x1b[40C', '\x1b[52C'));
  const events = Array.from({ length: 40 }, (_, i) => [i * 0.08, line(i + 1)]);
  assert.deepEqual(verify(scrubEvents(events, {}), {}), []);
  assert.equal(unwrapped('ab\x1b[2K\x1b[Gcd'), 'ab\ncd');
  // a real value after code blank code is masked as before
  assert.equal(scrub('Client Secret:\x1b[22m \x1b[0mabcdefgh12345678', {}), `Client Secret:\x1b[22m \x1b[0m${MASK_TEXT}`);
});

test('the command logged to the operator console is scrubbed like the cast', async () => {
  const lines = [];
  await recordCast({ cols: 80, rows: 10, env: { HOME: tmpdir() }, commands: ['echo real-host-x'] }, { map: { 'real-host-x': 'demo-host' }, log: (l) => lines.push(l) });
  assert.deepEqual(lines, ['cmd: echo demo-host']);
});

import { outputMatches } from './cast.mjs';

test('a waitFor matches output a TUI colours or positions in pieces, raw or with the escape codes removed', () => {
  const tui = 'Hel\x1b[38;5;45mlo, \x1b[0m\x1b[1mSAP\x1b[22m!\x1b[?25h';
  assert.equal(outputMatches(tui, 'Hello, SAP!'), true);
  assert.equal(outputMatches(tui, /Hello, SAP!/), true);
  assert.equal(outputMatches('Do you want\x1b]0;title\x07 to make this edit', 'Do you want to make this edit'), true);
  assert.equal(outputMatches('\x1b[2Jplain text', 'plain text'), true);
  assert.equal(outputMatches(tui, 'Hello, World!'), false);
});

test('an input step with pauseMs waits that long after its waitFor before it types (time to read a TUI result)', async () => {
  const cast = await recordCast({ cols: 80, rows: 10, env: { HOME: tmpdir() }, commands: [{ cmd: 'echo ready; read x; echo got-$x', input: [{ waitFor: 'ready', pauseMs: 1500, send: 'y<enter>' }] }] });
  const t = (text) => cast.events.find(([, s]) => s.includes(text))?.[0];
  assert.ok(t('got-y') - t('ready') >= 1.4, `the reply came ${t('got-y') - t('ready')} s after the prompt`);
});

test('a waitFor matches text whose spaces a TUI draws as cursor moves', () => {
  const claude = 'Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cmake\x1b[1Cthis\x1b[1Cedit\x1b[1Cto\x1b[1Cindex.js?';
  assert.equal(outputMatches(claude, 'Do you want to make this edit'), true);
  assert.equal(outputMatches(claude, /want to make/), true);
  // the whitespace-blind string comparison still needs the characters in order
  assert.equal(outputMatches('Doyouwanttomakethisedit', 'Do you want to make this edit'), true);
  assert.equal(outputMatches(claude, 'Do you want to proceed'), false);
});

test('keys sends Ctrl+P Ctrl+Q, the sequence that detaches from an OpenShell sandbox without ending it', () => {
  assert.equal(keys('<ctrl-p><ctrl-q>'), '\x10\x11');
});

test('blankEvents overwrites a pattern in recorded events with as many spaces, and serialize keeps the result', () => {
  const ev = [[1, '\x1b[33m●\x1b[3GStreaming oops. If this \r\x1b[1Bkeeps happening, stop.\x1b[39m'], [3, 'fine']];
  const out = blankEvents(ev, [/●(?=\x1b\[3GStreaming)/, /Streaming oops[^\r\x1b]*/, /keeps happening[^\r\x1b]*/]);
  assert.deepEqual(out[0], [1, '\x1b[33m \x1b[3G' + ' '.repeat('Streaming oops. If this '.length) + '\r\x1b[1B' + ' '.repeat('keeps happening, stop.'.length) + '\x1b[39m']);
  assert.deepEqual(out[1], ev[1]);
  assert.equal(blankEvents(ev, []), ev);
  // the cast file carries the blanked text, not the event kind
  assert.equal(JSON.parse(serialize({ version: 2 }, out).split('\n')[2])[2], 'fine');
});

test('blankEvents keeps escape sequences inside a match, so a redraw with cursor jumps is blanked in place', () => {
  const ev = [[1, 'a\x1b[38;5;220m●\x1b[3GStreaming \x1b[23Gnded\x1b[39m b']];
  assert.deepEqual(blankEvents(ev, [/\x1b\[38;5;220m[\s\S]*?\x1b\[39m/]), [[1, 'a\x1b[38;5;220m \x1b[3G          \x1b[23G    \x1b[39m b']]);
});

// Ink-style clients (Claude Code) draw a space as a cursor move right (ESC [n C); unwrapped() must read it as n
// spaces, or a plain sentence fuses into one "long token" and the cast is refused.
test('unwrapped reads a cursor move right as spaces, so prose drawn with cursor moves is no long token', () => {
  const prose = ['is', 'the', 'current', 'Active', 'LTS', 'version', 'as', 'of', 'October', '2026'].join('\x1b[1C');
  assert.equal(unwrapped(prose, 110), 'is the current Active LTS version as of October 2026');
  assert.equal(unwrapped('a\x1b[3Cb', 110), 'a   b');
  assert.deepEqual(verify([[0, prose]], {}, [], 110), []);
  // A real token is still refused, also when it is printed in colour.
  assert.ok(verify([[0, `key \x1b[38;5;246m${LONG}\x1b[39m`]], {}, [], 110).includes('long token'));
});

// Ink also positions words by column (ESC [n G) and skips the space cell between them; unwrapped() pads to the
// column, so the sentence keeps its spaces and the gate stays as strict as before.
test('unwrapped pads a move to a column with spaces, so prose positioned word by word is no long token', () => {
  const placed = '\r\x1b[2Cshows\x1b[9Gboth\x1b[14Gthe\x1b[18Goriginal\x1b[27Gmessage\x1b[35Gand\x1b[39Gthe\x1b[43Ggreeting.';
  assert.equal(unwrapped(placed, 110), '  shows both the original message and the greeting.');
  assert.deepEqual(verify([[0, placed]], {}, [], 110), []);
  // A digit-free run of 40 letters printed in one piece is still a long token.
  assert.ok(verify([[0, `x ${'a'.repeat(44)} y`]], {}, [], 110).includes('long token'));
  // A real token positioned at a column is still refused.
  assert.ok(verify([[0, `key\x1b[10G${LONG}`]], {}, [], 110).includes('long token'));
});
