import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { zipSync, strToU8 } from 'fflate';

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLog }));

const pack = (id: string, version: string, manifestExtra: Record<string, unknown> = {}) =>
  zipSync({
    'manifest.json': strToU8(JSON.stringify({ id, version, runtime: 'node', gateway: '*', help: { en: { summary: 's' } }, ...manifestExtra })),
    'index.js': strToU8('module.exports = [];'),
  });
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const logged = () => [...mockLog.error.mock.calls, ...mockLog.warn.mock.calls, ...mockLog.info.mock.calls].map(c => c.join(' ')).join('\n');

describe('folder source', () => {
  // Imported here, not at the top: the admin suite below resets the module registry.
  const { createFolderSource } = require('../src/pluginInstall/folderSource');
  let dir: string;
  const put = (name: string, content: Uint8Array | string) => fs.writeFileSync(path.join(dir, name), content);

  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-folder-'))); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists the valid zip and logs everything else in the folder', async () => {
    const good = pack('goodPlugin', '1.2.0');
    put('good.zip', good);
    put('.DS_Store', 'junk');
    put('corrupt.zip', 'this is not a zip');
    put('badmanifest.zip', pack('bad id with spaces', '1.0.0'));
    fs.mkdirSync(path.join(dir, 'folder.zip'));
    fs.mkdirSync(path.join(dir, 'sub'));
    put(path.join('sub', 'nested.zip'), pack('nestedPlugin', '1.0.0'));

    const { wanted, unreadable } = await createFolderSource(dir).list();

    expect(wanted).toEqual([{ id: 'goodPlugin', version: '1.2.0', sha256: sha(good) }]);
    // A zip that cannot be used counts; junk that is not a zip does not.
    expect(unreadable.map((u: { name: string }) => u.name)).toEqual(['badmanifest.zip', 'corrupt.zip']);
    const text = logged();
    for (const name of ['.DS_Store', 'corrupt.zip', 'badmanifest.zip', 'folder.zip', 'sub']) expect(text).toContain(name);
  });

  it('fetches the bytes of the listed zip', async () => {
    const good = pack('goodPlugin', '1.2.0');
    put('good.zip', good);
    const source = createFolderSource(dir);
    const { wanted: [wanted] } = await source.list();
    expect(Buffer.from(await source.fetch(wanted)).equals(Buffer.from(good))).toBe(true);
  });

  it('rejects a fetch for something it did not list', async () => {
    await expect(createFolderSource(dir).fetch({ id: 'x', version: '1.0.0', sha256: 'a' })).rejects.toThrow(/x/);
  });

  it('takes the higher semver of two zips of one id, comparing versions as semver, and logs it', async () => {
    const newer = pack('dupPlugin', '1.10.0');
    put('a-old.zip', pack('dupPlugin', '1.9.0'));
    put('b-new.zip', newer);
    put('c-older.zip', pack('dupPlugin', '1.2.0'));
    const source = createFolderSource(dir);
    expect(await source.list()).toEqual({ wanted: [{ id: 'dupPlugin', version: '1.10.0', sha256: sha(newer) }], unreadable: [] });
    expect(logged()).toMatch(/a-old\.zip/);
    expect(logged()).toMatch(/c-older\.zip/);
    expect(Buffer.from(await source.fetch((await source.list()).wanted[0])).equals(Buffer.from(newer))).toBe(true);
  });

  it('picks by file name when two zips hold the same version, so the answer does not depend on directory order', async () => {
    const first = pack('dupPlugin', '1.0.0', { settings: { schema: {}, defaults: { a: 1 } } });
    put('a.zip', first);
    put('b.zip', pack('dupPlugin', '1.0.0', { settings: { schema: {}, defaults: { a: 2 } } }));
    expect((await createFolderSource(dir).list()).wanted).toEqual([{ id: 'dupPlugin', version: '1.0.0', sha256: sha(first) }]);
  });

  it('a missing folder is an empty list', async () => {
    await expect(createFolderSource(path.join(dir, 'nope')).list()).resolves.toEqual({ wanted: [], unreadable: [] });
  });

  it('a path that cannot be read as a folder rejects rather than reading as empty', async () => {
    put('file', 'x');
    await expect(createFolderSource(path.join(dir, 'file')).list()).rejects.toThrow();
  });

  it('skips a zip over the package limit without reading it into memory', async () => {
    const big = path.join(dir, 'big.zip');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 20 * 1024 * 1024 + 1);
    const { wanted, unreadable } = await createFolderSource(dir).list();
    expect(wanted).toEqual([]);
    expect(unreadable.map((u: { name: string }) => u.name)).toEqual(['big.zip']);
    expect(logged()).toContain('big.zip');
  });

  describe('with the sync: a zip that cannot be used never removes an installed plugin', () => {
    const { syncPlugins } = require('../src/pluginInstall/sync');
    let plugins: string;
    const opts = () => ({ pluginsDir: plugins, gatewayVersion: '1.0.0', unpackAllowed: true });
    const zipFile = () => path.join(dir, 'alpha.zip');
    const stillThere = () => fs.existsSync(path.join(plugins, 'alpha'));

    beforeEach(async () => {
      plugins = path.join(dir, '..', `${path.basename(dir)}-plugins`);
      fs.mkdirSync(plugins);
      put('alpha.zip', pack('alpha', '1.0.0'));
      await syncPlugins(createFolderSource(dir), opts());
      expect(stillThere()).toBe(true);
    });
    afterEach(() => {
      fs.chmodSync(zipFile(), 0o644);
      fs.rmSync(plugins, { recursive: true, force: true });
    });

    const expectKept = (r: any) => {
      expect(stillThere()).toBe(true);
      expect(r.changed).toBe(false);
      expect(r.plugins).toEqual([expect.objectContaining({ id: 'alpha.zip', state: 'failed' })]);
    };

    it('chmod 000', async () => {
      if (process.getuid?.() === 0) return; // root reads anything
      fs.chmodSync(zipFile(), 0o000);
      expectKept(await syncPlugins(createFolderSource(dir), opts()));
    });

    it('a truncated zip', async () => {
      put('alpha.zip', pack('alpha', '1.0.0').subarray(0, 40));
      expectKept(await syncPlugins(createFolderSource(dir), opts()));
    });

    it('a zip that reads but has a bad manifest', async () => {
      put('alpha.zip', pack('bad id with spaces', '1.0.0'));
      expectKept(await syncPlugins(createFolderSource(dir), opts()));
    });

    it('the valid ones still install beside it', async () => {
      put('alpha.zip', 'damaged');
      put('beta.zip', pack('betaPlugin', '1.0.0'));
      const r = await syncPlugins(createFolderSource(dir), opts());
      expect(stillThere()).toBe(true);
      expect(fs.existsSync(path.join(plugins, 'betaPlugin'))).toBe(true);
    expect(r.plugins.map((p: { id: string }) => p.id).sort()).toEqual(['alpha.zip', 'betaPlugin']);
    });

    it('junk that is not a zip does not hold back a removal', async () => {
      fs.rmSync(zipFile());
      put('.DS_Store', 'junk');
      const r = await syncPlugins(createFolderSource(dir), opts());
      fs.writeFileSync(zipFile(), ''); // for the afterEach
      expect(r.changed).toBe(true);
      expect(stillThere()).toBe(false);
    });
  });
});

