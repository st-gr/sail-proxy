/**
 * The search of payload traces (srv/payload-trace-search.ts), run as a database query: the whole text,
 * literally and case-insensitively, in the masked prompt and answer and the request's facts, never in
 * the sealed prompt. In-memory SQLite; TRACE_TEST_POSTGRES runs it against a throwaway PostgreSQL.
 */
import { connectTraceTestDb } from '../services/trace-test-db';
import { payloadTraceSearchCondition, PAYLOAD_TRACE_SEARCH_COLUMNS } from '../../../src/srv/payload-trace-search';

const cds = require('@sap/cds');

const TRACES = 'sap.llm.gateway.admin.PayloadTraces';
const row = (ID: string, over: any) => ({ ID, requestId: `req-${ID}`, capturedAt: '2026-11-13T10:00:00.000Z', endpoint: '/v1/chat/completions', model: 'gpt-5', masked: true, ...over });
const find = async (text: string) => {
  const q = cds.ql.SELECT.from(TRACES).columns('ID').orderBy('ID');
  const condition = payloadTraceSearchCondition(text);
  if (condition) q.where(condition);
  return (await cds.db.run(q)).map((r: any) => r.ID);
};

describe('payload trace search', () => {
  beforeAll(async () => {
    await connectTraceTestDb();
    await cds.db.run(cds.ql.DELETE.from(TRACES));
    await cds.db.run(cds.ql.INSERT.into(TRACES).entries([
      row('a', { prompt: 'Quota is at 50% for PERSON_1', answer: 'Noted.' }),
      row('b', { prompt: 'cache key a_b', answer: 'The Connection was REFUSED' }),
      row('c', { prompt: 'cache key axb', keyName: 'Jane build key', userEmail: 'jane.roe@example.org' }),
      row('d', { masked: false, sealedPrompt: '{"v":1,"ct":"Quillfeather"}', model: 'claude-sonnet', endpoint: '/anthropic/v1/messages' })
    ]));
  });

  it('searches these columns', () => {
    expect(PAYLOAD_TRACE_SEARCH_COLUMNS).toEqual(['prompt', 'answer', 'requestId', 'model', 'endpoint', 'keyName', 'userEmail']);
  });
  it('finds the whole phrase, ignoring case, in the prompt and the answer', async () => {
    expect(await find('connection was refused')).toEqual(['b']);
    expect(await find('person_1')).toEqual(['a']);
  });
  it('takes % and _ as themselves', async () => {
    expect(await find('50%')).toEqual(['a']);
    expect(await find('a_b')).toEqual(['b']);
  });
  it('finds the facts: request id, model, route, key name and user', async () => {
    expect(await find('req-c')).toEqual(['c']);
    expect(await find('CLAUDE-SONNET')).toEqual(['d']);
    expect(await find('/anthropic/')).toEqual(['d']);
    expect(await find('jane build')).toEqual(['c']);
    expect(await find('jane.roe@example.org')).toEqual(['c']);
  });
  it('never searches the sealed prompt', async () => {
    expect(await find('Quillfeather')).toEqual([]);
  });
  it('a text of spaces only is no search', async () => {
    expect(payloadTraceSearchCondition('   ')).toBeNull();
    expect(await find('   ')).toEqual(['a', 'b', 'c', 'd']);
  });
});
