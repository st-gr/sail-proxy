import * as fs from 'fs';
import * as path from 'path';
import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { API_CONFIG_GROUPS, groupSections, resolveGroupSchema } from '../webapp/model/apiConfigGroups';
import { mapEntryDescriptor, mapSectionEntries, mapSpecOf } from '../webapp/model/formContainers';
import { pluginFor } from '../webapp/model/formPlugins';
import { Descriptor, JsonSchemaNode, buildDescriptors, labelFor, mapEntriesOf, resolveRefsDeep } from '../webapp/model/schemaForm';
import {
  ENGLISH_SCHEMA_TEXTS,
  SchemaTexts,
  SchemaTranslator,
  childTextPath,
  entryTextPath,
  itemsTextPath,
  mapEntryTexts,
  schemaTexts,
  textPathOfPointer
} from '../webapp/model/schemaTexts';

/**
 * The configuration form's field texts come from the config-app bundle (`schemaTexts.ts`), and the
 * bundle's `schema.*` keys are generated from the schema by `ci/scripts/schema-texts.js`. This suite
 * is what holds the three together:
 *
 * - the SYNC CHECK: every field of the schema has its label key, and its description key where the
 *   schema has a description, in the default bundle, with the schema's own English byte for byte -
 *   so a schema change fails here until the generator has been run (and a fake new field proves it);
 * - the RENDERED English: the whole form, built for real documents through the bundle, is identical
 *   to the form built without one, and every text it looks up is a key the generator writes.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const generator = require('../../../../../ci/scripts/schema-texts.js') as {
  collectSchemaTexts(schema: unknown): Array<[string, string]>;
  labelFor(key: string): string;
  renderBundle(text: string, entries: Array<[string, string]>, keepExisting: boolean): string;
  renderLock(entries: Array<[string, string]>): string;
  lockProblems(entries: Array<[string, string]>, lock: Record<string, string>): string[];
  SCHEMA_FILE: string;
  BUNDLE_DIR: string;
  LOCK_FILE: string;
};

const BUNDLE_FILE = path.join(__dirname, '..', 'webapp', 'i18n', 'i18n.properties');

/** A .properties file as UI5 reads it: continuations joined, escapes resolved. */
function readBundle(file: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    }
    const m = /^((?:\\.|[^=:\s\\])+)\s*[=:]?\s*(.*)$/s.exec(line);
    if (!m) continue;
    out.set(m[1], m[2].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_all, c: string) =>
      c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === 'f' ? '\f' : c));
  }
  return out;
}

/** The sync check itself: what the bundle lacks or holds differently from the schema's English. */
function schemaTextProblems(schema: unknown, bundle: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, english] of generator.collectSchemaTexts(schema)) {
    const bundled = bundle.get(key);
    if (bundled === undefined) {
      problems.push(`missing ${key}`);
    } else if (bundled !== english) {
      problems.push(`differs ${key}: bundle has "${bundled}", the schema says "${english}"`);
    }
  }
  return problems;
}

const bundle = readBundle(BUNDLE_FILE);
const schemaJson = JSON.parse(fs.readFileSync(generator.SCHEMA_FILE, 'utf8'));

describe('schemaTexts', () => {
  it('derives paths below api_config, with _entry for a map key and items for an array element', () => {
    expect(textPathOfPointer('/api_config/platform/quotas')).toBe('platform.quotas');
    expect(childTextPath('platform.quotas', 'tokensPerDay')).toBe('platform.quotas.tokensPerDay');
    expect(entryTextPath('models.overrides')).toBe('models.overrides._entry');
    expect(itemsTextPath('observability.siem.sinks')).toBe('observability.siem.sinks.items');
    expect(childTextPath('', 'providers')).toBe('providers');
    expect(childTextPath(undefined, 'x')).toBeUndefined();
  });

  it('keys a declared map key by itself and any other key as the map\'s _entry', () => {
    const container = { properties: { openai: {} } };
    expect(mapEntryTexts(ENGLISH_SCHEMA_TEXTS, 'providers', container, 'openai')).toMatchObject({ path: 'providers.openai', declared: true });
    expect(mapEntryTexts(ENGLISH_SCHEMA_TEXTS, 'providers', container, 'my-gateway')).toMatchObject({ path: 'providers._entry', declared: false });
  });

  it('returns the bundle text for a known key and the English for an unknown one', () => {
    const known: Record<string, string> = { 'schema.platform.quotas.label': 'Kontingente' };
    // `ConfigForm._text` answers the key itself for a key the bundle does not have.
    const texts = schemaTexts(key => known[key] ?? key);
    expect(texts.label('platform.quotas', 'Quotas')).toBe('Kontingente');
    expect(texts.description('platform.quotas', 'Per-user limits.')).toBe('Per-user limits.');
    expect(schemaTexts(() => undefined).label('platform.quotas', 'Quotas')).toBe('Quotas');
    expect(schemaTexts(() => '').label('platform.quotas', 'Quotas')).toBe('Quotas');
    expect(ENGLISH_SCHEMA_TEXTS.label('platform.quotas', 'Quotas')).toBe('Quotas');
  });

  it('never looks up a path that cannot be a key', () => {
    const asked: string[] = [];
    const texts = schemaTexts(key => { asked.push(key); return 'translated'; });
    expect(texts.label(undefined, 'A')).toBe('A');
    expect(texts.label('', 'A')).toBe('A');
    expect(texts.label('models.overrides.gpt-4o.1', 'A')).toBe('translated');
    expect(texts.label('models.overrides.a b', 'A')).toBe('A');
    expect(texts.label('x.a/b', 'A')).toBe('A');
    expect(asked).toEqual(['schema.models.overrides.gpt-4o.1.label']);
  });
});

