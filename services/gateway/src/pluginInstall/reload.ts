import * as path from 'path';
import { getDefaultLogger } from '@libs/logger';
import { reloadAll } from '../services/pluginLoader';
import { selectPluginCacheKeysToClear } from '../utils/pluginCacheSelector';

const logger = getDefaultLogger();

/**
 * Reload the plugin modules. The caller must already hold the plugin lock: this
 * is the body of the locked reload in configService, and the plugin runtime calls
 * it from inside its own lock, because the lock is not re-entrant.
 *
 * Evicts ONLY the plugins subtree from require.cache (plugin entry files plus
 * their plugin-internal helper modules, e.g. plugins/pseudonymization/*), then
 * lets pluginLoader rebuild the registry. pluginSupport/ stays loaded: core uses it too. Gateway SERVICE modules are never
 * evicted: doing so caused split-brain state — Express handlers registered at
 * startup kept referencing the old module instances while later require()
 * calls created fresh ones with empty caches, and the two worlds disagreed
 * (observed as model substitution silently failing after a config-activation
 * event until a manual restart). Service code changes are picked up by nodemon
 * (dev) or a deploy restart (prod), never by config pushes.
 *
 * @param pluginsDir - Test seam; everything else uses the shipped plugins directory.
 */
export async function reloadPluginsInsideLock(pluginsDir?: string): Promise<void> {
  try {
    const pluginsDirPrefix = pluginsDir ?? path.join(__dirname, '..', 'plugins');
    const keys = selectPluginCacheKeysToClear(Object.keys(require.cache), pluginsDirPrefix);
    for (const key of keys) {
      delete require.cache[key];
    }
    if (keys.length > 0) {
      logger.info('ConfigService', `Cleared require cache for ${keys.length} plugin modules`);
    }
    reloadAll(pluginsDir);
    logger.info('ConfigService', 'Plugins reloaded successfully');
  } catch (pluginError: any) {
    logger.error('ConfigService', `Error reloading plugins: ${pluginError.message}`);
  }
}
