/**
 * Tool-call arguments are JSON text. Masking them as plain text missed the OpenAI chat
 * history entirely (`tool_calls[].function.arguments` was never scanned), and restoring
 * them as plain text dropped a value containing `"` or `\` straight into a JSON string
 * literal, so the client received arguments it could not parse. Both directions now work
 * on the parsed value: string leaves are masked / restored and the JSON is re-serialized.
 *
 * The test value `CASE-7"B\x` is matched by a custom pattern and carries both characters.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockWireLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => mockWireLogger,
}));

const mockConfig: any = { api_config: { hooks: { defaults: {} }, models: { overrides: {} }, observability: {} } };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => mockConfig, getSubstitutedModel: (_p: string, m: string) => m, getCustomToolMode: () => 'translate', getToolSearchMode: () => 'translate', getToolSearchHoistDiscoveredTools: () => false },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_p: string, m: string) => m,
}));

import pluginRules = require('../src/plugins/pseudonymization/index');
import { remaskResponsesItems } from '../src/plugins/webSearch/queryMasking';
const customToolRules = require('../src/plugins/responsesCustomToolsPlugin');

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const beforeHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'before').handler;
const afterHandler = (pluginRules as any[]).find((r: any) => r.strategy === 'after').handler;

const VALUE = 'CASE-7"B\\x';
const masking = {
  method: 'pseudonymization',
  entities: [{ type: 'profile-email' }],
  custom_entities: [{ pattern: 'CASE-[^\\s]+' }],
};
const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;

function fakeRes() {
  const written: string[] = [];
  const sentJson: any[] = [];
  const res: any = {
    write: (c: any) => { written.push(String(c)); return true; },
    end: (c?: any) => { if (typeof c === 'string') written.push(c); },
    json: (b: any) => { sentJson.push(b); return res; },
  };
  return { res, written, sentJson };
}

/** A chat request whose user turn carries VALUE, so the map holds it; returns its token. */
async function chatSetup(extraMessages: any[] = []) {
  const { res, written, sentJson } = fakeRes();
  const req: any = {
    body: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: `Open ${VALUE} please` }, ...extraMessages],
      masking,
    },
  };
  await beforeHandler({ req, res, utils: { logger: mockLogger } });
  const map = req.__pseudonymizationMap;
  const token = map.forward.get(VALUE);
  return { req, res, written, sentJson, map, token };
}

