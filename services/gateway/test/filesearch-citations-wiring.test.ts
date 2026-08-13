/**
 * Task 9b: `buildCitations` wired onto the assistant message the client actually reads.
 *
 * Task 9 built the anchoring and nothing consumed it, while the parity matrix already
 * claimed `file_citation` annotations under **Exact** parity. This suite is what makes that
 * claim checkable, and every test in it is written against the ONE property that is easy to
 * get silently, invisibly wrong:
 *
 *   AN ANNOTATION IS A PAIR OF INTEGERS INTO A STRING THAT CHANGES LENGTH AFTER WE EMIT IT.
 *
 * On the streaming path the hosted-tool engine is the OUTERMOST res.write interceptor:
 * everything it writes still passes through pseudonymization's `patchedWrite`, which
 * unmasks. `MASKED_EMAIL_1f2e3d4c` is 22 characters, the address it unmasks to is 17 — so an
 * offset computed against the frame's own (masked) text is wrong by a different amount for
 * every message, NOTHING throws, and the client renders a citation underlining the wrong
 * words. That is why this suite installs the REAL pseudonymization SSE interceptor
 * underneath the REAL hosted-tool interceptor and asserts on the bytes that come out the
 * bottom. A test that inspected the item before it reached `res.write` would prove nothing
 * about the only property that matters.
 *
 * The fixture is built so each of the four ways to get this wrong fails a NAMED test:
 *
 *   offsets computed against the masked text   -> the raw needle is not in it: 0 annotations
 *   hits reached off `payload` (maskedResults) -> the masked needle is not in the unmasked
 *                                                 message: 0 annotations
 *   annotations on only one of the two frames  -> the other frame's test fails
 *   the frame's text emitted UNMASKED          -> the boundary test fails, and so does the
 *                                                 one asserting what the continuation POSTs
 *
 * The last of those is not a style rule. The item on an `output_item.done` frame is ALSO
 * what the engine carries into the next continuation's `input`, so substituting unmasked
 * text there ships the address straight back to the deployment.
 *
 * @see ../src/plugins/fileSearch/citations.ts - the anchoring, and why the needle is RAW
 * @see ../src/plugins/fileSearch/descriptor.ts - annotateMessage, the hook's one implementor
 * @see ../src/plugins/hostedTool/engine.ts - the three sites
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Readable } from 'stream';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a) },
}));

const searchSpy = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/search', () => {
  const actual = jest.requireActual<any>('../src/fileSearch/search');
  return { ...actual, __esModule: true, searchVectorStores: (...args: any[]) => searchSpy(...args) };
});

const poolQuery = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({ query: (...a: any[]) => poolQuery(...a) }),
}));

// One mock serving BOTH plugins: pseudonymization reads getConfig/getSubstitutedModel, the
// file_search descriptor reads the file_search config. The two bounds come from the real
// module so the descriptor and the mock cannot agree with each other while disagreeing
// with configService.
const mockConfig: any = { api_config: { defaultHooks: {}, model_list_changes: {} } };
const toolConfig = { enabled: true, maxSearchesPerRequest: 5, maxNumResultsDefault: 10 };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getConfig: () => mockConfig,
    getSubstitutedModel: (_p: string, m: string) => m,
    getFileSearchToolConfig: () => toolConfig,
  },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_p: string, m: string) => m,
  getFileSearchToolConfig: () => toolConfig,
  getFileSearchConfig: () => ({ embeddingDimensions: 3, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 } }),
  MIN_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MIN_RESULTS_DEFAULT,
  MAX_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MAX_RESULTS_DEFAULT,
}));

import pseudoRules = require('../src/plugins/pseudonymization/index');
import fileSearchRules = require('../src/plugins/responsesFileSearchPlugin');
import { hostedToolAfterHandler } from '../src/plugins/hostedTool/engine';
import { fileSearchDescriptor } from '../src/plugins/fileSearch/descriptor';
import { SearchHit } from '../src/fileSearch/search';

const pseudoBefore = (pseudoRules as any[]).find(r => r.strategy === 'before').handler;
const fsBefore = (fileSearchRules as any[]).find(r => r.strategy === 'before').handler;

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const utils = { logger } as any;

/** The address that appears in the prompt AND inside the retrieved passage — which is what
 *  makes the raw-vs-masked needle distinction observable rather than theoretical. */
const EMAIL = 'dana@handbook.com';

