export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const checker = require('../../../cli-tools/check-test-models.js');

const NOW = new Date('2026-09-30T00:00:00Z');

function item(id: string, versions: any[], extra: any = {}) {
  return { id, object: 'model', versions, ...extra };
}

describe('parseModelName', () => {
  it('splits provider prefix, family, version, variant and the deployed suffix', () => {
    expect(checker.parseModelName('anthropic--claude-4.5-haiku--deployed')).toEqual({
      prefix: 'anthropic--', family: 'claude', version: [4, 5], variant: 'haiku', deployed: true,
    });
    expect(checker.parseModelName('gpt-4.1-nano')).toEqual({
      prefix: '', family: 'gpt', version: [4, 1], variant: 'nano', deployed: false,
    });
    expect(checker.parseModelName('gemini-2.0-flash-lite')).toEqual({
      prefix: '', family: 'gemini', version: [2, 0], variant: 'flash-lite', deployed: false,
    });
    expect(checker.parseModelName('amazon--nova-lite')).toEqual({
      prefix: 'amazon--', family: 'nova', version: [], variant: 'lite', deployed: false,
    });
  });

  it('returns null for names it cannot parse', () => {
    expect(checker.parseModelName('')).toBeNull();
    expect(checker.parseModelName('non-existent-model')).toBeNull();
  });
});

describe('classifyModel', () => {
  it('reads routable, deprecated and the earliest retirement date from the versions', () => {
    const m = checker.classifyModel(
      item('gpt-4.1-nano', [
        { name: '1', deprecated: false, retirementDate: '' },
        { name: '2', deprecated: false, retirementDate: '2026-10-15' },
      ], { routable: true }),
      NOW, 30,
    );
    expect(m).toEqual({ id: 'gpt-4.1-nano', routable: true, deprecated: false, retirementDate: '2026-10-15', expiring: true });
  });

  it('treats an empty retirementDate as no date, not as 1970', () => {
    const m = checker.classifyModel(item('gpt-5-nano', [{ name: '1', deprecated: false, retirementDate: '' }]), NOW, 30);
    expect(m.retirementDate).toBeNull();
    expect(m.expiring).toBe(false);
  });

  it('is deprecated only when every version is', () => {
    const half = checker.classifyModel(item('a', [{ deprecated: true }, { deprecated: false }]), NOW, 30);
    const all = checker.classifyModel(item('b', [{ deprecated: true }, { deprecated: true }]), NOW, 30);
    expect(half.deprecated).toBe(false);
    expect(all.deprecated).toBe(true);
  });

  it('defaults routable to true when the gateway sends no routable flag', () => {
    expect(checker.classifyModel(item('c', [{ deprecated: false }]), NOW, 30).routable).toBe(true);
  });
});

