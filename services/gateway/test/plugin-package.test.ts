import { zipSync, strToU8 } from 'fflate';

// Lets a test change what fflate "returns", to reach the checks on the unpacked output.
let mockUnzipHook: ((out: Record<string, Uint8Array>) => Record<string, Uint8Array>) | null = null;
jest.mock('fflate', () => {
  const actual = jest.requireActual('fflate');
  return {
    ...actual,
    unzipSync: (...args: unknown[]) => {
      const out = actual.unzipSync(...args);
      return mockUnzipHook ? mockUnzipHook(out) : out;
    },
  };
});
import {
  parsePluginPackage,
  PluginPackageError,
  isCompatible,
  resolveHelp,
  applyHelpToSchema,
  PLUGIN_PACKAGE_LIMITS,
} from '@libs/plugin-package';

const goodManifest = () => ({
  id: 'myPlugin',
  version: '1.2.0',
  runtime: 'node',
  gateway: '>=0.12.0 <0.13.0',
  hooks: { definitions: {}, defaults: { anthropic: { invoke: [] } } },
  settings: { schema: { type: 'object', properties: {} }, defaults: {} },
  help: {
    en: { summary: 'What it does', settings: { apiUrl: 'Help for this setting' } },
    de: { summary: 'Was es tut', settings: { apiUrl: 'Hilfe zu dieser Einstellung' } },
  },
});

type Entries = Record<string, string | Uint8Array | object>;

const build = (extra: Entries = {}, manifest: unknown = goodManifest(), opts: { noIndex?: boolean } = {}): Uint8Array => {
  const entries: Record<string, Uint8Array> = {};
  if (manifest !== null) entries['manifest.json'] = strToU8(JSON.stringify(manifest));
  if (!opts.noIndex) entries['index.js'] = strToU8('module.exports = [];');
  for (const [name, value] of Object.entries(extra)) {
    entries[name] = typeof value === 'string' ? strToU8(value) : value instanceof Uint8Array ? value : strToU8(JSON.stringify(value));
  }
  return zipSync(entries);
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PluginPackageError);
    return (e as PluginPackageError).code;
  }
  return undefined;
};

const withManifest = (patch: (m: any) => void): Uint8Array => {
  const m: any = goodManifest();
  patch(m);
  return build({}, m);
};

describe('parsePluginPackage accepts', () => {
  it('the spec sample, keeping manifest.json in files', () => {
    const { manifest, files } = parsePluginPackage(build());
    expect(manifest.id).toBe('myPlugin');
    expect(manifest.version).toBe('1.2.0');
    const paths = files.map(f => f.path).sort();
    expect(paths).toEqual(['index.js', 'manifest.json']);
    expect(Buffer.from(files.find(f => f.path === 'index.js')!.data).toString()).toBe('module.exports = [];');
  });

  it('extra scripts and non-JS files at the root and in subfolders', () => {
    const { files } = parsePluginPackage(build({
      'helper.js': 'x',
      'data.json': { a: 1 },
      'lib/util.js': 'y',
      'lib/deep/template.txt': 'z',
      'lib/deep/blob.bin': new Uint8Array([1, 2, 3]),
    }));
    expect(files.map(f => f.path)).toEqual(expect.arrayContaining(['helper.js', 'data.json', 'lib/util.js', 'lib/deep/template.txt', 'lib/deep/blob.bin']));
  });

  it('a manifest with gateway "*"', () => {
    expect(parsePluginPackage(withManifest(m => { m.gateway = '*'; })).manifest.gateway).toBe('*');
  });

  it('a manifest without hooks and settings', () => {
    const m: any = goodManifest();
    delete m.hooks;
    delete m.settings;
    expect(parsePluginPackage(build({}, m)).manifest.hooks).toBeUndefined();
  });

  it('$ref outside settings.schema', () => {
    expect(() => parsePluginPackage(withManifest(m => { m.hooks = { definitions: { $ref: 'x' } }; }))).not.toThrow();
  });
});