describe('pseudonymization: tool-call arguments in the request history', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('masks an OpenAI chat assistant tool_calls arguments value that appears nowhere else', async () => {
    const req: any = {
      body: {
        model: 'gpt-4o',
        masking,
        messages: [
          { role: 'user', content: 'Send the report' },
          {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'send', arguments: '{"to":"jane.roe@example.com"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
        ],
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });

    const args = req.body.messages[1].tool_calls[0].function.arguments;
    expect(args).not.toContain('jane.roe@example.com');
    expect(JSON.parse(args).to).toMatch(/^MASKED_EMAIL/);
  });

  it('masks an OpenAI chat tool message content', async () => {
    const req: any = {
      body: {
        model: 'gpt-4o',
        masking,
        messages: [
          { role: 'user', content: 'Look it up' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c', content: 'owner is jane.roe@example.com' },
        ],
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    expect(req.body.messages[2].content).not.toContain('jane.roe@example.com');
  });

  it('masks chat tool_calls arguments structurally: a value with " and \\ stays valid JSON and the map holds the real value', async () => {
    const req: any = {
      body: {
        model: 'gpt-4o',
        masking,
        messages: [
          { role: 'user', content: 'Open the case' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'open', arguments: JSON.stringify({ ref: VALUE }) } }] },
        ],
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    const args = req.body.messages[1].tool_calls[0].function.arguments;
    const parsed = JSON.parse(args);
    expect(parsed.ref).toBe(req.__pseudonymizationMap.forward.get(VALUE));
  });

  it('masks Responses function_call arguments structurally (valid JSON, real value in the map)', async () => {
    const req: any = {
      body: {
        model: 'gpt-5.3-codex--deployed',
        masking,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'open the case' }] },
          { type: 'function_call', name: 'open', call_id: 'c1', arguments: JSON.stringify({ ref: VALUE }) },
          { type: 'function_call_output', call_id: 'c1', output: 'opened' },
        ],
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    const args = req.body.input[1].arguments;
    const parsed = JSON.parse(args);
    expect(parsed.ref).toBe(req.__pseudonymizationMap.forward.get(VALUE));
  });

  it('masks Anthropic tool_use.input and tool_result content', async () => {
    const req: any = {
      body: {
        model: 'claude-sonnet-4',
        masking,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'send it' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send', input: { to: 'jane.roe@example.com' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'delivered to jane.roe@example.com' }] },
        ],
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    expect(JSON.stringify(req.body.messages)).not.toContain('jane.roe@example.com');
  });
});

describe('pseudonymization: tool-call arguments restored as valid JSON', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('restores OpenAI chat tool_calls arguments in every choice', async () => {
    const { req, token } = await chatSetup();
    expect(token).toBeDefined();
    const upstreamResponse: any = {
      object: 'chat.completion',
      choices: [0, 1].map((index) => ({
        index,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'open', arguments: `{"ref": "${token}"}` } }] },
      })),
    };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    for (const choice of out.choices) {
      expect(JSON.parse(choice.message.tool_calls[0].function.arguments).ref).toBe(VALUE);
    }
  });

  it('leaves arguments without a placeholder byte-identical', async () => {
    const { req } = await chatSetup();
    const original = '{"a": 1,  "b": "plain"}';
    const upstreamResponse: any = {
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ function: { name: 'f', arguments: original } }] } }],
    };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe(original);
  });

  it('restores SAP orchestration tool_calls arguments', async () => {
    const { req, token } = await chatSetup();
    const upstreamResponse: any = {
      final_result: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'open', arguments: `{"ref":"${token}"}` } }] } }] },
    };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    expect(JSON.parse(out.final_result.choices[0].message.tool_calls[0].function.arguments).ref).toBe(VALUE);
  });

  it('restores Responses function_call arguments', async () => {
    const { req, token } = await chatSetup();
    const upstreamResponse: any = {
      object: 'response', status: 'completed',
      output: [{ type: 'function_call', name: 'open', call_id: 'c', arguments: `{"ref":"${token}"}` }],
    };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    expect(JSON.parse(out.output[0].arguments).ref).toBe(VALUE);
  });

  it('falls back to text restore when the arguments are not JSON', async () => {
    const { req, token } = await chatSetup();
    const upstreamResponse: any = {
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ function: { name: 'f', arguments: `{"ref":"${token}` } }] } }],
    };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe(`{"ref":"${VALUE}`);
  });

  it('stashes the masked text of every choice for the SIEM event', async () => {
    const { req, token } = await chatSetup();
    const upstreamResponse: any = {
      choices: [
        { index: 0, message: { role: 'assistant', content: `first ${token}` } },
        { index: 1, message: { role: 'assistant', content: `second ${token}` } },
      ],
    };
    await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    expect(req.__siemMaskedResponse).toContain(`first ${token}`);
    expect(req.__siemMaskedResponse).toContain(`second ${token}`);
  });
});

