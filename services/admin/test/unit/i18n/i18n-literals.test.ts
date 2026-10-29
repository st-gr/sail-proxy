import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The inventory of hard-coded cockpit texts (ci/scripts/i18n-literals.js) is a plain node dev tool.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tool = require('../../../../../ci/scripts/i18n-literals.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'i18n-literals');
const VIEW = 'webapp/view/Sample.view.xml';
const CONTROLLER = 'webapp/controller/Sample.controller.ts';

type Hit = { line: number; kind: string; where: string; text: string; allowed?: string };
type FileResult = { file: string; hits: Hit[] };

function scanFixtures(): FileResult[] {
  return tool.run([path.join(FIXTURES, 'webapp')], { allowlistFile: path.join(FIXTURES, 'allowlist.json'), root: FIXTURES });
}

function open(results: FileResult[], file: string): string[] {
  const result = results.find((r) => r.file === file);
  return (result ? result.hits : []).filter((h) => !h.allowed).map((h) => h.text);
}

describe('i18n-literals inventory', () => {
  const results = scanFixtures();

  it('reports text attributes in XML that are not bindings, and literals inside bindings', () => {
    expect(open(results, VIEW)).toEqual([
      'Hard-coded page title',
      'Save the draft',
      'Last Updated:',
      'per month',
      'USD',
      'Requests',
      ' (estimate)',
      'Search & filter',
      'tokens',
      'Company logo'
    ]);
  });

  it('reports literals passed to MessageBox, MessageToast, setters and text-like properties', () => {
    expect(open(results, CONTROLLER)).toEqual([
      'Saved',
      'Loaded ${…} rows',
      'Request failed',
      'Confirm deletion',
      'Ready',
      'Settings',
      'Body text',
      'Requests by Provider',
      'Requests',
      'Enabled',
      'Disabled',
      'Failed: ${…}',
      'Failed',
      'Yes ${…}',
      'No'
    ]);
  });

  it('gives line numbers and the position each hit was found in', () => {
    const hits = results.find((r) => r.file === CONTROLLER)!.hits;
    expect(hits.find((h) => h.text === 'Saved')).toMatchObject({ line: 5, kind: 'call', where: 'MessageToast.show' });
    expect(hits.find((h) => h.text === 'Ready')).toMatchObject({ line: 16, kind: 'call', where: 'setText' });
    expect(hits.find((h) => h.text === 'Settings')).toMatchObject({ line: 17, kind: 'property', where: 'title' });
    const view = results.find((r) => r.file === VIEW)!.hits;
    expect(view.find((h) => h.text === 'Save the draft')).toMatchObject({ line: 4, kind: 'attribute', where: 'tooltip' });
  });

  it('skips bundle keys, key-shaped values, compared ids, callbacks, comments, regexes, console output and non-text attributes', () => {
    const texts = results.flatMap((r) => r.hits.map((h) => h.text));
    for (const absent of ['savedKey', 'deleteMany', 'OK', 'DELETE', 'Commented out', 'A commented-out toast',
      'fallback', 'Debug output is not user-facing', 'Not a text attribute', 'Provider', '10', 'strict', '\n',
      'formKeyPlaceholder', 'metaFlag', 'any']) {
      expect(texts).not.toContain(absent);
    }
  });

  it('reports both branches of a condition, in a call argument and in a property value', () => {
    const hits = results.find((r) => r.file === CONTROLLER)!.hits;
    expect(hits.filter((h) => ['Enabled', 'Disabled'].includes(h.text)).map((h) => h.where)).toEqual(['MessageToast.show', 'MessageToast.show']);
    expect(hits.filter((h) => ['Yes ${…}', 'No'].includes(h.text)).map((h) => h.where)).toEqual(['text', 'text']);
  });

  it('does not scan test folders', () => {
    expect(results.map((r) => r.file).sort()).toEqual([CONTROLLER, VIEW]);
  });

  it('marks allowlisted hits with their reason, globally and per file', () => {
    const all = results.flatMap((r) => r.hits);
    expect(all.find((h) => h.text === 'sap-icon://refresh')).toMatchObject({ allowed: 'icon URIs' });
    expect(all.find((h) => h.text === 'sapUiSizeCompact usageDialog')).toMatchObject({ allowed: 'a CSS class in the MessageBox options' });
  });

  it('exits 1 while non-allowlisted hits remain and 0 when none do', () => {
    const lines: string[] = [];
    const args = [`--allowlist=${path.join(FIXTURES, 'allowlist.json')}`];
    expect(tool.main([...args, path.join(FIXTURES, 'webapp')], (l: string) => lines.push(l))).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^i18n-literals: 26 hard-coded text\(s\) in 2 of 2 file\(s\); 1 allowlisted$/);
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-literals-'));
    fs.writeFileSync(path.join(clean, 'Clean.view.xml'), '<Button text="{i18n>save}" icon="sap-icon://save"/>');
    expect(tool.main([...args, clean], () => undefined)).toBe(0);
  });

  it('requires a reason for every allowlist entry', () => {
    expect(() => tool.applyAllowlist([], 'x', tool.loadAllowlist(path.join(FIXTURES, 'allowlist.json')))).not.toThrow();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-literals-')), 'allowlist.json');
    fs.writeFileSync(file, JSON.stringify({ global: [{ pattern: '^x$' }] }));
    expect(() => tool.loadAllowlist(file)).toThrow(/needs a pattern and a reason/);
  });

  it('keeps the shipped allowlist valid', () => {
    const shipped = path.join(__dirname, '../../../../../ci/scripts/i18n-literals.allowlist.json');
    expect(fs.existsSync(shipped)).toBe(true);
    expect(() => tool.loadAllowlist(shipped)).not.toThrow();
  });
});
