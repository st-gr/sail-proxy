/**
 * The call gate (src/toolGovernance/callGate.ts).
 *
 * A client that hosts its own MCP servers reaches them inside its own container tool: codex writes
 * a program for `exec` that calls `tools.mcp__server__tool`. The tool is not in the request, so
 * strip cannot remove it - but the model's CALL passes through this gateway before the client can
 * execute it, and that is where it can be stopped.
 *
 * The gate suppresses such a call and puts a refusal in its place, so the turn stays valid for the
 * client instead of ending in a silent gap. Streaming is the hard part: the denied identifier only
 * becomes visible once the call's arguments are complete, so a container call's frames are held
 * until then, and only then flushed or replaced.
 */
import { conventionFor, DEFAULT_MCP_NAMING } from '../src/toolGovernance/mcpNaming';
import { createCallGate, deniedNestedIn, gateResponseBody, REFUSAL_PREFIX } from '../src/toolGovernance/callGate';
import type { ToolPolicyBlock } from '../src/toolGovernance/identity';

const codex = conventionFor('codex-tui/0.149.1', DEFAULT_MCP_NAMING);
const block = (deny: string[]): ToolPolicyBlock =>
  ({ policyId: 'p', policyName: 'Test', mode: 'strip', allow: [], deny });
const denied = [block(['mcp:ps_exec_remote/*'])];
const permissive = [block(['mcp:nothing/*'])];

const execCall = (body: string, id = 'call_1') =>
  ({ id, type: 'function_call', name: 'exec', call_id: id, arguments: body, status: 'completed' });
const forbidden = 'await tools.mcp__ps_exec_remote__run_powershell({ script: "x" });';
const allowedBody = 'await tools.exec_command({ cmd: "ls" });';

describe('deniedNestedIn', () => {
  it('names the denied MCP tools a container call reaches, and nothing else', () => {
    expect(deniedNestedIn(execCall(forbidden), codex, denied)).toEqual(['mcp:ps_exec_remote/run_powershell']);
    expect(deniedNestedIn(execCall(forbidden), codex, permissive)).toEqual([]);
    expect(deniedNestedIn(execCall(allowedBody), codex, denied)).toEqual([]);
    // not a container tool, no policy block, or nothing to read: nothing is claimed
    expect(deniedNestedIn({ type: 'function_call', name: 'wait', arguments: forbidden }, codex, denied)).toEqual([]);
    expect(deniedNestedIn(execCall(forbidden), codex, [])).toEqual([]);
    expect(deniedNestedIn(null, codex, denied)).toEqual([]);
  });
});

describe('gateResponseBody (non-streaming)', () => {
  it('replaces a denied container call with a refusal message and leaves the rest of the turn', () => {
    const body = { id: 'resp_1', output: [
      { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] },
      execCall(forbidden),
      execCall(allowedBody, 'call_2')
    ] };
    const { body: gated, suppressed } = gateResponseBody(body, codex, denied);
    expect(suppressed).toEqual(['mcp:ps_exec_remote/run_powershell']);
    expect(gated.output.map((i: any) => `${i.type}:${i.name ?? ''}`))
      .toEqual(['message:', 'message:', 'function_call:exec']);
    const refusal = gated.output[1];
    expect(refusal.content[0].text).toContain(REFUSAL_PREFIX);
    expect(refusal.content[0].text).toContain('mcp:ps_exec_remote/run_powershell');
    expect(gated.output[2].arguments).toBe(allowedBody);
    // the input is never mutated
    expect(body.output).toHaveLength(3);
  });

  it('returns the body unchanged when nothing is denied', () => {
    const body = { output: [execCall(allowedBody)] };
    const { body: gated, suppressed } = gateResponseBody(body, codex, denied);
    expect(suppressed).toEqual([]);
    expect(gated).toBe(body);
  });
});

describe('createCallGate (streaming)', () => {
  const frame = (type: string, extra: Record<string, unknown> = {}) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;

  const sequence = (body: string) =>
    frame('response.created', { response: { id: 'r', status: 'in_progress', output: [] } })
    + frame('response.output_item.added', { output_index: 0, item: { id: 'call_1', type: 'function_call', name: 'exec', arguments: '' } })
    + frame('response.function_call_arguments.delta', { item_id: 'call_1', delta: body })
    + frame('response.function_call_arguments.done', { item_id: 'call_1', arguments: body })
    + frame('response.output_item.done', { output_index: 0, item: execCall(body) })
    + frame('response.completed', { response: { id: 'r', status: 'completed', output: [execCall(body)] } });

  it('holds a container call until its arguments are complete, then forwards a permitted one intact', () => {
    const gate = createCallGate(codex, denied);
    const text = sequence(allowedBody);
    const out = gate.push(text) + gate.flush();
    expect(out).toBe(text);
    expect(gate.suppressed()).toEqual([]);
  });

  it('suppresses a denied call and emits a refusal message in its place', () => {
    const gate = createCallGate(codex, denied);
    const out = gate.push(sequence(forbidden)) + gate.flush();
    expect(gate.suppressed()).toEqual(['mcp:ps_exec_remote/run_powershell']);
    // nothing of the call survives: no arguments, no call item, no call id
    expect(out).not.toContain('mcp__ps_exec_remote__run_powershell');
    expect(out).not.toContain('function_call');
    // and a message the client can render took its place
    expect(out).toContain(REFUSAL_PREFIX);
    expect(out).toContain('mcp:ps_exec_remote/run_powershell');
    // the terminal frame still describes the turn, with the refusal instead of the call
    const completed = out.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
      .find((f) => f.type === 'response.completed');
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['message']);
    expect(JSON.stringify(completed.response.output)).toContain(REFUSAL_PREFIX);
  });

  it('passes frames that belong to no container call straight through, including partial chunks', () => {
    const gate = createCallGate(codex, denied);
    const text = frame('response.output_item.added', { output_index: 0, item: { id: 'm', type: 'message' } })
      + frame('response.output_text.delta', { item_id: 'm', delta: 'hello' });
    // split mid-frame: a chunk boundary must not lose or duplicate anything
    const half = Math.floor(text.length / 2);
    const out = gate.push(text.slice(0, half)) + gate.push(text.slice(half)) + gate.flush();
    expect(out).toBe(text);
  });

  it('is a pass-through when the client has no container tools or no policy denies anything', () => {
    for (const gate of [createCallGate(conventionFor('claude-cli/2.1.270', DEFAULT_MCP_NAMING), denied),
                        createCallGate(codex, []), createCallGate(codex, permissive)]) {
      const text = sequence(forbidden);
      expect(gate.push(text) + gate.flush()).toBe(text);
      expect(gate.suppressed()).toEqual([]);
    }
  });
});
