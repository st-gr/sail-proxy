// Pure helpers for the compose override test: which host ports the override publishes.
export const RESERVED_HOST_PORTS = new Set([3000, 4004, 6379, 5432]);

/** Host ports from every "host:container" or "ip:host:container" mapping in a compose text. */
export function hostPorts(text) {
  const out = [];
  for (const m of text.matchAll(/"(?:(\d+\.\d+\.\d+\.\d+):)?(\d+):(\d+)"/g)) out.push(Number(m[2]));
  return out;
}
