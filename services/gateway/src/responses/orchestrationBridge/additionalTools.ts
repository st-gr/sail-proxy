/**
 * Codex 0.149 declares its tools in an `additional_tools` input item, not in `tools`. A deployment
 * takes that item; orchestration has no such thing. Runs before the plugins, so the namespace and
 * custom-tool plugins find these tools in `tools`, where they look.
 */
const isItem = (i: any): boolean => i?.type === 'additional_tools';

/**
 * `namespaceTools/adapter.ts` flattens a namespace into its function tools and drops the rest, and
 * Codex's `exec` is a custom tool inside one, so custom tools move out first.
 */
function liftCustomTools(tool: any): any[] {
  if (tool?.type !== 'namespace' || !Array.isArray(tool.tools)) return [tool];
  const custom = tool.tools.filter((t: any) => t?.type === 'custom');
  if (custom.length === 0) return [tool];
  const rest = tool.tools.filter((t: any) => t?.type !== 'custom');
  return rest.length > 0 ? [...custom, { ...tool, tools: rest }] : custom;
}

/** Move every `additional_tools` item of `body.input` into `body.tools`, in place. */
export function hoistAdditionalTools(body: any): void {
  if (!Array.isArray(body?.input) || !body.input.some(isItem)) return;
  const hoisted = body.input.filter(isItem).flatMap((i: any) => (Array.isArray(i.tools) ? i.tools : [])).flatMap(liftCustomTools);
  body.input = body.input.filter((i: any) => !isItem(i));
  if (hoisted.length > 0) body.tools = [...(Array.isArray(body.tools) ? body.tools : []), ...hoisted];
}