describe('parsePluginPackage refuses', () => {
  it('MANIFEST_MISSING', () => {
    expect(codeOf(() => parsePluginPackage(build({}, null)))).toBe('MANIFEST_MISSING');
  });

  it('MANIFEST_INVALID when manifest.json is larger than 1 MB', () => {
    const big = JSON.stringify({ ...goodManifest(), padding: 'x'.repeat(1024 * 1024) });
    expect(codeOf(() => parsePluginPackage(zipSync({ 'manifest.json': strToU8(big), 'index.js': strToU8('') })))).toBe('MANIFEST_INVALID');
  });

  it('MANIFEST_MISSING when manifest.json is only in a subfolder', () => {
    expect(codeOf(() => parsePluginPackage(build({ 'sub/manifest.json': goodManifest() }, null)))).toBe('MANIFEST_MISSING');
  });

  it('MANIFEST_INVALID for unparseable JSON', () => {
    expect(codeOf(() => parsePluginPackage(zipSync({ 'manifest.json': strToU8('{nope'), 'index.js': strToU8('') })))).toBe('MANIFEST_INVALID');
  });

  it.each([
    ['bad id a/b', (m: any) => { m.id = 'a/b'; }],
    ['empty id', (m: any) => { m.id = ''; }],
    ['reserved id node_modules', (m: any) => { m.id = 'node_modules'; }],
    ['non-semver version', (m: any) => { m.version = 'one'; }],
    ['unparseable gateway', (m: any) => { m.gateway = 'not a range!!'; }],
    ['missing gateway', (m: any) => { delete m.gateway; }],
    ['missing help', (m: any) => { delete m.help; }],
    ['empty help', (m: any) => { m.help = {}; }],
    ['help language without summary', (m: any) => { m.help.de = { settings: {} }; }],
    ['settings without schema', (m: any) => { m.settings = { defaults: {} }; }],
  ])('MANIFEST_INVALID: %s', (_name, patch) => {
    expect(codeOf(() => parsePluginPackage(withManifest(patch)))).toBe('MANIFEST_INVALID');
  });

  it('RUNTIME_UNSUPPORTED for wasm', () => {
    expect(codeOf(() => parsePluginPackage(withManifest(m => { m.runtime = 'wasm'; })))).toBe('RUNTIME_UNSUPPORTED');
  });

  it('ENTRY_MISSING without index.js', () => {
    expect(codeOf(() => parsePluginPackage(build({}, goodManifest(), { noIndex: true })))).toBe('ENTRY_MISSING');
  });

  it('ENTRY_MISSING with index.js only in a subfolder', () => {
    expect(codeOf(() => parsePluginPackage(build({ 'src/index.js': 'x' }, goodManifest(), { noIndex: true })))).toBe('ENTRY_MISSING');
  });

  it.each(['a.ts', 'a.d.ts', 'lib/deep/b.ts', 'lib/types.d.ts', 'X.TS'])('TYPESCRIPT_REFUSED: %s', name => {
    expect(codeOf(() => parsePluginPackage(build({ [name]: 'x' })))).toBe('TYPESCRIPT_REFUSED');
  });

  it.each(['node_modules/x/index.js', 'lib/node_modules/y.js'])('NODE_MODULES_REFUSED: %s', name => {
    expect(codeOf(() => parsePluginPackage(build({ [name]: 'x' })))).toBe('NODE_MODULES_REFUSED');
  });

  it.each(['../x', '/x', 'a/../b', 'a\\..\\b', 'C:/x'])('UNSAFE_PATH: %s', name => {
    expect(codeOf(() => parsePluginPackage(build({ [name]: 'x' })))).toBe('UNSAFE_PATH');
  });

  it('SYMLINK_REFUSED', () => {
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(goodManifest())),
      'index.js': strToU8('x'),
      link: [strToU8('index.js'), { attrs: 0o120777 << 16, os: 3 }],
    } as any);
    expect(codeOf(() => parsePluginPackage(zip))).toBe('SYMLINK_REFUSED');
  });

  it('RESERVED_NAME for .installed.json at the root', () => {
    expect(codeOf(() => parsePluginPackage(build({ '.installed.json': '{}' })))).toBe('RESERVED_NAME');
  });

  it('RESERVED_NAME for .installed.json as a root folder', () => {
    expect(codeOf(() => parsePluginPackage(build({ '.installed.json/x': 'y' })))).toBe('RESERVED_NAME');
  });

  it('refuses dot and empty path segments', () => {
    expect(codeOf(() => parsePluginPackage(build({ './lib.js': 'y' })))).toBe('UNSAFE_PATH');
    expect(codeOf(() => parsePluginPackage(build({ 'a/./b.js': 'y' })))).toBe('UNSAFE_PATH');
    expect(codeOf(() => parsePluginPackage(build({ 'a//b.js': 'y' })))).toBe('UNSAFE_PATH');
  });

  it('refuses ./manifest.json shadowing manifest.json', () => {
    const bad = { ...goodManifest(), id: 'otherId' };
    expect(codeOf(() => parsePluginPackage(build({ './manifest.json': bad })))).toBe('UNSAFE_PATH');
  });

  it('refuses a file and a folder with one name', () => {
    expect(codeOf(() => parsePluginPackage(zipSync({
      'manifest.json': strToU8(JSON.stringify(goodManifest())),
      'index.js': strToU8('x'),
      'lib': strToU8('file'),
      'lib/': new Uint8Array(),
    })))).toBe('DUPLICATE_PATH');
  });

  it('refuses a patched end-of-central-directory count that hides an entry', () => {
    const raw = zipSync({
      'manifest.json': strToU8(JSON.stringify(goodManifest())),
      'index.js': strToU8('x'),
      '../../../escaped.js': strToU8('pwned'),
    });
    const b = new Uint8Array(raw);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let e = b.length - 22;
    while (view.getUint32(e, true) !== 0x06054b50) e--;
    view.setUint16(e + 10, 2, true);
    expect(codeOf(() => parsePluginPackage(b))).toBe('NOT_A_ZIP');
  });

  it('refuses a zip64 locator', () => {
    const raw = build();
    let e = raw.length - 22;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    while (view.getUint32(e, true) !== 0x06054b50) e--;
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
    const spliced = new Uint8Array(raw.length + 20);
    spliced.set(raw.subarray(0, e), 0);
    spliced.set(locator, e);
    spliced.set(raw.subarray(e), e + 20);
    expect(codeOf(() => parsePluginPackage(spliced))).toBe('NOT_A_ZIP');
  });

  it('refuses a manifest.json with a byte order mark', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8(JSON.stringify(goodManifest()))]);
    expect(codeOf(() => parsePluginPackage(zipSync({ 'manifest.json': bom, 'index.js': strToU8('x') })))).toBe('MANIFEST_INVALID');
  });

  it('refuses a non-ASCII name without the UTF-8 flag, naming the cause', () => {
    const raw = zipSync({ 'manifest.json': strToU8(JSON.stringify(goodManifest())), 'XXXindex.js': strToU8('x') });
    const b = new Uint8Array(raw);
    // patch the placeholder to the raw bytes EF BB BF in both the local and the central header
    for (let i = 0; i < b.length - 11; i++) {
      if (b[i] === 0x58 && b[i + 1] === 0x58 && b[i + 2] === 0x58 && b[i + 3] === 0x69) {
        b[i] = 0xef;
        b[i + 1] = 0xbb;
        b[i + 2] = 0xbf;
      }
    }
    try {
      parsePluginPackage(b);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as PluginPackageError).code).toBe('NAME_ENCODING');
      expect((e as Error).message).toMatch(/UTF-8/);
    }
  });

  it('does not take a flagged look-alike name for index.js', () => {
    const b = zipSync({ 'manifest.json': strToU8(JSON.stringify(goodManifest())), '\u00ef\u00bb\u00bfindex.js': strToU8('x') });
    expect(codeOf(() => parsePluginPackage(b))).toBe('ENTRY_MISSING');
  });

  it('refuses a __proto__ entry that fflate would silently drop', () => {
    const b = new Uint8Array(zipSync({
      'manifest.json': strToU8(JSON.stringify(goodManifest())),
      'index.js': strToU8('x'),
      'XXXXXXXXX': strToU8('x'),
    }));
    const target = strToU8('__proto__');
    for (let i = 0; i < b.length - 9; i++) {
      if (b.subarray(i, i + 9).every(byte => byte === 0x58)) b.set(target, i);
    }
    expect(codeOf(() => parsePluginPackage(b))).toBe('NOT_A_ZIP');
  });

  it('refuses a stored entry whose compressed and declared sizes differ', () => {
    const raw = new Uint8Array(zipSync({
      'manifest.json': [strToU8(JSON.stringify(goodManifest())), { level: 0 }],
      'index.js': [strToU8('module.exports = [];'), { level: 0 }],
    }));
    const view = new DataView(raw.buffer);
    let e = raw.length - 22;
    while (view.getUint32(e, true) !== 0x06054b50) e--;
    const cd = view.getUint32(e + 16, true);
    view.setUint32(cd + 24, 0, true);
    expect(codeOf(() => parsePluginPackage(raw))).toBe('NOT_A_ZIP');
  });

  it('refuses output holding an entry the directory does not list', () => {
    mockUnzipHook = out => ({ ...out, 'extra.js': strToU8('x') });
    try {
      expect(codeOf(() => parsePluginPackage(build()))).toBe('NOT_A_ZIP');
    } finally {
      mockUnzipHook = null;
    }
  });

  it('enforces the unpacked size limit on the actual bytes', () => {
    mockUnzipHook = out => ({ ...out, 'index.js': new Uint8Array(PLUGIN_PACKAGE_LIMITS.maxUncompressedBytes + 1) });
    try {
      expect(codeOf(() => parsePluginPackage(build()))).toBe('TOO_LARGE_UNPACKED');
    } finally {
      mockUnzipHook = null;
    }
  });

  it('accepts .installed.json in a subfolder', () => {
    expect(() => parsePluginPackage(build({ 'sub/.installed.json': '{}' }))).not.toThrow();
  });

  it('TOO_LARGE when the compressed package exceeds 20 MB', () => {
    const big = new Uint8Array(PLUGIN_PACKAGE_LIMITS.maxCompressedBytes + 1);
    expect(codeOf(() => parsePluginPackage(big))).toBe('TOO_LARGE');
  });

  it('TOO_LARGE_UNPACKED from declared sizes, before inflating', () => {
    const zeros = new Uint8Array(PLUGIN_PACKAGE_LIMITS.maxUncompressedBytes + 1024);
    const zip = build({ 'big.bin': zeros });
    expect(zip.length).toBeLessThan(PLUGIN_PACKAGE_LIMITS.maxCompressedBytes);
    expect(codeOf(() => parsePluginPackage(zip))).toBe('TOO_LARGE_UNPACKED');
  });

  it('TOO_MANY_FILES', () => {
    const extra: Entries = {};
    for (let i = 0; i < PLUGIN_PACKAGE_LIMITS.maxFiles; i++) extra[`f/${i}.txt`] = '';
    expect(codeOf(() => parsePluginPackage(build(extra)))).toBe('TOO_MANY_FILES');
  });

  it('accepts exactly the file limit', () => {
    const extra: Entries = {};
    for (let i = 0; i < PLUGIN_PACKAGE_LIMITS.maxFiles - 2; i++) extra[`f/${i}.txt`] = '';
    expect(parsePluginPackage(build(extra)).files).toHaveLength(PLUGIN_PACKAGE_LIMITS.maxFiles);
  });

  it('SCHEMA_REF_REFUSED for $ref anywhere in settings.schema', () => {
    const code = codeOf(() => parsePluginPackage(withManifest(m => {
      m.settings.schema = { type: 'object', properties: { a: { type: 'array', items: [{ $ref: '#/definitions/x' }] } } };
    })));
    expect(code).toBe('SCHEMA_REF_REFUSED');
  });

  it('SCHEMA_REF_REFUSED for a $ref directly in properties', () => {
    expect(codeOf(() => parsePluginPackage(withManifest(m => {
      m.settings.schema = { type: 'object', properties: { a: { $ref: '#/x' } } };
    })))).toBe('SCHEMA_REF_REFUSED');
  });

  it('not a zip at all', () => {
    expect(codeOf(() => parsePluginPackage(strToU8('definitely not a zip')))).toBe('NOT_A_ZIP');
  });
});