describe('proposeSuccessor', () => {
  const models = [
    'anthropic--claude-4-sonnet', 'anthropic--claude-4.5-sonnet', 'anthropic--claude-4.5-haiku',
    'anthropic--claude-4.5-haiku--deployed', 'gpt-4.1-nano', 'gpt-5-nano', 'gemini-2.5-flash-lite',
    'gemini-3.5-flash-lite', 'amazon--nova-lite',
  ].map((id) => checker.classifyModel(item(id, [{ deprecated: false, retirementDate: '' }]), NOW, 30));

  it('picks the highest non-deprecated version of the same prefix, family and variant', () => {
    expect(checker.proposeSuccessor('anthropic--claude-3-haiku', models)).toBe('anthropic--claude-4.5-haiku');
    expect(checker.proposeSuccessor('gemini-2.0-flash-lite', models)).toBe('gemini-3.5-flash-lite');
    expect(checker.proposeSuccessor('gpt-4.1-nano', models)).toBe('gpt-5-nano');
  });

  it('keeps a --deployed name inside the deployed twins', () => {
    expect(checker.proposeSuccessor('anthropic--claude-3-haiku--deployed', models)).toBe('anthropic--claude-4.5-haiku--deployed');
  });

  it('skips deprecated and expiring candidates', () => {
    const withDeprecated = models.concat(
      checker.classifyModel(item('gpt-5.4-nano', [{ deprecated: true }]), NOW, 30),
      checker.classifyModel(item('gpt-5.2-nano', [{ deprecated: false, retirementDate: '2026-10-05' }]), NOW, 30),
    );
    expect(checker.proposeSuccessor('gpt-4.1-nano', withDeprecated)).toBe('gpt-5-nano');
  });

  it('returns null when the family has no sibling left', () => {
    expect(checker.proposeSuccessor('text-embedding-3-small', models)).toBeNull();
  });

  it('never proposes the name itself or a downgrade: gpt-5-nano stays null next to the lower gpt-4.1-nano', () => {
    expect(checker.proposeSuccessor('gpt-5-nano', models)).toBeNull();
  });

  it('gives a versionless name its first versioned sibling', () => {
    const modelsWithNova2 = models.concat(
      checker.classifyModel(item('amazon--nova-2-lite', [{ deprecated: false, retirementDate: '' }]), NOW, 30),
    );
    expect(checker.proposeSuccessor('amazon--nova-lite', modelsWithNova2)).toBe('amazon--nova-2-lite');
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-test-models-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const TABLE = [
  "export const liveModels = {",
  "  cheapChat: 'gpt-4.1-nano',",
  "  claude: 'anthropic--claude-3-haiku',",
  "  deployedTwin: 'anthropic--claude-3-haiku--deployed',",
  "  embedding: 'text-embedding-3-small',",
  "} as const;",
  "",
].join('\n');

describe('scanTestTree', () => {
  it('finds model literals, marks live-call files, and ignores non-existent- names', () => {
    const root = makeTree({
      'services/ollama/test/integration/a.test.js':
        "const { getOllama" + "ServiceUrl } = require('@libs/test-utils');\npost({ model: 'gpt-4.1-nano' }); post({ model: 'non-existent-model' });",
      'services/gateway/test/b.test.ts': "const MODEL = 'anthropic--claude-4.8-opus';",
      'services/gateway/src/not-a-test.ts': "const x = 'gpt-5';",
    });
    const findings = checker.scanTestTree(root).sort((p: any, q: any) => p.name.localeCompare(q.name));
    expect(findings).toEqual([
      { file: 'services/gateway/test/b.test.ts', name: 'anthropic--claude-4.8-opus', live: false },
      { file: 'services/ollama/test/integration/a.test.js', name: 'gpt-4.1-nano', live: true },
    ]);
  });

  it('counts only Ollama and SAP-key files as live-call, not gateway-url or describeLive files', () => {
    const root = makeTree({
      'services/admin/test/config.test.ts':
        "const u = get" + "GatewayUrl(); const a = process.env.ADMIN_SERVICE" + "_URL; describe" + "Live('x', () => {}); const m = 'gpt-4';",
      'services/gateway/test/sap.test.ts':
        "const k = process.env.SAP_AI_CORE_SERVICE" + "_KEY; const m = 'gpt-3.5-turbo';",
    });
    const findings = checker.scanTestTree(root).sort((p: any, q: any) => p.name.localeCompare(q.name));
    expect(findings).toEqual([
      { file: 'services/gateway/test/sap.test.ts', name: 'gpt-3.5-turbo', live: true },
      { file: 'services/admin/test/config.test.ts', name: 'gpt-4', live: false },
    ]);
  });

  it('never classifies its own test file as live-call', () => {
    const findings = checker.scanTestTree(path.resolve(__dirname, '../../..'));
    const own = findings.filter((f: any) => f.live === true && f.file === 'services/gateway/test/check-test-models.test.ts');
    expect(own).toEqual([]);
  });

  it('counts the file-search live gates and the Ollama base-URL variable as live-call', () => {
    const root = makeTree({
      'services/gateway/test/fs.test.ts': "const g = process.env." + "FILE_SEARCH_" + "LIVE_GATE; const m = 'gpt-3.5-turbo';",
      'services/ollama/test/o.test.js': "const u = process.env." + "OLLAMA_" + "BASE_URL; const m = 'gpt-4';",
    });
    const findings = checker.scanTestTree(root).sort((p: any, q: any) => p.name.localeCompare(q.name));
    expect(findings).toEqual([
      { file: 'services/gateway/test/fs.test.ts', name: 'gpt-3.5-turbo', live: true },
      { file: 'services/ollama/test/o.test.js', name: 'gpt-4', live: true },
    ]);
  });
});

describe('readLiveTable / applyToTable', () => {
  it('reads one role per line', () => {
    const root = makeTree({ 'libs/test-utils/src/live-models.ts': TABLE });
    expect(checker.readLiveTable(path.join(root, 'libs/test-utils/src/live-models.ts'))).toEqual([
      { role: 'cheapChat', name: 'gpt-4.1-nano', line: 2 },
      { role: 'claude', name: 'anthropic--claude-3-haiku', line: 3 },
      { role: 'deployedTwin', name: 'anthropic--claude-3-haiku--deployed', line: 4 },
      { role: 'embedding', name: 'text-embedding-3-small', line: 5 },
    ]);
  });

  it('rewrites only the given roles and leaves everything else byte-identical', () => {
    const root = makeTree({ 'libs/test-utils/src/live-models.ts': TABLE });
    const file = path.join(root, 'libs/test-utils/src/live-models.ts');
    const changed = checker.applyToTable(file, { claude: 'anthropic--claude-4.5-haiku', deployedTwin: 'anthropic--claude-4.5-haiku--deployed' });
    expect(changed).toEqual(['claude', 'deployedTwin']);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      TABLE.replace("'anthropic--claude-3-haiku'", "'anthropic--claude-4.5-haiku'")
           .replace("'anthropic--claude-3-haiku--deployed'", "'anthropic--claude-4.5-haiku--deployed'"),
    );
  });
});

describe('run', () => {
  const live = (ids: string[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ object: 'list', data: ids.map((id) => item(id, [{ deprecated: false, retirementDate: '' }])) }),
  });

  function fixtureRepo() {
    return makeTree({
      'libs/test-utils/src/live-models.ts': TABLE,
      'services/ollama/test/integration/a.test.js':
        "const { getOllama" + "ServiceUrl } = require('@libs/test-utils');\npost({ model: 'gpt-4.1-nano' });",
      'services/gateway/test/b.test.ts': "const MODEL = 'anthropic--claude-2-opus';",
    });
  }

  it('exits 0 when every live name is listed and current', async () => {
    const root = makeTree({
      'libs/test-utils/src/live-models.ts': "export const liveModels = {\n  cheapChat: 'gpt-4.1-nano',\n} as const;\n",
    });
    const logs: string[] = [];
    const code = await checker.run({ root, fetchImpl: async () => live(['gpt-4.1-nano']), log: (s: string) => logs.push(s), now: NOW });
    expect(code).toBe(0);
  });

  it('exits 1 and names the successor when a table name is not listed (retired or unknown)', async () => {
    const root = fixtureRepo();
    const logs: string[] = [];
    const code = await checker.run({
      root, now: NOW, log: (s: string) => logs.push(s),
      fetchImpl: async () => live(['gpt-4.1-nano', 'anthropic--claude-4.5-haiku', 'anthropic--claude-4.5-haiku--deployed', 'text-embedding-3-small']),
    });
    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(out).toMatch(/anthropic--claude-3-haiku .*not listed by the gateway \(retired or unknown\).*anthropic--claude-4\.5-haiku/);
    expect(out).toMatch(/anthropic--claude-2-opus .*mocked/); // reported, never failing
  });

  it('with --apply rewrites the table, keeps a role with no successor, and still exits 1', async () => {
    const root = fixtureRepo();
    const code = await checker.run({
      root, now: NOW, apply: true, log: () => {},
      fetchImpl: async () => live(['gpt-4.1-nano', 'anthropic--claude-4.5-haiku', 'anthropic--claude-4.5-haiku--deployed']),
    });
    expect(code).toBe(1); // text-embedding-3-small: not listed, no sibling
    const table = fs.readFileSync(path.join(root, 'libs/test-utils/src/live-models.ts'), 'utf8');
    expect(table).toContain("claude: 'anthropic--claude-4.5-haiku',");
    expect(table).toContain("deployedTwin: 'anthropic--claude-4.5-haiku--deployed',");
    expect(table).toContain("embedding: 'text-embedding-3-small',");
  });

  it('exits 2 with the SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES hint when items carry no versions', async () => {
    const root = fixtureRepo();
    const logs: string[] = [];
    const code = await checker.run({
      root, now: NOW, log: (s: string) => logs.push(s),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4.1-nano', object: 'model' }] }) }),
    });
    expect(code).toBe(2);
    expect(logs.join('\n')).toMatch(/SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES=true/);
  });

  it('exits 2 without fetching when the live-model table is missing', async () => {
    const root = makeTree({ 'services/gateway/test/b.test.ts': "const MODEL = 'gpt-4';" });
    const logs: string[] = [];
    const fetchImpl = jest.fn(async () => live(['gpt-4.1-nano']));
    const code = await checker.run({ root, now: NOW, log: (s: string) => logs.push(s), fetchImpl });
    expect(code).toBe(2);
    expect(logs.join('\n')).toContain('no live-model table');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exits 2 when the gateway answers non-2xx', async () => {
    const root = fixtureRepo();
    const code = await checker.run({ root, now: NOW, log: () => {}, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    expect(code).toBe(2);
  });
});
