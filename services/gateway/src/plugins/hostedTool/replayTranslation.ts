/**
 * Turning the client's replayed hosted call items back into the shape the model's tool list
 * actually uses.
 *
 * The engine rewrites a hosted tool into a function tool, so the model only ever sees
 * `function_call`/`function_call_output`. What the CLIENT replays is the hosted `<type>_call`
 * item the gateway rendered for it — a shape the deployment has no tool for. Left alone it
 * reads as a completed call with no output, belonging to a tool that is not in the list, and
 * the model responds by promising to search rather than searching (measured: 0 searches in 4
 * live control calls; 5 of 6 once the pair is restored).
 */
import { HostedToolDescriptor } from './descriptor';

export function buildReplayFunctionCall(descriptor: HostedToolDescriptor, item: any, query: string): any {
  return {
    type: 'function_call',
    call_id: item.id,
    name: descriptor.functionName,
    arguments: JSON.stringify({ query }),
  };
}
