/**
 * Tool governance for one Realtime session (spec 2026-09-22 §5). Pure: the relay hands it the
 * client's text frames and the upstream's response.done frames; it answers what to forward, drop
 * or send, and never touches a socket.
 *
 * A Realtime session receives its history incrementally, so unlike an HTTP request the sources of
 * the trust chain accumulate here, and a session whose tools were declared earlier may have to be
 * corrected by a session.update the gateway sends itself.
 *
 * `instructions` is replaced wholesale by a session.update, so the notice is only ever appended to
 * instructions the client itself sent - in the frame, or remembered from an earlier one. A session
 * whose instructions the gateway never saw gets no notice rather than lost instructions.
 */
import { evaluate } from '../toolGovernance/evaluate';
import type { EvaluationResult } from '../toolGovernance/evaluate';
import { functionTool, UNKNOWN_SOURCE } from '../toolGovernance/identity';
import type { ToolIdentity, ToolPolicyBlock } from '../toolGovernance/identity';
import { appendNotice } from '../toolGovernance/stripNotice';

export interface GateOutcome {
  forward?: string;
  drop?: true;
  reply?: string;
  thenUpstream?: string;
  refused?: { identities: ToolIdentity[]; mode: 'strip' | 'reject'; result: EvaluationResult };
}

export interface RealtimeToolGate {
  onClientFrame(text: string): GateOutcome | null;
  onResponseDone(text: string): void;
  state(): { result: EvaluationResult; declared: ToolIdentity[]; sources: ToolIdentity[] };
}

export function realtimeErrorEvent(message: string, clientEventId: unknown): string {
  return JSON.stringify({
    type: 'error',
    event_id: `event_gw_${Date.now().toString(36)}`,
    error: { type: 'invalid_request_error', code: 'tool_not_entitled', message, event_id: typeof clientEventId === 'string' ? clientEventId : null }
  });
}

const MAX_SOURCES = 1000;
const isFunctionTool = (t: any): boolean => t?.type === 'function' && typeof t.name === 'string';
const idsOf = (tools: any[]): ToolIdentity[] => tools.filter(isFunctionTool).map((t) => functionTool(t.name));
const forcedOf = (choice: any): ToolIdentity | null =>
  choice && typeof choice === 'object' && choice.type === 'function' && typeof choice.name === 'string' ? functionTool(choice.name) : null;
const rejectedOf = (r: EvaluationResult): ToolIdentity[] => [...r.decisions].filter(([, d]) => d === 'rejected').map(([id]) => id);

export function createRealtimeToolGate(user: ToolPolicyBlock | null, key: ToolPolicyBlock | null): RealtimeToolGate {
  let tools: any[] = [];                 // the session's tools as last forwarded upstream
  let instructions: string | null = null; // the client's own instructions, as last sent
  let declared: ToolIdentity[] = [];
  const sources = new Map<ToolIdentity, number>();   // identity → results seen; bounded by distinct tools
  const callNames = new Map<string, string>();         // call id → name, until its result arrives
  let result = evaluate([], user, key, null, []);

  /** Each identity repeated by its count (the usage fold counts occurrences), at most MAX_SOURCES in all. */
  const expanded = (): ToolIdentity[] => {
    const out: ToolIdentity[] = [];
    for (const [id, count] of sources) {
      for (let i = 0; i < count && out.length < MAX_SOURCES; i++) out.push(id);
    }
    return out;
  };
  const judge = (list: any[], forced: ToolIdentity | null) => evaluate(idsOf(list), user, key, forced, [...sources.keys()]);
  const without = (list: any[], ids: ToolIdentity[]) => list.filter((t) => !(isFunctionTool(t) && ids.includes(functionTool(t.name))));

  function declaration(frame: any, container: 'session' | 'response'): GateOutcome | null {
    const body = frame[container];
    const r = judge(body.tools, forcedOf(body.tool_choice));
    if (r.reject) {
      return { drop: true, reply: realtimeErrorEvent(r.reason ?? 'tools not permitted by policy', frame.event_id),
        refused: { identities: rejectedOf(r), mode: 'reject', result: r } };
    }
    const kept = without(body.tools, r.blocked);
    if (container === 'session') {
      tools = kept; declared = idsOf(body.tools); result = r;
      if (typeof body.instructions === 'string') instructions = body.instructions;
    }
    if (r.blocked.length === 0) return null;
    const next: any = { ...body, tools: kept };
    const base = typeof body.instructions === 'string' ? body.instructions : container === 'session' ? instructions : null;
    if (base !== null && base !== undefined) next.instructions = appendNotice(base, r.blocked, r.taintedBy);
    return { forward: JSON.stringify({ ...frame, [container]: next }), refused: { identities: r.blocked, mode: 'strip', result: r } };
  }

  function functionResult(frame: any): GateOutcome | null {
    const name = callNames.get(frame.item.call_id);
    callNames.delete(frame.item.call_id);
    const source = name ? functionTool(name) : UNKNOWN_SOURCE;
    sources.set(source, (sources.get(source) ?? 0) + 1);
    const r = judge(tools, null);
    result = r;
    const withheld = [...r.reasons].filter(([, why]) => why === 'trust_chain').map(([id]) => id);
    if (withheld.length === 0 || r.mode === 'monitor') return null;
    if (r.mode === 'reject') {
      return { drop: true, reply: realtimeErrorEvent(r.reason ?? 'tools not permitted', frame.event_id),
        refused: { identities: withheld, mode: 'reject', result: r } };
    }
    tools = without(tools, withheld);
    const session: any = { tools };
    if (instructions !== null) session.instructions = appendNotice(instructions, withheld, r.taintedBy);
    return { thenUpstream: JSON.stringify({ type: 'session.update', session }), refused: { identities: withheld, mode: 'strip', result: r } };
  }

  return {
    onClientFrame(text) {
      let frame: any;
      try { frame = JSON.parse(text); } catch { return null; }
      if (frame?.type === 'session.update' && Array.isArray(frame.session?.tools)) return declaration(frame, 'session');
      if (frame?.type === 'session.update' && typeof frame.session?.instructions === 'string') { instructions = frame.session.instructions; return null; }
      if (frame?.type === 'response.create' && Array.isArray(frame.response?.tools)) return declaration(frame, 'response');
      if (frame?.type === 'conversation.item.create' && frame.item?.type === 'function_call_output') return functionResult(frame);
      return null;
    },
    onResponseDone(text) {
      let frame: any;
      try { frame = JSON.parse(text); } catch { return; }
      if (frame?.type !== 'response.done') return;
      for (const item of Array.isArray(frame.response?.output) ? frame.response.output : []) {
        if (item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') callNames.set(item.call_id, item.name);
      }
    },
    state() { return { result, declared, sources: expanded() }; }
  };
}