describe('the generator', () => {
  it('derives labels exactly as the form does, for every property key of the schema', () => {
    const keys = new Set<string>();
    (function walk(node: unknown): void {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const record = node as Record<string, unknown>;
      if (record.properties && typeof record.properties === 'object') Object.keys(record.properties).forEach(k => keys.add(k));
      Object.values(record).forEach(walk);
    })(schemaJson);
    expect(keys.size).toBeGreaterThan(150);
    const differing = [...keys].filter(key => generator.labelFor(key) !== labelFor(key));
    expect(differing).toEqual([]);
    // The two shapes the derivation special-cases, so a copy that lost them cannot pass by accident.
    expect(generator.labelFor('api_key_env')).toBe('API Key');
    expect(generator.labelFor('allow_unmasked_content')).toBe('Allow Unmasked Content');
  });

  it('gives every path one key per text, all within the guard\'s key charset', () => {
    const entries = generator.collectSchemaTexts(schemaJson);
    const keys = entries.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter(key => !/^schema\.[A-Za-z0-9_.-]+\.(label|description)$/.test(key))).toEqual([]);
    // Maps, arrays and composed providers all land on stable keys.
    expect(keys).toEqual(expect.arrayContaining([
      'schema.models.overrides._entry.description',
      'schema.models.overrides._entry.pseudonymization.method.label',
      'schema.observability.siem.sinks.items.url.description',
      'schema.providers.openai.supports_responses_api.label',
      'schema.providers._entry.supports_responses_api.label',
      'schema.platform.quotas.tokensPerDay.label'
    ]));
    // A map entry's label is its key (document data), so no _entry path carries a label key.
    expect(keys.filter(key => /\._entry\.label$/.test(key))).toEqual([]);
    expect(new Map(entries).get('schema.platform.quotas.tokensPerDay.label')).toBe('Tokens per Day');
  });

  it('refuses a path that would carry two different English texts', () => {
    const conflicting = {
      properties: {
        api_config: {
          type: 'object',
          properties: {
            m: {
              type: 'object',
              patternProperties: { '^a': { type: 'string', description: 'one' }, '^b': { type: 'string', description: 'two' } }
            }
          }
        }
      }
    };
    expect(() => generator.collectSchemaTexts(conflicting)).toThrow(/m\._entry\.description/);
  });

  it('keeps an existing translation, adds a missing key as English and drops a stale one', () => {
    const entries: Array<[string, string]> = [['schema.a.label', 'A'], ['schema.b.label', 'B']];
    const before = 'x=1\n\nschema.a.label=Ah\nschema.gone.label=Gone\n';
    const after = generator.renderBundle(before, entries, true);
    expect(after).toContain('schema.a.label=Ah\n');
    expect(after).toContain('schema.b.label=B\n');
    expect(after).not.toContain('schema.gone.label');
    expect(after.startsWith('x=1\n')).toBe(true);
    expect(generator.renderBundle(after, entries, true)).toBe(after);
    // The English files are regenerated, not kept.
    expect(generator.renderBundle(before, entries, false)).toContain('schema.a.label=A\n');
  });
});

