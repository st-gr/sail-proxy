import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));
import { recordToolUsage, recordRejectedTools, applyRetention, retentionSettings, normaliseAgent, TOOL_USAGE, TOOL_USAGE_DAILY, TOOL_USAGE_AGENT_DAILY, DEFAULT_RAW_DAYS, DEFAULT_DAILY_DAYS } from '../../../src/services/toolUsageService';

const event = (over: any = {}) => ({
  requestId: 'r-' + Math.random().toString(36).slice(2), timestamp: Math.floor(Date.now() / 1000), authType: 'api_key', credentialId: '11111111-1111-1111-1111-111111111111',
  provider: 'anthropic', model: 'claude', endpoint: '/anthropic/v1/messages', statusCode: 200,
  tools: [
    { identity: 'function:a', facet: 'declared', count: 1, decision: 'allowed' },
    { identity: 'function:b', facet: 'declared', count: 1, decision: 'stripped' },
    { identity: 'function:a', facet: 'invoked', count: 2, decision: 'allowed' }
  ], ...over
});

describe('toolUsageService', () => {
  let db: any;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('writes one raw row per tool entry and upserts the daily aggregates', async () => {
    await db.run(async (tx: any) => recordToolUsage(tx, [event(), event()], () => 'tu@test.com'));
    const raw = await db.run(cds.ql.SELECT.from(TOOL_USAGE).where({ email: 'tu@test.com' }));
    expect(raw).toHaveLength(6);
    expect(raw.find((r: any) => r.facet === 'invoked')).toMatchObject({ identity: 'function:a', count: 2, decision: 'allowed', provider: 'anthropic', model: 'claude' });
    const daily = await db.run(cds.ql.SELECT.from(TOOL_USAGE_DAILY).where({ email: 'tu@test.com' }).orderBy('identity', 'facet'));
    expect(daily.map((d: any) => [d.identity, d.facet, d.requests, d.allowed, d.stripped])).toEqual([
      ['function:a', 'declared', 2, 2, 0], ['function:a', 'invoked', 2, 4, 0], ['function:b', 'declared', 2, 0, 2]
    ]);
    expect(daily[0].lastSeen).toBeTruthy();
  });

  it('ignores events without tools', async () => {
    await db.run(async (tx: any) => recordToolUsage(tx, [event({ tools: undefined }), event({ tools: [] })], () => 'none@test.com'));
    expect(await db.run(cds.ql.SELECT.from(TOOL_USAGE).where({ email: 'none@test.com' }))).toHaveLength(0);
  });

  it('reads retention from the platform block with defaults', async () => {
    const s = await retentionSettings(db);
    expect(s.rawDays).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_RAW_DAYS).toBe(30);
    expect(DEFAULT_DAILY_DAYS).toBe(400);
  });

  it('purges raw rows past rawDays and aggregates past dailyDays, keeps the rest', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await db.run(cds.ql.INSERT.into(TOOL_USAGE).entries([{ ID: cds.utils.uuid(), email: 'ret@test.com', identity: 'function:old', facet: 'declared', count: 1, decision: 'allowed', validFrom: old }]));
    await db.run(cds.ql.INSERT.into(TOOL_USAGE_DAILY).entries([
      { email: 'ret@test.com', day: '2020-01-01', identity: 'function:old', facet: 'declared', requests: 1 },
      { email: 'ret@test.com', day: new Date().toISOString().slice(0, 10), identity: 'function:new', facet: 'declared', requests: 1 }
    ]));
    const r = await applyRetention(db, new Date(), { rawDays: 30, dailyDays: 400 });
    expect(r.rawDeleted).toBeGreaterThanOrEqual(1);
    expect(r.dailyDeleted).toBe(1);
    expect(await db.run(cds.ql.SELECT.from(TOOL_USAGE).where({ identity: 'function:old' }))).toHaveLength(0);
    expect(await db.run(cds.ql.SELECT.from(TOOL_USAGE_DAILY).where({ identity: 'function:new' }))).toHaveLength(1);
  });
});

