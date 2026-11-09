/**
 * The hosted-tool registry: the one place `hostedTool/engine.ts` asks "is this mine, and
 * whose?".
 *
 * Two indexes, because the engine looks tools up from both directions: by hosted `type`
 * on the REQUEST side (a `{ "type": "web_search" }` entry in `body.tools` that has to be
 * rewritten), and by function `name` on the RESPONSE side (a `function_call` the model
 * emitted against the rewritten tool).
 *
 * Registration is a module-level side effect of importing a plugin file — see
 * `responsesWebSearchPlugin.ts`. Registering the same descriptor twice is a no-op, so a
 * suite that loads the plugin more than once is safe.
 */
import { HostedToolDescriptor } from './descriptor';

const byType = new Map<string, HostedToolDescriptor>();
const byFunctionName = new Map<string, HostedToolDescriptor>();

/**
 * Reject a second descriptor claiming a key the first one already holds.
 *
 * Re-registering the SAME descriptor is a no-op, so a plugin file imported twice is fine.
 * A DIFFERENT descriptor on the same key is a programming error, and silently letting the
 * last import win is the worst available outcome: the engine would route the first tool's
 * calls through the second tool's renderers and hand Codex a frame contract nothing pins.
 * Throwing makes it deterministic and loud at boot — `pluginLoader` catches it, logs the
 * message below and the plugin visibly fails to load — rather than a gateway that starts
 * clean and behaves wrongly.
 */
function assertUnclaimed(
  index: Map<string, HostedToolDescriptor>, key: string, d: HostedToolDescriptor, label: string,
): void {
  const existing = index.get(key);
  if (existing && existing !== d) {
    throw new Error(
      `hostedTool registry: ${label} "${key}" is already registered by the "${existing.type}" descriptor; ` +
      `"${d.type}" cannot claim it too`
    );
  }
}

export function registerDescriptor(d: HostedToolDescriptor): void {
  // Both checks before either write: a descriptor that clashes on only its function name
  // must not leave its `type` half-registered behind the throw.
  assertUnclaimed(byType, d.type, d, 'tool type');
  assertUnclaimed(byFunctionName, d.functionName, d, 'function name');
  byType.set(d.type, d);
  byFunctionName.set(d.functionName, d);
}

export function descriptorForType(type: string): HostedToolDescriptor | undefined {
  return byType.get(type);
}

export function descriptorForFunctionName(name: string): HostedToolDescriptor | undefined {
  return byFunctionName.get(name);
}

/** The descriptor a hosted tool entry in `body.tools` belongs to, if any. */
export function descriptorForHostedTool(tool: any): HostedToolDescriptor | undefined {
  if (!tool || typeof tool.type !== 'string') return undefined;
  return byType.get(tool.type);
}

/**
 * The descriptor a Responses output item belongs to, if any.
 *
 * The `type === 'function_call'` half of the check is not redundant with the name lookup:
 * a `function_call_output` carries no `name`, but a future item shape might, and matching
 * one as a call would answer it twice.
 */
export function descriptorForCall(item: any): HostedToolDescriptor | undefined {
  if (!item || item.type !== 'function_call' || typeof item.name !== 'string') return undefined;
  return byFunctionName.get(item.name);
}

export function isHostedToolCall(item: any): boolean {
  return descriptorForCall(item) !== undefined;
}

/**
 * The descriptor for a hosted call item a client replayed — `web_search_call`,
 * `file_search_call`. Deliberately separate from `descriptorForCall`, which matches the
 * `function_call` the MODEL emits: these are two different wire shapes travelling in two
 * different directions, and conflating them would let a replayed item be mistaken for a
 * pending call the model just made.
 */
export function descriptorForReplayedCallItem(item: any): HostedToolDescriptor | undefined {
  if (!item || typeof item.type !== 'string' || !item.type.endsWith('_call')) return undefined;
  return byType.get(item.type.slice(0, -'_call'.length));
}

export function allDescriptors(): HostedToolDescriptor[] {
  return [...byType.values()];
}

/** Test-only: registries are module state and leak across suites otherwise. */
export function __resetRegistry(): void {
  byType.clear();
  byFunctionName.clear();
}
