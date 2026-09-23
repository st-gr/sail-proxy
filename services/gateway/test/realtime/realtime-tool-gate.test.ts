/**
 * The per-session Realtime tool gate (spec 2026-09-22 §5): declarations on session.update and
 * response.create are stripped or refused; function results accumulate as sources; an untrusted
 * result withholds sensitive tools with a corrective session.update (strip) or is refused (reject).
 */
import { createRealtimeToolGate } from '../../src/realtime/realtimeToolGate';

const policy = (mode: string, over: any = {}) => ({ policyId: 'p', policyName: 'Voice', mode, allow: [], deny: [],
  sensitive: ['function:send_mail'], untrusted: ['function:fetch_page'], ...over }) as any;
const tool = (name: string) => ({ type: 'function', name, parameters: {} });
const sessionUpdate = (tools: any[], extra: any = {}) => JSON.stringify({ type: 'session.update', event_id: 'ev1', session: { tools, ...extra } });
const parse = (s?: string) => (s ? JSON.parse(s) : undefined);

describe('declarations', () => {
  it('strip removes a denied tool and appends the notice to the frame\'s instructions', () => {
    const gate = createRealtimeToolGate(policy('strip', { deny: ['function:shell'] }), null);
    const out = gate.onClientFrame(sessionUpdate([tool('shell'), tool('weather')], { instructions: 'be kind' }))!;
    const f = parse(out.forward);
    expect(f.session.tools.map((t: any) => t.name)).toEqual(['weather']);
    expect(f.session.instructions).toContain('be kind');
    expect(f.session.instructions).toContain('[tool policy]');
    expect(out.refused).toMatchObject({ identities: ['function:shell'], mode: 'strip' });
  });
  it('strip without instructions in the frame: tools removed, instructions untouched', () => {
    const gate = createRealtimeToolGate(policy('strip', { deny: ['function:shell'] }), null);
    const f = parse(gate.onClientFrame(sessionUpdate([tool('shell'), tool('weather')]))!.forward);
    expect(f.session).not.toHaveProperty('instructions');
    expect(f.session.tools).toHaveLength(1);
  });
  it('reject drops the frame and answers with a Realtime error event', () => {
    const gate = createRealtimeToolGate(policy('reject', { deny: ['function:shell'] }), null);
    const out = gate.onClientFrame(sessionUpdate([tool('shell')]))!;
    expect(out.drop).toBe(true);
    const e = parse(out.reply);
    expect(e).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', code: 'tool_not_entitled', event_id: 'ev1' } });
  });
  it('response.create tools are judged the same way', () => {
    const gate = createRealtimeToolGate(policy('strip', { deny: ['function:shell'] }), null);
    const f = parse(gate.onClientFrame(JSON.stringify({ type: 'response.create', response: { tools: [tool('shell'), tool('weather')] } }))!.forward);
    expect(f.response.tools.map((t: any) => t.name)).toEqual(['weather']);
  });
  it('monitor and non-tool frames are left alone', () => {
    const gate = createRealtimeToolGate(policy('monitor', { deny: ['function:shell'] }), null);
    expect(gate.onClientFrame(sessionUpdate([tool('shell')]))).toBeNull();
    expect(gate.onClientFrame('{"type":"input_audio_buffer.append","audio":"AAA="}')).toBeNull();
    expect(gate.onClientFrame('not json')).toBeNull();
    expect(gate.state().declared).toEqual(['function:shell']);
  });
});

describe('trust chain in a session', () => {
  const setup = (mode: string) => {
    const gate = createRealtimeToolGate(policy(mode), null);
    gate.onClientFrame(sessionUpdate([tool('send_mail'), tool('fetch_page')], { instructions: 'assist' }));
    gate.onResponseDone(JSON.stringify({ type: 'response.done', response: { output: [{ type: 'function_call', call_id: 'c1', name: 'fetch_page', arguments: '{}' }] } }));
    return gate;
  };
  const result = JSON.stringify({ type: 'conversation.item.create', event_id: 'ev2', item: { type: 'function_call_output', call_id: 'c1', output: 'page' } });
  it('strip: the result is forwarded and a corrective session.update withholds the sensitive tool', () => {
    const gate = setup('strip');
    const out = gate.onClientFrame(result)!;
    expect(out.forward).toBeUndefined();
    expect(out.drop).toBeUndefined();
    const fix = parse(out.thenUpstream);
    expect(fix.type).toBe('session.update');
    expect(fix.session.tools.map((t: any) => t.name)).toEqual(['fetch_page']);
    expect(fix.session.instructions).toContain('content from function:fetch_page');
    expect(gate.state().sources).toEqual(['function:fetch_page']);
    expect(gate.onClientFrame(result)).toBeNull();   // already withheld: no second update
  });
  it('reject: the result is refused', () => {
    const out = setup('reject').onClientFrame(result)!;
    expect(out.drop).toBe(true);
    expect(parse(out.reply).error.code).toBe('tool_not_entitled');
  });
  it('monitor: nothing changes, the source is still recorded', () => {
    const gate = setup('monitor');
    expect(gate.onClientFrame(result)).toBeNull();
    expect(gate.state().sources).toEqual(['function:fetch_page']);
  });
  it('a call id is forgotten once its result is processed: a second result for it is <unknown>', () => {
    const gate = setup('monitor');
    gate.onClientFrame(result);
    gate.onClientFrame(result);
    expect(gate.state().sources).toEqual(['function:fetch_page', 'function:<unknown>']);
  });
  it('sources keep their counts', () => {
    const gate = createRealtimeToolGate(policy('monitor'), null);
    const orphan = (id: string) => JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output: 'x' } });
    gate.onClientFrame(orphan('a'));
    gate.onClientFrame(orphan('b'));
    expect(gate.state().sources).toEqual(['function:<unknown>', 'function:<unknown>']);
  });
  it('a result for an unknown call counts as <unknown>', () => {
    const gate = createRealtimeToolGate(policy('strip'), null);
    gate.onClientFrame(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'zz', output: 'x' } }));
    expect(gate.state().sources).toEqual(['function:<unknown>']);
  });
});
