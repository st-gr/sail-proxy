/**
 * Select which require.cache keys may be evicted on a configuration reload.
 *
 * ONLY modules under the plugins directory are eligible. Evicting gateway
 * SERVICE modules on a config push causes split-brain state: Express handlers
 * registered at startup keep referencing the old module instances, while any
 * later require() creates fresh instances with empty caches — the two worlds
 * then disagree (observed as model substitution silently failing after a
 * config-activation event until a manual restart). Service code changes are
 * picked up by nodemon (dev) or a deploy restart (prod), never by config
 * pushes. Plugin ENTRY files are cache-cleared by pluginLoader itself; this
 * selector additionally covers plugin-internal helper modules (e.g.
 * plugins/pseudonymization/*.ts) that plugin entries import.
 */
export function selectPluginCacheKeysToClear(
  cacheKeys: string[],
  pluginsDirPrefix: string
): string[] {
  const prefix = pluginsDirPrefix.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  return cacheKeys.filter(key => {
    const normalized = key.replace(/\\/g, '/');
    return normalized.startsWith(prefix) && !normalized.includes('node_modules');
  });
}
