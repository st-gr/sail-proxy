/**
 * selectPluginCacheKeysToClear — config-reload require.cache eviction scope.
 *
 * Regression guard for the split-brain incident: a config-activation event used
 * to evict ALL gateway service modules from require.cache, leaving Express
 * handlers bound to old module instances while later require() calls created
 * fresh ones (model substitution silently failed until a manual restart).
 * Eviction must cover the plugins subtree ONLY.
 */
import { describe, it, expect } from '@jest/globals';
import { selectPluginCacheKeysToClear } from '../src/utils/pluginCacheSelector';

const P = '/repo/services/gateway/src/plugins';

const CACHE_KEYS = [
  `${P}/pseudonymization/index.ts`,
  `${P}/pseudonymization/replacementMap.ts`,
  `${P}/pseudonymization/detectors/regexDetectors.ts`,
  `${P}/webSearchPlugin.ts`,
  `${P}/awsBedrockResponseCache.ts`,
  '/repo/services/gateway/src/services/configService.ts',
  '/repo/services/gateway/src/services/modelService.ts',
  '/repo/services/gateway/src/services/awsBedrockService.ts',
  '/repo/services/gateway/src/controllers/anthropicController.ts',
  '/repo/services/gateway/src/utils/bedrockStreamParser.ts',
  '/repo/services/gateway/src/index.ts',
  '/repo/services/gateway/node_modules/axios/index.js',
  `${P}/../services/sneaky.ts`, // path traversal outside plugins after normalization? (kept literal — startsWith check)
];

describe('selectPluginCacheKeysToClear', () => {
  it('selects plugin entry files AND plugin-internal helper modules', () => {
    const selected = selectPluginCacheKeysToClear(CACHE_KEYS, P);
    expect(selected).toContain(`${P}/pseudonymization/index.ts`);
    expect(selected).toContain(`${P}/pseudonymization/replacementMap.ts`);
    expect(selected).toContain(`${P}/pseudonymization/detectors/regexDetectors.ts`);
    expect(selected).toContain(`${P}/webSearchPlugin.ts`);
    expect(selected).toContain(`${P}/awsBedrockResponseCache.ts`);
  });

  it('NEVER selects gateway service, controller, util, or entry modules', () => {
    const selected = selectPluginCacheKeysToClear(CACHE_KEYS, P);
    for (const key of selected) {
      expect(key.startsWith(P + '/')).toBe(true);
    }
    expect(selected).not.toContain('/repo/services/gateway/src/services/configService.ts');
    expect(selected).not.toContain('/repo/services/gateway/src/services/modelService.ts');
    expect(selected).not.toContain('/repo/services/gateway/src/services/awsBedrockService.ts');
    expect(selected).not.toContain('/repo/services/gateway/src/controllers/anthropicController.ts');
    expect(selected).not.toContain('/repo/services/gateway/src/utils/bedrockStreamParser.ts');
    expect(selected).not.toContain('/repo/services/gateway/src/index.ts');
  });

  it('excludes node_modules', () => {
    const selected = selectPluginCacheKeysToClear(
      [...CACHE_KEYS, `${P}/somePlugin/node_modules/dep/index.js`], P);
    expect(selected.some(k => k.includes('node_modules'))).toBe(false);
  });

  it('normalizes Windows-style separators and trailing slashes', () => {
    const winKeys = [
      'C:\\repo\\services\\gateway\\src\\plugins\\webSearchPlugin.ts',
      'C:\\repo\\services\\gateway\\src\\services\\modelService.ts',
    ];
    const selected = selectPluginCacheKeysToClear(winKeys, 'C:\\repo\\services\\gateway\\src\\plugins\\');
    expect(selected).toEqual(['C:\\repo\\services\\gateway\\src\\plugins\\webSearchPlugin.ts']);
  });

  it('does not match sibling directories sharing the prefix string', () => {
    const keys = ['/repo/services/gateway/src/plugins-backup/old.ts', `${P}/real.ts`];
    const selected = selectPluginCacheKeysToClear(keys, P);
    expect(selected).toEqual([`${P}/real.ts`]);
  });
});