describe('isCompatible', () => {
  it('honours the range', () => {
    const m: any = goodManifest();
    expect(isCompatible(m, '0.12.3')).toBe(true);
    expect(isCompatible(m, '0.13.0')).toBe(false);
    expect(isCompatible(m, '0.11.9')).toBe(false);
  });

  it('accepts * for any version', () => {
    expect(isCompatible({ ...(goodManifest() as any), gateway: '*' }, '9.9.9')).toBe(true);
  });

  it('includes prereleases of the gateway', () => {
    expect(isCompatible(goodManifest() as any, '0.12.1-rc.1')).toBe(true);
  });

  it('is false for an invalid gateway version', () => {
    expect(isCompatible(goodManifest() as any, 'garbage')).toBe(false);
  });
});

describe('resolveHelp', () => {
  const m: any = goodManifest();
  m.help.pt = { summary: 'O que faz' };

  it('exact match', () => {
    expect(resolveHelp(m, 'de')).toEqual({ lang: 'de', fallback: false, help: m.help.de });
  });
  it('pt-BR falls to pt without being a fallback', () => {
    expect(resolveHelp(m, 'pt-BR')).toEqual({ lang: 'pt', fallback: false, help: m.help.pt });
  });
  it('de_DE falls to de', () => {
    expect(resolveHelp(m, 'de_DE').lang).toBe('de');
  });
  it('PT is case-insensitive', () => {
    expect(resolveHelp(m, 'PT').lang).toBe('pt');
  });
  it('a missing language falls back to the first listed', () => {
    expect(resolveHelp(m, 'fr')).toEqual({ lang: 'en', fallback: true, help: m.help.en });
  });
});

