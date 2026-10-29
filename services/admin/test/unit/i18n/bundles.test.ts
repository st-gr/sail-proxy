import * as fs from 'fs';
import * as path from 'path';

const ADMIN_ROOT = path.resolve(__dirname, '../../..');
const APP_ROOT = path.join(ADMIN_ROOT, 'app');
const CDS_BUNDLE_DIR = path.join(ADMIN_ROOT, '_i18n');
const LANGUAGES = ['en', 'de', 'es', 'fr', 'it', 'nl', 'pt'];

type Bundle = { label: string; dir: string; webapp?: string; appDir?: string };

function rel(p: string): string {
  return path.relative(ADMIN_ROOT, p);
}

/** Parses a .properties file: key=value, # and ! comments, backslash continuation. */
function parseProperties(file: string, duplicates?: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    }
    const m = line.match(/^((?:\\.|[^=:\s\\])+)\s*[=:]?\s*(.*)$/s);
    if (!m) continue;
    if (result.has(m[1]) && duplicates) duplicates.push(m[1]);
    result.set(m[1], m[2]);
  }
  return result;
}

function placeholders(value: string): string[] {
  return Array.from(new Set(value.match(/\{\d+\}/g) || [])).sort();
}

function walk(dir: string, filter: (f: string) => boolean, skip: Set<string>, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(full, filter, skip, out);
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

function discoverBundles(): Bundle[] {
  const bundles: Bundle[] = [];
  for (const app of fs.readdirSync(APP_ROOT).sort()) {
    const webapp = path.join(APP_ROOT, app, 'webapp');
    const dir = path.join(webapp, 'i18n');
    if (fs.existsSync(path.join(dir, 'i18n.properties'))) {
      bundles.push({ label: app, dir, webapp, appDir: path.join(APP_ROOT, app) });
    }
  }
  if (fs.existsSync(CDS_BUNDLE_DIR)) bundles.push({ label: '_i18n', dir: CDS_BUNDLE_DIR });
  return bundles;
}

/** Resolves the default bundle file a manifest's sap.app "i18n" points to (string or {bundleUrl}). */
function manifestBundleFile(manifestFile: string): string | undefined {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const i18n = manifest?.['sap.app']?.i18n;
  const url = typeof i18n === 'string' ? i18n : i18n?.bundleUrl;
  return url ? path.resolve(path.dirname(manifestFile), url) : undefined;
}

/** Reads a quoted string literal at text[i]; returns [value, indexAfter] or undefined. */
function readStringLiteral(text: string, i: number): [string, number] | undefined {
  const q = text[i];
  if (q !== "'" && q !== '"' && q !== '`') return undefined;
  let out = '';
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      const n = text[++j];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else if (c === q) {
      return [out, j + 1];
    } else {
      out += c;
    }
  }
  return undefined;
}

/**
 * English default maps of injected translators: `const NAME: Record<string, string> = { key: 'text', ... }`
 * where NAME is used as `NAME[key]` (the default translator). Returns name -> entries, parsed textually.
 */
function translatorDefaultMaps(source: string): Map<string, Map<string, string>> {
  const maps = new Map<string, Map<string, string>>();
  if (!/\bTranslator\b/.test(source)) return maps;
  for (const decl of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*:\s*Record<string,\s*string>\s*=\s*\{/g)) {
    const name = decl[1];
    if (!new RegExp(`\\b${name}\\[\\s*key\\s*\\]`).test(source)) continue;
    const entries = new Map<string, string>();
    let i = (decl.index as number) + decl[0].length;
    while (i < source.length) {
      while (i < source.length && /[\s,]/.test(source[i])) i++;
      if (source[i] === '}') break;
      let key: string;
      const lit = readStringLiteral(source, i);
      if (lit) {
        [key, i] = lit;
      } else {
        const id = source.slice(i).match(/^[A-Za-z_$][\w$]*/);
        if (!id) throw new Error(`cannot parse translator default map ${name}: unexpected text at "${source.slice(i, i + 30)}"`);
        key = id[0];
        i += key.length;
      }
      while (/\s/.test(source[i])) i++;
      if (source[i] !== ':') throw new Error(`cannot parse translator default map ${name}: expected ':' after key "${key}"`);
      i++;
      while (/\s/.test(source[i])) i++;
      const val = readStringLiteral(source, i);
      if (!val) throw new Error(`cannot parse translator default map ${name}: value of "${key}" is not a plain string literal`);
      entries.set(key, val[0]);
      i = val[1];
    }
    maps.set(name, entries);
  }
  return maps;
}