describe('admin package source', () => {
  let status = 200;
  let body: unknown = {};
  let urls: string[] = [];
  let auth: (string | undefined)[] = [];
  let server: http.Server;
  let url: string;
  const ORIGINAL_ENV = { ...process.env };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      urls.push(req.url ?? '');
      auth.push(req.headers.authorization);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

  beforeEach(() => {
    jest.resetModules();
    urls = [];
    auth = [];
    process.env = {
      ...ORIGINAL_ENV,
      ADMIN_SERVICE_URL: url,
      VALKEY_URL: 'redis://127.0.0.1:1',
      UNIFIED_TOKEN_SYSTEM_ENABLED: 'true',
      GATEWAY_STANDALONE: 'false',
      VALIDATION_TOKEN_SECRET: 'f'.repeat(64),
      UNIFIED_AUTH_HEALTH_CHECK_INTERVAL_MS: '0',
      NODE_ENV: 'test',
    };
  });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  const source = async () => (await import('../src/pluginInstall/adminSource')).adminPackageSource;
  const wanted = { id: 'myPlugin', version: '1.0.0', sha256: 'a'.repeat(64) };

  it.each([404, 500, 403])('HTTP %i rejects and is not an empty list', async code => {
    status = code;
    body = { error: { message: 'nope' } };
    await expect((await source()).list()).rejects.toThrow(String(code));
  });

  it('success: false rejects', async () => {
    status = 200;
    body = { success: false, enabled: true, plugins: [] };
    await expect((await source()).list()).rejects.toThrow();
  });

  it('a successful answer without an enabled flag or a list rejects', async () => {
    status = 200;
    body = { success: true, plugins: [] };
    await expect((await source()).list()).rejects.toThrow();
    body = { success: true, enabled: true };
    await expect((await source()).list()).rejects.toThrow();
  });

  it('enabled: false resolves empty, whatever the list says', async () => {
    status = 200;
    body = { success: true, enabled: false, plugins: [wanted] };
    await expect((await source()).list()).resolves.toEqual([]);
  });

  it('returns the wanted list, over the gateway service JWT', async () => {
    status = 200;
    body = { success: true, enabled: true, plugins: [wanted] };
    await expect((await source()).list()).resolves.toEqual([wanted]);
    expect(urls).toEqual(['/odata/v4/validation/getPlugins()']);
    expect(auth[0]).toMatch(/^Bearer .+/);
  });

  it('decodes the package to the same bytes', async () => {
    const bytes = crypto.randomBytes(4096);
    status = 200;
    const sha256 = sha(bytes);
    body = { success: true, sha256, contentBase64: bytes.toString('base64') };
    const fetched = await (await source()).fetch({ ...wanted, sha256 });
    expect(Buffer.from(fetched).equals(bytes)).toBe(true);
  });

  it('quotes the id and version into the function call', async () => {
    status = 200;
    body = { success: true, sha256: wanted.sha256, contentBase64: '' };
    await (await source()).fetch({ ...wanted, version: "1.0.0'x" });
    expect(urls[0]).toBe("/odata/v4/validation/getPluginPackage(id='myPlugin',version='1.0.0''x')");
  });

  it.each([404, 500])('a package answer of HTTP %i rejects', async code => {
    status = code;
    body = {};
    await expect((await source()).fetch(wanted)).rejects.toThrow(String(code));
  });

  it('a package answer of another sha, success: false or no content rejects', async () => {
    status = 200;
    body = { success: true, sha256: 'b'.repeat(64), contentBase64: 'AAAA' };
    await expect((await source()).fetch(wanted)).rejects.toThrow(/sha256/);
    body = { success: false, sha256: wanted.sha256, contentBase64: 'AAAA' };
    await expect((await source()).fetch(wanted)).rejects.toThrow();
    body = { success: true, sha256: wanted.sha256 };
    await expect((await source()).fetch(wanted)).rejects.toThrow();
  });

  it('never touches the shared circuit breaker, and makes one attempt per call', async () => {
    status = 500;
    body = {};
    const { adminServiceClient } = await import('../src/clients/adminServiceClient');
    for (let i = 0; i < 8; i++) await expect(adminServiceClient!.getPlugins()).rejects.toThrow();
    expect(urls).toHaveLength(8);
    expect((adminServiceClient as any).circuitBreaker.state).toBe('closed');
  });

  it('rejects clearly when there is no admin client (standalone)', async () => {
    process.env.GATEWAY_STANDALONE = 'true';
    const standalone = await source();
    await expect(standalone.list()).rejects.toThrow(/admin/i);
    await expect(standalone.fetch(wanted)).rejects.toThrow(/admin/i);
  });
});