describe('the sync check', () => {
  it('finds every schema field\'s keys in the default bundle with the schema\'s English', () => {
    expect(schemaTextProblems(schemaJson, bundle)).toEqual([]);
  });

  it('fails for a new schema field until its keys are generated', () => {
    const changed = JSON.parse(JSON.stringify(schemaJson));
    changed.$defs.platformGroup.properties.security.properties.sessionLockMinutes = {
      type: 'integer',
      description: 'A field added to the schema after the bundle was generated.'
    };
    changed.$defs.platformGroup.properties.quotas.properties.tokensPerDay.title = 'Daily Tokens';
    expect(schemaTextProblems(changed, bundle)).toEqual([
      'differs schema.platform.quotas.tokensPerDay.label: bundle has "Tokens per Day", the schema says "Daily Tokens"',
      'missing schema.platform.security.sessionLockMinutes.label',
      'missing schema.platform.security.sessionLockMinutes.description'
    ].sort((a, b) => order(changed, a) - order(changed, b)));
  });
});

describe('the translation lock', () => {
  const lockText = fs.readFileSync(generator.LOCK_FILE, 'utf8');
  const lock = JSON.parse(lockText) as Record<string, string>;
  const entries = generator.collectSchemaTexts(schemaJson);

  it('holds every schema text with the English the six languages were checked against, in generator order', () => {
    expect(generator.lockProblems(entries, lock)).toEqual([]);
    expect(lockText).toBe(generator.renderLock(entries));
  });

  it('fails a new field and a reworded English, key by key, until they are accepted', () => {
    const changed = JSON.parse(JSON.stringify(schemaJson));
    changed.$defs.platformGroup.properties.security.properties.sessionLockMinutes = {
      type: 'integer',
      description: 'A field added to the schema after the translations were checked.'
    };
    const quota = changed.$defs.platformGroup.properties.quotas.properties.tokensPerDay;
    quota.description = `${quota.description} Reworded.`;
    const changedEntries = generator.collectSchemaTexts(changed);
    const at = (problem: string): number => changedEntries.findIndex(([key]) => key === problem.split(':')[0]);
    const expected = [
      'schema.platform.quotas.tokensPerDay.description: English reworded: re-check the six translations, then run --accept',
      'schema.platform.security.sessionLockMinutes.label: new field: translate in de..nl, then run --accept',
      'schema.platform.security.sessionLockMinutes.description: new field: translate in de..nl, then run --accept'
    ].sort((a, b) => at(a) - at(b));
    expect(generator.lockProblems(changedEntries, lock)).toEqual(expected);
    // --accept writes the lock from these texts, after which nothing is reported.
    expect(generator.lockProblems(changedEntries, JSON.parse(generator.renderLock(changedEntries)))).toEqual([]);
  });

  it('reports a locked key the schema no longer has', () => {
    expect(generator.lockProblems(entries.slice(1), lock)).toEqual([`${entries[0][0]}: no longer in the schema: run --accept`]);
  });
});

/** Where a problem's key sits in the generator's own order, so the expectation reads in schema order. */
function order(schema: unknown, problem: string): number {
  const key = problem.split(' ')[1].replace(/:$/, '');
  return generator.collectSchemaTexts(schema).findIndex(([k]) => k === key);
}

// --- the rendered form ---------------------------------------------------------------------------

/** One text the form shows, by where it shows it. */
interface Shown {
  pointer: string;
  label: string;
  description?: string;
  /** A table cell: its label is not shown (the column header is the JSON name), only its tooltip. */
  cell?: true;
  /** This is a map container, so its children's labels are their keys. */
  map?: true;
}

/**
 * Every label and description the form shows for `document`, collected the way `ConfigFormTabs`
 * builds the tabs - section panel headers, map containers and their entries, and every descriptor
 * below them - with the same texts handed in. The loop mirrors the controller (which imports
 * `sap/*` and cannot be loaded here); the rules are the exported functions it calls.
 */