const bundles = discoverBundles();

function languageFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^i18n_[A-Za-z_]+\.properties$/.test(f))
    .sort();
}

/** Keys referenced literally from a source file set, as [file, key] pairs. */
function referencedKeys(files: string[], patterns: RegExp[]): Array<[string, string]> {
  const refs: Array<[string, string]> = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of patterns) {
      for (const m of text.matchAll(new RegExp(re.source, 'g'))) refs.push([file, m[1]]);
    }
  }
  return refs;
}

// Covers {i18n>k}, ${i18n>k}, {path:'i18n>k', formatter:...}, parts:[{path:"i18n>k"}] and &apos; forms.
const BINDING = /\bi18n>([A-Za-z0-9_.\-]+)/;
// getText(...) and the apps' helper forms: bare text( / _text(, this|that|self.text/_text, (this.)_options.text.
// A bare .text("Word") on another object (e.g. RenderManager rm.text) is not matched.
const CALL =
  /(?:\bgetText|(?<![.\w$])_?text|\b(?:this|that|self)\._?text|\b_?options\.text)\(\s*["'`]([A-Za-z0-9_.\-]+)["'`]\s*[,)]/;
const SKIP_DIRS = new Set(['node_modules', 'test', 'i18n', 'mockData', 'dist']);

describe('cockpit i18n bundles', () => {
  it('finds the expected bundles', () => {
    expect(bundles.map((b) => b.label)).toEqual(expect.arrayContaining(['config-app', 'grounding-app', 'shell', 'users-app']));
    expect(bundles.length).toBeGreaterThanOrEqual(11);
  });

  it('finds exactly the injected translators\' default maps', () => {
    const found: string[] = [];
    for (const b of bundles.filter((x) => x.webapp)) {
      for (const f of walk(b.webapp!, (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'), SKIP_DIRS)) {
        for (const name of translatorDefaultMaps(fs.readFileSync(f, 'utf8')).keys()) found.push(`${b.label}/${path.basename(f)}:${name}`);
      }
    }
    expect(found.sort()).toEqual([
      'config-app/validationTexts.ts:EN_TEXTS', 'model-library-app/benchmarks.ts:EN_TEXTS', 'model-library-app/capabilityIcons.ts:EN_TEXTS',
      'model-library-app/catalogPending.ts:EN_TEXTS', 'model-library-app/deploymentBadge.ts:EN_TEXTS', 'model-library-app/formatter.ts:EN_TEXTS',
      'model-library-app/providerLabel.ts:EN_TEXTS',
      'shell/homeTiles.ts:EN_TEXTS', 'shell/quotaDisplay.ts:EN_TEXTS', 'shell/teamsDisplay.ts:EN_TEXTS', 'grounding-app/jobs.ts:EN_TEXTS', 'grounding-app/status.ts:EN_TEXTS',
      'grounding-app/rows.ts:EN_TEXTS', 'grounding-app/api.ts:EN_TEXTS', 'grounding-app/admin.ts:EN_TEXTS', 'grounding-app/errors.ts:EN_TEXTS', 'grounding-app/reembed.ts:EN_TEXTS', 'grounding-app/chunking.ts:CHUNKING_EN_TEXTS', 'grounding-app/reextract.ts:REEXTRACT_EN_TEXTS', 'model-library-app/libraryFilters.ts:EN_TEXTS',
      'model-library-app/costDisplay.ts:EN_LABELS', 'model-library-app/deploymentPoll.ts:EN_TEXTS'
    ].sort());
  });

  describe.each(bundles.map((b) => [b.label, b] as const))('%s', (_label, bundle) => {
    const defaultFile = path.join(bundle.dir, 'i18n.properties');
    const defaults = parseProperties(defaultFile);
    const files = languageFiles(bundle.dir);

    it('has no duplicate keys in the default bundle', () => {
      const dups: string[] = [];
      parseProperties(defaultFile, dups);
      expect({ file: rel(defaultFile), duplicateKeys: dups }).toEqual({ file: rel(defaultFile), duplicateKeys: [] });
    });

    it('has a non-empty default bundle without empty values', () => {
      expect(defaults.size).toBeGreaterThan(0);
      const empty = [...defaults].filter(([, v]) => v.trim() === '').map(([k]) => k);
      expect({ file: rel(defaultFile), emptyKeys: empty }).toEqual({ file: rel(defaultFile), emptyKeys: [] });
    });

    it('has a file for every language (en is optional)', () => {
      const present = files.map((f) => f.replace(/^i18n_|\.properties$/g, ''));
      const missing = LANGUAGES.filter((l) => l !== 'en' && !present.includes(l));
      expect({ bundle: rel(bundle.dir), missingLanguages: missing }).toEqual({ bundle: rel(bundle.dir), missingLanguages: [] });
    });

    it('i18n_en.properties equals i18n.properties byte for byte where both exist', () => {
      const enFile = path.join(bundle.dir, 'i18n_en.properties');
      if (!fs.existsSync(enFile)) return;
      const same = fs.readFileSync(enFile).equals(fs.readFileSync(defaultFile));
      if (!same) {
        throw new Error(`${rel(enFile)} differs from ${rel(defaultFile)}: the English file must be byte-identical to the default`);
      }
    });

    describe.each(files.map((f) => [f.replace(/^i18n_|\.properties$/g, ''), f] as const))('language %s', (lang, f) => {
      const file = path.join(bundle.dir, f);
      const props = parseProperties(file);

      it('has no duplicate keys', () => {
        const dups: string[] = [];
        parseProperties(file, dups);
        expect({ file: rel(file), lang, duplicateKeys: dups }).toEqual({ file: rel(file), lang, duplicateKeys: [] });
      });

      it('has exactly the default key set', () => {
        const missing = [...defaults.keys()].filter((k) => !props.has(k));
        const extra = [...props.keys()].filter((k) => !defaults.has(k));
        expect({ file: rel(file), lang, missingKeys: missing, extraKeys: extra }).toEqual({ file: rel(file), lang, missingKeys: [], extraKeys: [] });
      });

      it('has no empty values', () => {
        const empty = [...props].filter(([, v]) => v.trim() === '').map(([k]) => k);
        expect({ file: rel(file), lang, emptyKeys: empty }).toEqual({ file: rel(file), lang, emptyKeys: [] });
      });

      it('keeps the {n} placeholders of the default', () => {
        const bad: string[] = [];
        for (const [k, v] of props) {
          const def = defaults.get(k);
          if (def === undefined) continue;
          const want = placeholders(def).join(',');
          const got = placeholders(v).join(',');
          if (want !== got) bad.push(`${k}: default has [${want}], ${lang} has [${got}]`);
        }
        expect({ file: rel(file), lang, placeholderMismatches: bad }).toEqual({ file: rel(file), lang, placeholderMismatches: [] });
      });

      it('uses no ASCII apostrophe in values with {n} (use two apostrophes or the typographic one)', () => {
        const bad = [...props].filter(([, v]) => /\{\d+\}/.test(v) && v.replace(/''/g, '').includes("'")).map(([k]) => k);
        expect({ file: rel(file), lang, keysWithSingleAsciiApostrophe: bad }).toEqual({ file: rel(file), lang, keysWithSingleAsciiApostrophe: [] });
      });
    });

    it('uses no ASCII apostrophe in default values with {n}', () => {
      const bad = [...defaults].filter(([, v]) => /\{\d+\}/.test(v) && v.replace(/''/g, '').includes("'")).map(([k]) => k);
      expect({ file: rel(defaultFile), keysWithSingleAsciiApostrophe: bad }).toEqual({ file: rel(defaultFile), keysWithSingleAsciiApostrophe: [] });
    });

    if (bundle.webapp) {
      it('only references keys that exist in the default bundle', () => {
        const sources = walk(bundle.webapp!, (f) => /\.(xml|ts|js)$/.test(f) && !f.endsWith('.d.ts'), SKIP_DIRS);
        const refs: Array<[string, string]> = [];
        refs.push(...referencedKeys(sources.filter((f) => f.endsWith('.xml')), [BINDING]));
        refs.push(...referencedKeys(sources.filter((f) => /\.(ts|js)$/.test(f)), [CALL]));
        const cds = path.join(bundle.appDir!, 'annotations.cds');
        if (fs.existsSync(cds) && !fs.existsSync(CDS_BUNDLE_DIR)) refs.push(...referencedKeys([cds], [BINDING]));
        const unknown = refs.filter(([, k]) => !defaults.has(k)).map(([f, k]) => `${rel(f)}: key "${k}" is not in ${rel(defaultFile)}`);
        expect(unknown).toEqual([]);
      });

      it('has every {{key}} of its manifest.json in the bundle the manifest points to', () => {
        const manifestFile = path.join(bundle.webapp!, 'manifest.json');
        if (!fs.existsSync(manifestFile)) return;
        const target = manifestBundleFile(manifestFile);
        expect({ manifest: rel(manifestFile), bundle: target && rel(target) }).toEqual({ manifest: rel(manifestFile), bundle: rel(defaultFile) });
        const keys = Array.from(new Set(Array.from(fs.readFileSync(manifestFile, 'utf8').matchAll(/\{\{([A-Za-z0-9_.\-]+)\}\}/g), (m) => m[1])));
        const unknown = keys.filter((k) => !defaults.has(k)).map((k) => `${rel(manifestFile)}: key "${k}" is not in ${rel(defaultFile)}`);
        expect(unknown).toEqual([]);
      });

      it('keeps the English defaults of its injected translators in the bundle, byte-identical', () => {
        const sources = walk(bundle.webapp!, (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'), SKIP_DIRS);
        const problems: string[] = [];
        for (const file of sources) {
          for (const [name, entries] of translatorDefaultMaps(fs.readFileSync(file, 'utf8'))) {
            for (const [key, value] of entries) {
              const bundled = defaults.get(key);
              if (bundled === undefined) problems.push(`${rel(file)}: ${name} key "${key}" is not in ${rel(defaultFile)}`);
              else if (bundled !== value) problems.push(`${rel(file)}: ${name} key "${key}" is "${value}" but ${rel(defaultFile)} has "${bundled}"`);
            }
          }
        }
        expect(problems).toEqual([]);
      });
    }
  });

  it('CDS references (all services/admin/**/*.cds) exist in services/admin/_i18n/i18n.properties', () => {
    const cdsFiles = walk(ADMIN_ROOT, (f) => f.endsWith('.cds'), new Set(['node_modules', 'gen', 'dist']));
    const refs = referencedKeys(cdsFiles, [BINDING]);
    if (!fs.existsSync(CDS_BUNDLE_DIR)) {
      // No CDS bundle yet: nothing may reference one.
      expect(refs.map(([f, k]) => `${rel(f)}: key "${k}" but services/admin/_i18n does not exist`)).toEqual([]);
      return;
    }
    const defaults = parseProperties(path.join(CDS_BUNDLE_DIR, 'i18n.properties'));
    const unknown = refs.filter(([, k]) => !defaults.has(k)).map(([f, k]) => `${rel(f)}: key "${k}" is not in _i18n/i18n.properties`);
    expect(unknown).toEqual([]);
  });
});
