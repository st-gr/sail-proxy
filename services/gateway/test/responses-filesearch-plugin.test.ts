/**
 * Task 8: the shim that makes `file_search` REACHABLE.
 *
 * Everything before this task built pieces nothing called: the descriptor existed, the
 * engine was generic over it, `tools:hasFileSearch` sat unused in `hookDefinitions`. This
 * file is the join, and it is three claims, each of which fails silently if wrong:
 *
 *   1. importing the plugin REGISTERS the descriptor — without it the engine's registry
 *      lookups return undefined, `body.tools`' hosted entry is forwarded to a deployment
 *      that rejects the type outright, and nothing in the plugin itself looks broken;
 *   2. the rules it exports are the SHARED engine handlers, not copies — a second
 *      implementation would drift from the frame contract the characterization suite pins;
 *   3. it is a `export = pluginRules` CommonJS module, because `pluginLoader` requires the
 *      file and asserts `Array.isArray(plugin)`. An `export default` (or any named export
 *      alongside) makes the module an object, `pluginLoader` logs "Plugin must export an
 *      array of rules" and moves on — a gateway that boots clean with the tool dead.
 *
 * @see ../src/plugins/responsesFileSearchPlugin.ts
 * @see responses-tool-plugin-layering.test.ts - where the two hook arrays are pinned
 * @see responses-hooks-config.test.ts - where the `match` gating is pinned
 */
import { describe, it, expect, jest } from '@jest/globals';

// The descriptor's import graph reaches the retrieval stack; neither is exercised here.
jest.mock('../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => null,
}));

const toolConfig = { enabled: true, maxSearchesPerRequest: 5, maxNumResultsDefault: 10 };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getFileSearchToolConfig: () => toolConfig },
  getFileSearchToolConfig: () => toolConfig,
  getFileSearchConfig: () => ({ embeddingDimensions: 3, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 } }),
  MIN_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MIN_RESULTS_DEFAULT,
  MAX_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MAX_RESULTS_DEFAULT,
}));

import fileSearchRules = require('../src/plugins/responsesFileSearchPlugin');
import { descriptorForType, descriptorForFunctionName } from '../src/plugins/hostedTool/registry';
import { hostedToolBeforeHandler, hostedToolAfterHandler } from '../src/plugins/hostedTool/engine';
import { fileSearchDescriptor } from '../src/plugins/fileSearch/descriptor';

const rules = fileSearchRules as any[];

describe('responsesFileSearchPlugin', () => {
  it('registers the file_search descriptor as a side effect of being imported', () => {
    expect(descriptorForType('file_search')).toBe(fileSearchDescriptor);
    expect(descriptorForFunctionName('file_search')).toBe(fileSearchDescriptor);
  });

  it('exports a bare array of rules, the only shape pluginLoader accepts', () => {
    expect(Array.isArray(fileSearchRules)).toBe(true);
    expect(rules).toHaveLength(2);
    // `export =` and named exports cannot be mixed; a module that grew one would stop
    // being an array and pluginLoader would skip the file entirely.
    expect((fileSearchRules as any).default).toBeUndefined();
  });

  it('exports one before rule and one after rule, both under the id the hook entries name', () => {
    expect(rules.map(r => r.strategy).sort()).toEqual(['after', 'before']);
    for (const rule of rules) {
      expect(rule.id).toBe('responsesFileSearchPlugin');
      expect(rule.match).toEqual([]);           // gating lives in api_config, not here
      expect(typeof rule.handler).toBe('function');
    }
  });

  it('wires the SHARED engine handlers, not a second implementation', () => {
    // Identity, not shape: a copy would pass a "is a function" check and then drift from
    // the frame contract responses-websearch-characterization.test.ts pins byte for byte.
    expect(rules.find(r => r.strategy === 'before').handler).toBe(hostedToolBeforeHandler);
    expect(rules.find(r => r.strategy === 'after').handler).toBe(hostedToolAfterHandler);
  });

  it('is the same rule shape as the web-search shim, whose ids the two arrays interleave', () => {
    // Both shims are the same engine under different ids. Anything structural that is true
    // of one has to be true of the other, or the hook arrays are not comparable at all.
    const webRules = jest.requireActual<any[]>('../src/plugins/responsesWebSearchPlugin');
    expect(rules.map(r => ({ strategy: r.strategy, match: r.match })))
      .toEqual(webRules.map(r => ({ strategy: r.strategy, match: r.match })));
  });
});