function shownTexts(document: Record<string, unknown>, texts: SchemaTexts): Shown[] {
  const root = apiConfigSchema as unknown as JsonSchemaNode;
  const groups = (document.api_config as Record<string, unknown>) ?? {};
  const shown: Shown[] = [];

  const walk = (descriptors: Descriptor[], cell = false): void => {
    for (const d of descriptors) {
      shown.push({
        pointer: d.pointer,
        label: d.label,
        description: (d as { description?: string }).description,
        ...(cell ? { cell: true as const } : {}),
        ...(d.kind === 'section' && d.mapEntries ? { map: true as const } : {})
      });
      if (d.kind === 'section') walk(d.children);
      if (d.kind === 'table') d.rows.forEach(row => walk(row, true));
    }
  };

  const content = (schema: JsonSchemaNode, data: unknown, pointer: string, declared?: Array<{ key: string; pointer: string; schema: JsonSchemaNode }>): void => {
    const marker = mapEntriesOf(schema, root);
    if (!marker) {
      walk(buildDescriptors(schema as object, data, pointer, pluginFor, { texts }));
      return;
    }
    const containerPath = textPathOfPointer(pointer);
    shown.push({ pointer, label: texts.label(containerPath, labelFor(pointer.slice(pointer.lastIndexOf('/') + 1))), map: true });
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
    const entries = mapSectionEntries({ spec: mapSpecOf(pointer, marker), containerSchema: schema, containerData: data as Record<string, unknown>, declared });
    walk(entries.map(entry => mapEntryDescriptor(entry, root, pluginFor, undefined, mapEntryTexts(texts, containerPath, schema, entry.key))));
  };

  for (const group of API_CONFIG_GROUPS) {
    const groupSchema = resolveRefsDeep(resolveGroupSchema(apiConfigSchema, group), root);
    const groupData = (groups[group] ?? undefined) as Record<string, unknown> | undefined;
    const sections = groupSections(apiConfigSchema, group, groupData);
    if (mapEntriesOf(groupSchema, root)) {
      content(groupSchema, groupData, `/api_config/${group}`, sections);
      continue;
    }
    for (const section of sections) {
      // The section's own panel header (`ConfigFormTabs.buildSectionPanel`).
      shown.push({ pointer: section.pointer, label: texts.label(textPathOfPointer(section.pointer), (typeof section.schema.title === 'string' && section.schema.title) || labelFor(section.key)) });
      content(section.schema, groupData ? groupData[section.key] : undefined, section.pointer);
    }
  }
  return shown;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gatewayShipped = require('../../../../gateway/api_config.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminShipped = require('../../../api_config.json');

/** The shipped document with the dynamic shapes it does not carry added: an undeclared provider and an override's hooks. */
function richDocument(): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(gatewayShipped));
  const api = doc.api_config;
  api.providers['custom-provider'] = { substitute_models: [{ from: 'a', to: 'b' }], param_renames: { max_tokens: 'max_completion_tokens' } };
  api.models = api.models ?? {};
  api.models.overrides = api.models.overrides ?? {};
  api.models.overrides['example-model'] = {
    hooks: { 'chat/completions': [{ request: { callback: { id: 'cb' }, match: [] } }] },
    pseudonymization: { enabled: true }
  };
  return doc;
}

const DOCUMENTS: Array<[string, Record<string, unknown>]> = [
  ['the gateway\'s shipped configuration', gatewayShipped],
  ['the admin\'s shipped configuration', adminShipped],
  ['a richer document (undeclared provider, override hooks)', richDocument()],
  ['an empty document (every section absent)', { api_config: {} }]
];

const generated = new Map(generator.collectSchemaTexts(schemaJson));

describe.each(DOCUMENTS)('the form for %s', (_name, document) => {
  it('shows the same English through the bundle as without it', () => {
    const viaBundle = schemaTexts(key => bundle.get(key) ?? key);
    expect(shownTexts(document, viaBundle)).toEqual(shownTexts(document, ENGLISH_SCHEMA_TEXTS));
  });

  it('looks up every description, and every schema label, under a key the generator writes', () => {
    const asked = new Map<string, string>();
    const marker: SchemaTranslator = key => { asked.set(`«${key}»`, key); return `«${key}»`; };
    const shown = shownTexts(document, schemaTexts(marker));
    // Every description shown is a looked-up one: no schema description reaches the form untranslated.
    expect(shown.filter(s => s.description !== undefined && !asked.has(s.description)).map(s => `${s.pointer}: ${s.description}`)).toEqual([]);
    // A label left unlooked-up is document data - a map entry's key, an array element's name - or a
    // table cell's, which is not shown; never a declared property's.
    const maps = new Set(shown.filter(s => s.map).map(s => s.pointer));
    const isData = (s: Shown): boolean =>
      s.cell === true || /\/\d+$/.test(s.pointer) || maps.has(s.pointer.slice(0, s.pointer.lastIndexOf('/')));
    expect(shown.filter(s => !asked.has(s.label) && !isData(s)).map(s => `${s.pointer}: ${s.label}`)).toEqual([]);
    // Every key the form asked for is one the generator writes.
    expect([...asked.values()].filter(key => !generated.has(key))).toEqual([]);
  });
});
