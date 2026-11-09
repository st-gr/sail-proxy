#!/usr/bin/env node
// connections.json storage of the standalone CLI: round trip, 0600, atomic write, the refusals, the
// gateway env variable, and the same validation cases the gateway pins (shared fixture).
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-conn-'));
process.env.SAIL_PROXY_CONFIG_DIR = path.join(dir, 'cfg');
const s = require(path.resolve(__dirname, '..', 'dist', 'utils', 'connections-storage.js'));
const { buildGatewayEnv } = require(path.resolve(__dirname, '..', 'dist', 'utils', 'gateway-env.js'));
const file = path.join(process.env.SAIL_PROXY_CONFIG_DIR, 'connections.json');
let f = 0;
function check(name, fn){ try { fn(); console.log('ok - '+name); } catch(e){ f++; console.error('not ok - '+name+'\n  '+e.message); } }
const throwsAt = (fn, p) => { try { fn(); } catch (e) { assert.strictEqual(e.path, p, e.message); return; } assert.fail('did not throw'); };
const conn = (o) => ({ name: 'oa', type: 'openai', secret: 'sk-x', ...o });
const reset = () => fs.rmSync(process.env.SAIL_PROXY_CONFIG_DIR, { recursive: true, force: true });

check('a missing file reads as no connections', () => { reset(); assert.deepStrictEqual(s.readConnections(), { version: 1, connections: [] }); });
check('round trip, no .tmp left, dir created', () => {
  reset();
  const data = { version: 1, connections: [conn({ models: [{ upstreamModel: 'gpt-4o' }] })] };
  s.writeConnections(data);
  assert.deepStrictEqual(s.readConnections(), data);
  assert.deepStrictEqual(fs.readdirSync(process.env.SAIL_PROXY_CONFIG_DIR), ['connections.json']);
});
if (process.platform !== 'win32') check('the file is 0600', () => { s.writeConnections({ version: 1, connections: [] }); assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600); });
check('an invalid file is refused before writing', () => {
  reset();
  throwsAt(() => s.writeConnections({ version: 1, connections: [conn({ name: 'Bad' })] }), 'connections[0].name');
  assert.ok(!fs.existsSync(file));
});
check('a malformed file on disk fails the read with a path', () => {
  reset(); fs.mkdirSync(process.env.SAIL_PROXY_CONFIG_DIR, { recursive: true }); fs.writeFileSync(file, '{nope');
  throwsAt(() => s.readConnections(), '');
});
check('addConnection / duplicate / removeConnection / unknown', () => {
  reset();
  s.addConnection(conn());
  assert.throws(() => s.addConnection(conn()), /already exists/);
  s.addConnection(conn({ name: 'second' }));
  s.removeConnection('oa');
  assert.deepStrictEqual(s.readConnections().connections.map((c) => c.name), ['second']);
  assert.throws(() => s.removeConnection('oa'), /unknown connection/i);
});
check('addModel / duplicate / removeModel / unknown', () => {
  reset();
  s.addConnection(conn());
  s.addModel('oa', { upstreamModel: 'gpt-4o' });
  assert.throws(() => s.addModel('oa', { upstreamModel: 'gpt-4o' }), /already/);
  assert.throws(() => s.addModel('nope', { upstreamModel: 'x' }), /unknown connection/i);
  s.removeModel('oa', 'gpt-4o');
  assert.deepStrictEqual(s.readConnections().connections[0].models, []);
  assert.throws(() => s.removeModel('oa', 'gpt-4o'), /unknown model/i);
});
check('removeConnection returns the model ids it withdrew', () => {
  reset();
  s.addConnection(conn({ models: [{ upstreamModel: 'gpt-4o' }, { upstreamModel: 'gpt-4o-mini' }] }));
  assert.deepStrictEqual(s.removeConnection('oa'), ['gpt-4o--oa', 'gpt-4o-mini--oa']);
});
check('a failed rename leaves no connections.json.tmp behind', () => {
  reset();
  fs.mkdirSync(path.join(file, 'blocker'), { recursive: true }); // renaming a file over a non-empty directory fails
  assert.throws(() => s.writeConnections({ version: 1, connections: [] }));
  assert.ok(!fs.existsSync(`${file}.tmp`), 'stale .tmp left');
});
check('a lock left by a dead writer (older than 30 s) is taken over', () => {
  reset(); fs.mkdirSync(process.env.SAIL_PROXY_CONFIG_DIR, { recursive: true });
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000); fs.utimesSync(lock, old, old);
  s.addConnection(conn());
  assert.deepStrictEqual(s.readConnections().connections.map((c) => c.name), ['oa']);
  assert.ok(!fs.existsSync(lock), 'lock not released');
});
check('a lock held by a live writer refuses the change after waiting', () => {
  reset(); fs.mkdirSync(process.env.SAIL_PROXY_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(`${file}.lock`, '');
  assert.throws(() => s.addConnection(conn()), /another sail-proxy command is changing/i);
  fs.rmSync(`${file}.lock`);
  assert.deepStrictEqual(s.readConnections().connections, []);
});
check('modelIdOf', () => assert.strictEqual(s.modelIdOf('gpt-4o', 'oa'), 'gpt-4o--oa'));
check('buildGatewayEnv sets CONNECTIONS_FILE_PATH beside the config file', () => {
  const env = buildGatewayEnv({}, {}, path.join('/cfg', 'api_config.json'));
  assert.strictEqual(env.CONNECTIONS_FILE_PATH, path.join('/cfg', 'connections.json'));
});
// Concurrent CLI commands each read, change and write the whole file: without the lock one change is lost.
check('concurrent writers keep every change', () => {
  reset(); fs.mkdirSync(process.env.SAIL_PROXY_CONFIG_DIR, { recursive: true });
  const { spawnSync } = require('child_process');
  const storage = path.resolve(__dirname, '..', 'dist', 'utils', 'connections-storage.js');
  const writers = Array.from({ length: 4 }, (_, w) => `const s=require(${JSON.stringify(storage)});for(let i=0;i<15;i++)s.addConnection({name:'w${w}-'+i,type:'openai',secret:'k'});`);
  const script = `const {spawn}=require('child_process');let n=${writers.length},bad=0;`
    + `for(const w of ${JSON.stringify(writers)}){const c=spawn(process.execPath,['-e',w],{stdio:'inherit'});c.on('exit',(code)=>{if(code)bad++;if(--n===0)process.exit(bad)})}`;
  const r = spawnSync(process.execPath, ['-e', script], { env: process.env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(s.readConnections().connections.length, 60);
});
const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'services', 'gateway', 'test', 'fixtures', 'connections-file-cases.json'), 'utf8'));
for (const c of cases) {
  check('shared case: ' + c.name, () => {
    if (c.ok) s.validateConnectionsFile(c.file); else throwsAt(() => s.validateConnectionsFile(c.file), c.path);
    if (c.hidden) { try { s.validateConnectionsFile(c.file); } catch (e) { assert.ok(!e.message.includes(c.hidden), e.message); } }
  });
}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(f ? 1 : 0);