/** The chunk exactly as it sits in the corpus: RAW. `citationNeedle` anchors on this. */
const RAW_CHUNK = `Reimbursement requests must be filed by ${EMAIL} within thirty days of travel.`;

const PREFIX = 'The handbook is clear. ';
const SUFFIX = ' Ask them for the form.';

const OWNER = 'owner@corp.example';
const MASKING = { method: 'pseudonymization', entities: [{ type: 'profile-email' }] };
const PROMPT = `What does the handbook say about expenses? Ask ${EMAIL} if unsure.`;

/**
 * THE PENDING-DRAIN SHAPE: a replayed conversation (`store: false`, which is what Codex CLI
 * sends) carrying a hosted-tool `function_call` that never received its output. The before
 * handler runs the search out of THIS, before any deployment call — so the model's very
 * first response is already the citing message, and no continuation is involved anywhere.
 */
const DRAIN_INPUT = (): any[] => ([
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] },
  { type: 'function_call', id: 'fc_p', call_id: 'call_pending', name: 'file_search', arguments: '{"query":"expense reimbursement"}' },
]);

const sse = (o: any): string => `data: ${JSON.stringify(o)}\n\n`;
const settle = (): Promise<unknown> => new Promise(r => { setTimeout(r, 0); });
const settleAll = (): Promise<unknown> => new Promise(r => { setTimeout(r, 30); });

function mockRes(): any {
  const written: string[] = [];
  return {
    written,
    write(chunk: any) { written.push(String(chunk)); return true; },
    end(chunk?: any) { if (chunk) written.push(String(chunk)); return this; },
    setHeader() { /* no-op */ },
    headersSent: false,
    writableEnded: false,
  };
}

/** Every `data:` payload in the written bytes, parsed. */
function frames(written: string[]): any[] {
  return written.join('')
    .split('\n\n')
    .map(b => b.trim())
    .filter(b => b.length > 0)
    .map(b => b.split('\n').find(l => l.startsWith('data: ')))
    .filter((l): l is string => typeof l === 'string')
    .map(l => JSON.parse(l.slice(6)));
}

function hit(text: string): SearchHit {
  return {
    fileId: 'file_handbook',
    filename: 'handbook.md',
    score: 0.91,
    attributes: {},
    content: [{ type: 'text', text }],
  };
}

const UPSTREAM = {
  url: 'https://sap.example/d1/responses',
  headers: { Authorization: 'Bearer t' },
  timeoutMs: 5000,
  payload: { model: 'gpt-5.3-codex--deployed', input: 'x', stream: true },
};

/** An axios streaming response replaying `f` as SSE blocks. */
const stream = (f: any[]): any => ({ data: Readable.from(f.map(sse)) });

/**
 * Install pseudonymization's SSE unmask interceptor, then a recorder, then the hosted-tool
 * interceptor — the production nesting, with the recorder standing where the namespace
 * layer sits. `innerWrites` is therefore exactly what the hosted-tool engine hands DOWN,
 * and `res.written` is what the client receives.
 */
async function openTurn(stream_: boolean, input?: any): Promise<{
  req: any; res: any; innerWrites: string[]; token: string;
}> {
  const res = mockRes();
  const req: any = {
    headers: {},
    apiKeyInfo: { email: OWNER },
    body: {
      model: 'gpt-5.3-codex--deployed',
      stream: stream_,
      input: input ?? PROMPT,
      tools: [{ type: 'file_search', vector_store_ids: ['vs_1'] }],
      masking: MASKING,
    },
    __responsesUpstream: UPSTREAM,
  };

  await pseudoBefore({ req, res, utils });

  const innerWrites: string[] = [];
  const belowWrite = res.write.bind(res);
  res.write = (chunk: any, ...rest: any[]): boolean => {
    innerWrites.push(String(chunk));
    return belowWrite(chunk, ...rest);
  };

  await fsBefore({ req, res, utils });

  const token = req.__pseudonymizationMap.forward.get(EMAIL);
  expect(typeof token).toBe('string');           // the fixture is worthless without it
  return { req, res, innerWrites, token };
}