describe('pseudonymization: streamed tool-call arguments', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('after-chain: an OpenAI tool_calls argument placeholder split across deltas restores to valid JSON', async () => {
    const { req, token } = await chatSetup();
    const delta = (args: string, finish: string | null = null) => ({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: finish }],
    });
    const parts = ['{"ref":"', token.slice(0, 9), `${token.slice(9)}"}`];
    let args = '';
    for (let i = 0; i < parts.length; i++) {
      const out = await afterHandler({ req, upstreamResponse: delta(parts[i], i === parts.length - 1 ? 'tool_calls' : null), utils: { logger: mockLogger } });
      args += out.choices[0].delta.tool_calls[0].function.arguments;
    }
    expect(JSON.parse(args).ref).toBe(VALUE);
  });

  it('wire: an Anthropic input_json_delta placeholder split across frames restores to valid JSON', async () => {
    const { res, written, token } = await chatSetup();
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'open', input: {} } })}\n\n`);
    for (const piece of ['{"ref":"', token.slice(0, 9), `${token.slice(9)}"}`]) {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: piece } })}\n\n`);
    }
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
    res.end();

    const json = written.join('').split('\n\n')
      .map((b) => b.match(/data: (.+)$/s)?.[1]).filter(Boolean)
      .map((s) => JSON.parse(s as string))
      .filter((e) => e.delta?.type === 'input_json_delta')
      .map((e) => e.delta.partial_json).join('');
    expect(JSON.parse(json).ref).toBe(VALUE);
  });

  it('wire: OpenAI tool_calls argument deltas split across frames restore to valid JSON', async () => {
    const { res, written, token } = await chatSetup();
    const pieces = ['{"ref":"', token.slice(0, 9), `${token.slice(9)}"}`];
    pieces.forEach((p, i) => res.write(frame({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p } }] }, finish_reason: i === pieces.length - 1 ? 'tool_calls' : null }],
    })));
    res.end();
    const args = written.join('').split('\n\n')
      .map((b) => b.match(/data: (.+)$/s)?.[1]).filter(Boolean)
      .map((s) => JSON.parse(s as string))
      .map((e) => e.choices[0].delta.tool_calls[0].function.arguments).join('');
    expect(JSON.parse(args).ref).toBe(VALUE);
  });

  it('wire: Responses argument deltas and the terminal snapshots carry valid JSON', async () => {
    const { res, written, token } = await chatSetup();
    const masked = `{"ref":"${token}"}`;
    res.write(frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call' } }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"ref":"' }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: token.slice(0, 9) }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: `${token.slice(9)}"}` }));
    res.write(frame({ type: 'response.function_call_arguments.done', output_index: 0, arguments: masked }));
    res.write(frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: masked } }));
    res.write(frame({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', arguments: masked }] } }));
    res.end();

    const events = written.join('').split('\n\n')
      .map((b) => b.match(/data: (.+)$/s)?.[1]).filter(Boolean)
      .map((s) => JSON.parse(s as string));
    const fromDeltas = events.filter((e) => e.type === 'response.function_call_arguments.delta').map((e) => e.delta).join('');
    expect(JSON.parse(fromDeltas).ref).toBe(VALUE);
    expect(JSON.parse(events.find((e) => e.type === 'response.function_call_arguments.done').arguments).ref).toBe(VALUE);
    expect(JSON.parse(events.find((e) => e.type === 'response.output_item.done').item.arguments).ref).toBe(VALUE);
    expect(JSON.parse(events.find((e) => e.type === 'response.completed').response.output[0].arguments).ref).toBe(VALUE);
  });
});

describe('pseudonymization: res.json safety net', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('restores a value with " and \\ in content and in tool_calls arguments', async () => {
    const { res, sentJson, token } = await chatSetup();
    res.json({
      choices: [{ message: { role: 'assistant', content: `Ref ${token}`, tool_calls: [{ function: { name: 'open', arguments: `{"ref":"${token}"}` } }] } }],
    });
    const body = sentJson[0];
    expect(body.choices[0].message.content).toBe(`Ref ${VALUE}`);
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments).ref).toBe(VALUE);
    expect(mockWireLogger.error).not.toHaveBeenCalled();
  });

  it('does not write the restored values into the object it was handed', async () => {
    const { res, token } = await chatSetup();
    const cached = { type: 'message', content: [{ type: 'text', text: `Ref ${token}` }] };
    res.json(cached);
    expect(cached.content[0].text).toBe(`Ref ${token}`);
  });

  it('logs an error, without content, when a placeholder of this request cannot be restored', async () => {
    const { res, sentJson, token } = await chatSetup();
    res.json({ type: 'message', content: [{ type: 'text', text: 'ok' }], metadata: { [token]: 'x' } });
    expect(sentJson).toHaveLength(1);
    expect(mockWireLogger.error).toHaveBeenCalled();
    const logged = JSON.stringify(mockWireLogger.error.mock.calls);
    expect(logged).not.toContain(VALUE);
    expect(logged).not.toContain('CASE-7');
  });
});

