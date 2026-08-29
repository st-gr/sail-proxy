/**
 * Builds a document that carries `data` at `pointer`, wrapping it in a fresh object per segment -
 * `wrapAt('/api_config/platform/timeouts', data)` is `{ api_config: { platform: { timeouts: data } } }`.
 *
 * `applyDescriptor` is root-anchored: it walks a pointer from the document root and creates the
 * objects between, so a descriptor tree built from a section's own data (not the whole document)
 * needs that section wrapped back to its pointer before a round trip through `applyDescriptor` can
 * be compared against it. This is that wrapping, shared by every test harness that builds
 * descriptors from section data rather than from a whole document.
 */
export function wrapAt(pointer: string, data: unknown): Record<string, unknown> {
  const segments = pointer.split('/').filter(Boolean).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const root: Record<string, unknown> = {};
  let cursor = root;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) { cursor[segment] = data; return; }
    cursor[segment] = {}; cursor = cursor[segment] as Record<string, unknown>;
  });
  return root;
}