describe('applyHelpToSchema', () => {
  const schema = () => ({
    type: 'object',
    properties: {
      apiUrl: { type: 'string' },
      limits: { type: 'object', properties: { maxItems: { type: 'number', title: 'Own title' }, minItems: { type: 'number' } } },
    },
  });

  it('fills title from the key and description from the text, including nested', () => {
    const out: any = applyHelpToSchema(schema(), { apiUrl: 'The URL', 'limits.minItems': 'Lower bound' });
    expect(out.properties.apiUrl).toEqual({ type: 'string', title: 'apiUrl', description: 'The URL' });
    expect(out.properties.limits.properties.minItems).toEqual({ type: 'number', title: 'minItems', description: 'Lower bound' });
  });

  it('keeps an existing title', () => {
    const out: any = applyHelpToSchema(schema(), { 'limits.maxItems': 'Upper bound' });
    expect(out.properties.limits.properties.maxItems).toEqual({ type: 'number', title: 'Own title', description: 'Upper bound' });
  });

  it('does not mutate its input', () => {
    const input = schema();
    const copy = JSON.parse(JSON.stringify(input));
    applyHelpToSchema(input, { apiUrl: 'x', 'limits.minItems': 'y' });
    expect(input).toEqual(copy);
  });

  it('ignores keys that address no property', () => {
    const out: any = applyHelpToSchema(schema(), { nope: 'x', 'limits.nope.deeper': 'y' });
    expect(out).toEqual(schema());
  });

  it('returns the schema unchanged without help', () => {
    expect(applyHelpToSchema(schema(), undefined)).toEqual(schema());
  });
});