describe('pseudonymization: fix round 1', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('a hosted-tool continuation re-masks restored arguments whose value carries ", \\ or a newline', async () => {
    const { req, token, map } = await chatSetup();
    const NL = 'LINE-1\nLINE-2 office';
    const nlToken = map.getPlaceholder('custom', NL);
    const upstreamResponse: any = {
      object: 'response', status: 'completed',
      output: [{ type: 'function_call', name: 'open', call_id: 'c', arguments: `{"ref":"${token}","note":"${nlToken}"}` }],
    };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    expect(JSON.parse(out.output[0].arguments)).toEqual({ ref: VALUE, note: NL });

    const [remasked] = remaskResponsesItems(out.output, req);
    expect(JSON.parse(remasked.arguments)).toEqual({ ref: token, note: nlToken });
    expect(remasked.arguments).not.toContain('CASE-7');
    expect(remasked.arguments).not.toContain('LINE-1');
  });

  it('restores a placeholder used as an object key in tool-call arguments', async () => {
    const { req, token } = await chatSetup();
    const upstreamResponse: any = {
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ function: { name: 'f', arguments: `{"recipients":{"${token}":"cc"}}` } }] } }],
    };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    expect(JSON.parse(out.choices[0].message.tool_calls[0].function.arguments)).toEqual({ recipients: { [VALUE]: 'cc' } });
  });

  it('keeps every other byte of restored arguments, large integers and formatting included', async () => {
    const { req, token } = await chatSetup();
    const upstreamResponse: any = {
      output: [{ type: 'function_call', name: 'f', arguments: `{ "id": 12345678901234567890,\n  "ref": "${token}" }` }],
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ function: { name: 'f', arguments: `{ "id": 12345678901234567890,\n  "ref": "${token}" }` } }] } }],
    };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    const expected = `{ "id": 12345678901234567890,\n  "ref": ${JSON.stringify(VALUE)} }`;
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe(expected);
    expect(out.output[0].arguments).toBe(expected);
  });

  it('masks the legacy OpenAI function_call arguments in the history', async () => {
    const req: any = {
      body: {
        model: 'gpt-4o', masking,
        messages: [
          { role: 'user', content: 'Send it' },
          { role: 'assistant', content: null, function_call: { name: 'send', arguments: '{"to":"jane.roe@example.com"}' } },
          { role: 'function', name: 'send', content: 'ok' },
        ],
      },
    };
    await beforeHandler({ req, res: {}, utils: { logger: mockLogger } });
    const args = req.body.messages[1].function_call.arguments;
    expect(args).not.toContain('jane.roe@example.com');
    expect(JSON.parse(args).to).toMatch(/^MASKED_EMAIL/);
  });

  it('restores the legacy OpenAI function_call arguments in the response', async () => {
    const { req, token } = await chatSetup();
    const upstreamResponse: any = {
      choices: [{ message: { role: 'assistant', content: null, function_call: { name: 'open', arguments: `{"ref":"${token}"}` } } }],
    };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    expect(JSON.parse(out.choices[0].message.function_call.arguments).ref).toBe(VALUE);
  });

  it('restores SAP orchestration tool_calls arguments in every choice', async () => {
    const { req, token } = await chatSetup();
    const call = () => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'open', arguments: `{"ref":"${token}"}` } }] } });
    const upstreamResponse: any = { final_result: { choices: [call(), call()] } };
    const out = await afterHandler({ req, upstreamResponse, utils: { logger: mockLogger } });
    for (const choice of out.final_result.choices) {
      expect(JSON.parse(choice.message.tool_calls[0].function.arguments).ref).toBe(VALUE);
    }
  });

  it('a streamed custom tool (apply_patch) payload is restored raw, not JSON-escaped', async () => {
    // The custom-tools plugin runs after pseudonymization in the shipped hook chain, so its
    // interceptor wraps (and sees frames before) the pseudonymization one.
    const { res, written } = fakeRes();
    const req: any = {
      body: {
        model: 'gpt-5.3-codex--deployed', stream: true, masking,
        input: `Patch ${VALUE} in`,
        tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }],
      },
    };
    await beforeHandler({ req, res, utils: { logger: mockLogger } });
    const token = req.__pseudonymizationMap.forward.get(VALUE);
    expect(token).toBeDefined();
    const customBefore = customToolRules.find((r: any) => r.strategy === 'before').handler;
    await customBefore({ req, res, utils: { logger: mockLogger } });

    const args = JSON.stringify({ input: `*** Begin Patch\n+${token}\n` });
    res.write(frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'apply_patch', arguments: '' } }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: args.slice(0, 30) }));
    res.write(frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: args.slice(30) }));
    res.write(frame({ type: 'response.function_call_arguments.done', output_index: 0, arguments: args }));
    res.write(frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'apply_patch', arguments: args } }));
    res.end();

    const events = written.join('').split('\n\n')
      .map((b) => b.match(/data: (.+)$/s)?.[1]).filter(Boolean)
      .map((s) => JSON.parse(s as string));
    const patch = `*** Begin Patch\n+${VALUE}\n`;
    expect(events.filter((e) => e.type === 'response.custom_tool_call_input.delta').map((e) => e.delta).join('')).toBe(patch);
    expect(events.find((e) => e.type === 'response.custom_tool_call_input.done').input).toBe(patch);
    expect(events.find((e) => e.type === 'response.output_item.done').item.input).toBe(patch);
  });
});