/** The message the deployment produces: it quotes the passage it was shown, i.e. MASKED. */
function maskedMessage(token: string): { text: string; item: any } {
  const text = `${PREFIX}${RAW_CHUNK.replace(EMAIL, token)}${SUFFIX}`;
  return {
    text,
    item: {
      id: 'msg_model', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  };
}

/** The frames of one continuation round that answers the search with a message. */
function answerRound(token: string): any[] {
  const { text, item } = maskedMessage(token);
  return [
    { type: 'response.created', response: { id: 'resp_2' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_model', delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'msg_model', text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 7 } } },
  ];
}

/** Drive the first (upstream) round: one file_search call, then its terminal frame. */
async function driveFirstRound(res: any, callId = 'call_fs'): Promise<void> {
  const call = {
    type: 'function_call', id: 'fc_1', call_id: callId, name: 'file_search',
    arguments: '{"query":"expense reimbursement"}',
  };
  res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }));
  res.write(sse({ type: 'response.output_item.added', output_index: 0, item: call }));
  res.write(sse({ type: 'response.output_item.done', output_index: 0, item: call }));
  await settle();
  res.write(sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [call], usage: { input_tokens: 11, output_tokens: 3 } } }));
  await settleAll();
}

/** The client-facing `output_item.done` frame for the model's own message. */
function modelMessageDoneFrame(written: string[]): any {
  return frames(written).find(f => f.type === 'response.output_item.done'
    && f.item?.type === 'message' && f.item?.id === 'msg_model');
}

/** The model's message as it appears inside the terminal frame's response.output. */
function terminalModelMessage(written: string[]): any {
  const terminal = frames(written).filter(f => f.type === 'response.completed').pop();
  return (terminal?.response?.output || []).find((i: any) => i?.id === 'msg_model');
}

const originalAnnotate = fileSearchDescriptor.annotateMessage;