describe('normaliseAgent', () => {
  it('reduces a User-Agent to the client program that sent it', () => {
    expect(normaliseAgent('claude-cli/2.0.1 (external, cli)')).toBe('claude-cli');
    expect(normaliseAgent('openai-python/1.99.1')).toBe('openai-python');
    expect(normaliseAgent('axios/1.18.0')).toBe('axios');
    expect(normaliseAgent('Codex')).toBe('codex');
  });
  it('falls back to unknown and never grows past the column', () => {
    expect(normaliseAgent(undefined)).toBe('unknown');
    expect(normaliseAgent('')).toBe('unknown');
    expect(normaliseAgent('   ')).toBe('unknown');
    expect(normaliseAgent('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('agent breakdown', () => {
  let db: any;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('keeps the full User-Agent on the raw rows and one daily row per client program', async () => {
    const claude = event({ userAgent: 'claude-cli/2.0.1 (external)' });
    const codex = event({ userAgent: 'codex/0.4.2' });
    await db.run(async (tx: any) => recordToolUsage(tx, [claude, claude, codex], () => 'agent@test.com'));
    const raw = await db.run(cds.ql.SELECT.from(TOOL_USAGE).where({ email: 'agent@test.com' }));
    expect(new Set(raw.map((r: any) => r.userAgent))).toEqual(new Set(['claude-cli/2.0.1 (external)', 'codex/0.4.2']));
    const perAgent = await db.run(cds.ql.SELECT.from(TOOL_USAGE_AGENT_DAILY).where({ email: 'agent@test.com' }).orderBy('identity', 'facet', 'agent'));
    expect(perAgent.map((a: any) => [a.identity, a.facet, a.agent, a.requests])).toEqual([
      ['function:a', 'declared', 'claude-cli', 2], ['function:a', 'declared', 'codex', 1],
      ['function:a', 'invoked', 'claude-cli', 2], ['function:a', 'invoked', 'codex', 1],
      ['function:b', 'declared', 'claude-cli', 2], ['function:b', 'declared', 'codex', 1]
    ]);
    expect(perAgent[0].lastSeen).toBeTruthy();
  });

  it('records an event without a User-Agent under unknown', async () => {
    await db.run(async (tx: any) => recordToolUsage(tx, [event()], () => 'noagent@test.com'));
    const rows = await db.run(cds.ql.SELECT.from(TOOL_USAGE_AGENT_DAILY).where({ email: 'noagent@test.com' }));
    expect(new Set(rows.map((r: any) => r.agent))).toEqual(new Set(['unknown']));
  });

  it('purges the per-agent rows with the daily retention', async () => {
    await db.run(cds.ql.INSERT.into(TOOL_USAGE_AGENT_DAILY).entries([
      { email: 'ret@test.com', day: '2020-01-01', identity: 'function:old', facet: 'declared', agent: 'codex', requests: 1 }
    ]));
    await applyRetention(db, new Date(), { rawDays: 30, dailyDays: 10 });
    expect(await db.run(cds.ql.SELECT.from(TOOL_USAGE_AGENT_DAILY).where({ email: 'ret@test.com' }))).toHaveLength(0);
  });
});

describe('recordRejectedTools', () => {
  let db: any;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  const rejection = (over: any = {}) => ({
    requestId: 'rej-1', timestamp: new Date().toISOString(), authType: 'api_key',
    credentialId: '11111111-2222-3333-4444-555555555555', endpoint: '/openai/v1/responses',
    userAgent: 'codex-tui/0.149.1 (Mac OS)', metadata: {
      mode: 'reject', policy: 'Default + test', model: 'gpt-4.1-nano',
      tools: [{ identity: 'hosted:web_search', facet: 'declared', decision: 'rejected' }]
    }, ...over
  });

  it('records a refused tool as an attempt: raw row, daily counter and agent, no usage row', async () => {
    const n = await recordRejectedTools(db, rejection(), 'rej@test.com');
    expect(n).toBe(1);
    const raw = await db.run(cds.ql.SELECT.from(TOOL_USAGE).where({ email: 'rej@test.com' }));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ identity: 'hosted:web_search', facet: 'declared', decision: 'rejected', model: 'gpt-4.1-nano', endpoint: '/openai/v1/responses' });
    const daily = await db.run(cds.ql.SELECT.from(TOOL_USAGE_DAILY).where({ email: 'rej@test.com' }));
    expect(daily[0]).toMatchObject({ identity: 'hosted:web_search', requests: 1, rejected: 1, allowed: 0 });
    const agents = await db.run(cds.ql.SELECT.from(TOOL_USAGE_AGENT_DAILY).where({ email: 'rej@test.com' }));
    expect(agents[0]).toMatchObject({ agent: 'codex-tui', requests: 1 });
  });

  it('bumps the counter of a tool the inventory already knows instead of adding a second entry', async () => {
    await recordRejectedTools(db, rejection({ requestId: 'rej-2' }), 'rej@test.com');
    const daily = await db.run(cds.ql.SELECT.from(TOOL_USAGE_DAILY).where({ email: 'rej@test.com' }));
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ requests: 2, rejected: 2 });
  });

  it('ignores an event that carries no refused tools, and a strip event', async () => {
    expect(await recordRejectedTools(db, rejection({ metadata: { mode: 'reject' } }), 'none@test.com')).toBe(0);
    expect(await recordRejectedTools(db, rejection({ metadata: { mode: 'strip', tools: [{ identity: 'function:x', facet: 'declared', decision: 'rejected' }] } }), 'none@test.com')).toBe(0);
    expect(await db.run(cds.ql.SELECT.from(TOOL_USAGE).where({ email: 'none@test.com' }))).toHaveLength(0);
  });

  /**
   * `detected` is the verdict for a tool the policy denies that was USED without being prevented:
   * a nested MCP call inside a client's own container tool, seen in the response. It is counted
   * like any other decision, and it never inflates `rejected`, which means the call was stopped.
   */
  it('counts a detected nested call in its own column, apart from rejected', async () => {
    await db.run(async (tx: any) => recordToolUsage(tx, [event({
      tools: [
        { identity: 'mcp:ps_exec_remote/run_powershell', facet: 'invoked', count: 2, decision: 'detected' },
        { identity: 'hosted:web_search', facet: 'declared', count: 1, decision: 'rejected' }
      ]
    })], () => 'nested@test.com'));
    const daily = await db.run(cds.ql.SELECT.from(TOOL_USAGE_DAILY).where({ email: 'nested@test.com' }).orderBy('identity'));
    expect(daily.find((r: any) => r.identity === 'mcp:ps_exec_remote/run_powershell'))
      // one event carrying two calls: requests counts the events, the verdict counts the calls
      .toMatchObject({ facet: 'invoked', requests: 1, detected: 2, rejected: 0, unlisted: 0, allowed: 0 });
    expect(daily.find((r: any) => r.identity === 'hosted:web_search')).toMatchObject({ rejected: 1, detected: 0 });
    const raw = await db.run(cds.ql.SELECT.from(TOOL_USAGE).where({ email: 'nested@test.com', decision: 'detected' }));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ identity: 'mcp:ps_exec_remote/run_powershell', facet: 'invoked', count: 2 });
  });
});
