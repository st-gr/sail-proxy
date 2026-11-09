/**
 * Registry keyed by JSON pointer, with '*' matching a single path segment. The renderer
 * consults it before rendering any node and delegates when a pattern matches, so a field
 * whose value must not be bound as text - a credential slot - never becomes an Input.
 */
const plugins = new Map<string, string>();

export function registerPlugin(pattern: string, plugin: string): void {
  plugins.set(pattern, plugin);
}

export function clearPlugins(): void {
  plugins.clear();
}

export function pluginFor(pointer: string): string | undefined {
  for (const [pattern, plugin] of plugins) {
    const rx = new RegExp('^' + pattern.split('*').map(escapeSegment).join('[^/]+') + '$');
    if (rx.test(pointer)) return plugin;
  }
  return undefined;
}

function escapeSegment(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