describe('file_citation annotations, wired onto the assistant message', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fileSearchDescriptor as any).annotateMessage = originalAnnotate;
    poolQuery.mockResolvedValue({ rows: [{ id: 'vs_1', status: 'completed', embedding_dim: 3 }] });
    searchSpy.mockResolvedValue({ data: [hit(RAW_CHUNK)] });
  });

  afterEach(() => { (fileSearchDescriptor as any).annotateMessage = originalAnnotate; });

  describe('streaming', () => {
    it('attaches a file_citation on response.output_item.done, anchored on the RAW passage at offsets into the UNMASKED bytes the client receives', async () => {
      const { res, token } = await openTurn(true);
      mockPost.mockResolvedValueOnce(stream(answerRound(token)));

      await driveFirstRound(res);

      const done = modelMessageDoneFrame(res.written);
      expect(done).toBeDefined();

      // These are the bytes on the wire: pseudonymization has already unmasked them.
      const clientText: string = done.item.content[0].text;
      expect(clientText).toBe(`${PREFIX}${RAW_CHUNK}${SUFFIX}`);
      expect(clientText).not.toContain('MASKED_');

      const annotations = done.item.content[0].annotations;
      expect(annotations).toHaveLength(1);
      const [a] = annotations;
      expect(a.type).toBe('file_citation');
      expect(a.file_id).toBe('file_handbook');
      expect(a.filename).toBe('handbook.md');
      // THE assertion. Offsets computed against the masked text, or anchored on the
      // deployment-bound masked rendering, both yield NO annotation at all; an offset that
      // merely drifted would slice the wrong words out here.
      expect(clientText.slice(a.start_index, a.end_index)).toBe(RAW_CHUNK);
      expect(a.start_index).toBe(PREFIX.length);
      // `index` is the END of the span (last character), verified against a real
      // OpenAI response on 2026-08-06 — not the start, as this previously assumed.
      expect(a.index).toBe(a.end_index - 1);
      expect(clientText[a.index]).toBe(RAW_CHUNK[RAW_CHUNK.length - 1]);
    });

    it('repeats the same annotations inside the terminal response.completed, so a client reading only that frame still sees the citation', async () => {
      const { res, token } = await openTurn(true);
      mockPost.mockResolvedValueOnce(stream(answerRound(token)));

      await driveFirstRound(res);

      const message = terminalModelMessage(res.written);
      expect(message).toBeDefined();
      const clientText: string = message.content[0].text;
      expect(clientText).not.toContain('MASKED_');

      const annotations = message.content[0].annotations;
      expect(annotations).toHaveLength(1);
      expect(clientText.slice(annotations[0].start_index, annotations[0].end_index)).toBe(RAW_CHUNK);

      // Exactly one citation, not one per frame the item appears on: the terminal rebuilds
      // `response.output` from its own copy of the item, never from the annotated one.
      const done = modelMessageDoneFrame(res.written);
      expect(done.item.content[0].annotations).toEqual(annotations);
    });

    it('hands the frame DOWN still masked — only integer offsets cross the unmasker', async () => {
      const { res, innerWrites, token } = await openTurn(true);
      mockPost.mockResolvedValueOnce(stream(answerRound(token)));

      await driveFirstRound(res);

      const handedDown = innerWrites
        .filter(b => b.includes('"response.output_item.done"') && b.includes('msg_model'))
        .join('');
      expect(handedDown).toContain(token);          // still masked when we let go of it
      expect(handedDown).not.toContain(EMAIL);      // ...and the address never appears
      expect(handedDown).toContain('"file_citation"');

      // Same for the terminal frame the engine rebuilds wholesale.
      const terminalDown = innerWrites.filter(b => b.includes('"response.completed"')).join('');
      expect(terminalDown).toContain(token);
      expect(terminalDown).not.toContain(EMAIL);
    });

    it('carries the ORIGINAL masked, un-annotated message into the next continuation POST', async () => {
      const { res, token } = await openTurn(true);
      const { item } = maskedMessage(token);
      const secondCall = {
        type: 'function_call', id: 'fc_2', call_id: 'call_fs_2', name: 'file_search',
        arguments: '{"query":"deadlines"}',
      };
      // Round two: the model writes the message that cites round one's passage AND asks for
      // one more search — so round three's POST body carries that message.
      mockPost.mockResolvedValueOnce(stream([
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.output_item.added', output_index: 1, item: secondCall },
        { type: 'response.output_item.done', output_index: 1, item: secondCall },
        { type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [item, secondCall] } },
      ]));
      mockPost.mockResolvedValueOnce(stream(answerRound(token)));

      await driveFirstRound(res);
      await settleAll();

      expect(mockPost).toHaveBeenCalledTimes(2);
      const input = (mockPost.mock.calls[1] as any[])[1].input;
      const posted = input.find((i: any) => i?.id === 'msg_model');
      expect(posted).toBeDefined();
      // The deployment must see the message exactly as it wrote it.
      expect(posted.content[0].text).toContain(token);
      expect(JSON.stringify(input)).not.toContain(EMAIL);
      expect(JSON.stringify(input)).not.toContain('file_citation');
    });

    it('discards a descriptor\'s annotations when annotateMessage changed the message text', async () => {
      // The mutation the engine guards against: returning `buildCitations`' unmasked `text`
      // in place of the frame's own. It would look right on the wire and leak the address
      // into the continuation POST.
      (fileSearchDescriptor as any).annotateMessage = (msg: any) => ({
        ...msg,
        content: [{
          ...msg.content[0],
          text: msg.content[0].text.replace(/MASKED_[A-Z_]+_[0-9a-f]+/g, EMAIL),
          annotations: [{ type: 'file_citation', file_id: 'f', filename: 'f.md', index: 0, start_index: 0, end_index: 4 }],
        }],
      });

      const { res, token } = await openTurn(true);
      mockPost.mockResolvedValueOnce(stream(answerRound(token)));

      await driveFirstRound(res);

      const done = modelMessageDoneFrame(res.written);
      expect(done.item.content[0].annotations).toEqual([]);
      expect(terminalModelMessage(res.written).content[0].annotations).toEqual([]);
      expect(logger.error.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain('changed the message text');
    });

    it('leaves every frame untouched for a descriptor with no annotateMessage hook', async () => {
      delete (fileSearchDescriptor as any).annotateMessage;

      const { res, token } = await openTurn(true);
      mockPost.mockResolvedValueOnce(stream(answerRound(token)));

      await driveFirstRound(res);

      expect(modelMessageDoneFrame(res.written).item.content[0].annotations).toEqual([]);
      expect(terminalModelMessage(res.written).content[0].annotations).toEqual([]);
      expect(res.written.join('')).not.toContain('file_citation');
    });
  });

  describe('the pending-drain shape (the tool ran BEFORE the first deployment call)', () => {
    it('streaming: annotates the model\'s FIRST response, on both output_item.done and the terminal frame', async () => {
      const { res, token } = await openTurn(true, DRAIN_INPUT());
      expect(searchSpy).toHaveBeenCalledTimes(1);          // drained before any frame arrived

      // No continuation anywhere: this turn's single deployment response IS the answer.
      const { item } = maskedMessage(token);
      res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }));
      res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }));
      res.write(sse({ type: 'response.output_item.done', output_index: 0, item }));
      res.write(sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item] } }));
      await settleAll();

      expect(mockPost).not.toHaveBeenCalled();

      const done = modelMessageDoneFrame(res.written);
      expect(done).toBeDefined();
      const doneText: string = done.item.content[0].text;
      const doneAnnotations = done.item.content[0].annotations;
      expect(doneAnnotations).toHaveLength(1);
      expect(doneText.slice(doneAnnotations[0].start_index, doneAnnotations[0].end_index)).toBe(RAW_CHUNK);

      const terminal = terminalModelMessage(res.written);
      expect(terminal).toBeDefined();
      const terminalText: string = terminal.content[0].text;
      const terminalAnnotations = terminal.content[0].annotations;
      expect(terminalAnnotations).toHaveLength(1);
      expect(terminalText.slice(terminalAnnotations[0].start_index, terminalAnnotations[0].end_index)).toBe(RAW_CHUNK);
    });

    it('streaming: still hands the drain-shape frames DOWN masked', async () => {
      const { res, innerWrites, token } = await openTurn(true, DRAIN_INPUT());
      const { item } = maskedMessage(token);
      res.write(sse({ type: 'response.output_item.done', output_index: 0, item }));
      res.write(sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item] } }));
      await settleAll();

      const handedDown = innerWrites.filter(b => b.includes('msg_model')).join('');
      expect(handedDown).toContain(token);
      expect(handedDown).not.toContain(EMAIL);
      expect(handedDown).toContain('"file_citation"');
    });

    it('non-streaming: annotates the response even though it carries no hosted-tool call to resolve', async () => {
      const { req, token } = await openTurn(false, DRAIN_INPUT());
      expect(searchSpy).toHaveBeenCalledTimes(1);

      const { item } = maskedMessage(token);
      // pseudonymizationPlugin's after handler (index 0) has already unmasked this by the
      // time the engine sees it, so the fixture is handed over unmasked — as on the wire.
      const unmasked = JSON.parse(JSON.stringify(item));
      unmasked.content[0].text = `${PREFIX}${RAW_CHUNK}${SUFFIX}`;

      const merged = await hostedToolAfterHandler({
        req, res: mockRes(), utils,
        upstreamResponse: { id: 'resp_1', output: [unmasked], usage: { input_tokens: 9, output_tokens: 2 } },
      } as any);

      expect(mockPost).not.toHaveBeenCalled();
      const message = merged.output.find((i: any) => i?.id === 'msg_model');
      const annotations = message.content[0].annotations;
      expect(annotations).toHaveLength(1);
      expect(message.content[0].text.slice(annotations[0].start_index, annotations[0].end_index)).toBe(RAW_CHUNK);
    });
  });

  describe('non-streaming', () => {
    it('annotates the model message in the merged output, where the text is already unmasked', async () => {
      const { req, token } = await openTurn(false);
      const { item } = maskedMessage(token);
      const call = {
        type: 'function_call', id: 'fc_1', call_id: 'call_fs', name: 'file_search',
        arguments: '{"query":"expense reimbursement"}',
      };
      // The continuation response is MASKED, exactly as the deployment produces it — the
      // engine's own `unmaskResponsesOutput` is what makes it unmasked by the wiring site.
      mockPost.mockResolvedValueOnce({
        data: { id: 'resp_2', output: [JSON.parse(JSON.stringify(item))], usage: { input_tokens: 4, output_tokens: 6 } },
      });

      const merged = await hostedToolAfterHandler({
        req,
        res: mockRes(),
        utils,
        upstreamResponse: { id: 'resp_1', output: [call], usage: { input_tokens: 9, output_tokens: 2 } },
      } as any);

      const message = merged.output.find((i: any) => i?.id === 'msg_model');
      expect(message).toBeDefined();
      const text: string = message.content[0].text;
      expect(text).toBe(`${PREFIX}${RAW_CHUNK}${SUFFIX}`);

      const annotations = message.content[0].annotations;
      expect(annotations).toHaveLength(1);
      expect(text.slice(annotations[0].start_index, annotations[0].end_index)).toBe(RAW_CHUNK);
      expect(annotations[0].file_id).toBe('file_handbook');
    });
  });
});
