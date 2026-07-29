/**
 * No web-search hook may ever be gated more loosely than the masking hook beside it.
 *
 * `pluginLoader.matchAll` is an AND: every rule id in a hook's `match` array has to match,
 * and it early-exits on the first that doesn't. With pseudonymizationPlugin gated on
 * `header:contentTypeJson` and a web-search plugin gated only on a body regex, any client
 * whose content-type failed that header rule got NO masking while still entering the
 * web-search plugin — a raw query straight to Perplexity, a third-party model. Gating the
 * web-search plugin on at least the same rules makes the implication hold: no masking, no
 * web search.
 *
 * (`matchHeader` used to compare the content-type by exact string equality, so
 * `application/json; charset=utf-8` — OkHttp, .NET JsonContent, older axios — matched
 * nothing; that is what made the divergence reachable in practice. Task 1 of this branch
 * fixed the comparison itself: `headerValueMatches` now compares media type alone unless
 * the expected value spells out parameters. This test remains the containment guarantee,
 * which does not depend on that fix being in place.)
 *
 * Walks EVERY hook array in the shipped config, not just the two Responses subpaths: the
 * same divergence exists per-model for the Anthropic `webSearchPlugin` under
 * `model_list_changes.*.hooks.*`, and those entries had nothing guarding them — reverting
 * all 18 of them left the whole suite green.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const apiConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8'));

const WEB_SEARCH_PLUGIN_IDS = new Set(['webSearchPlugin', 'responsesWebSearchPlugin']);
// Every tool plugin the match-superset check below applies to. Broader than
// WEB_SEARCH_PLUGIN_IDS: responsesNamespaceToolsPlugin carries no `tools:hasWebSearch`
// match (that rule is specific to the web-search plugins), but it still must never be
// gated more loosely than the masking plugin beside it.
const TOOL_PLUGIN_IDS = new Set([...WEB_SEARCH_PLUGIN_IDS, 'responsesNamespaceToolsPlugin']);
const MASKING_PLUGIN_ID = 'pseudonymizationPlugin';

interface HookEntry { request?: { callback?: { id?: string }; match?: string[] } }

/**
 * Every hook array anywhere in the config, paired with its dotted path. A hook array is
 * identified structurally (entries carrying `request.callback`) rather than by location,
 * so a hook array added under a key this test has never heard of is still covered.
 */
function collectHookArrays(node: any, at: string, found: Array<[string, HookEntry[]]>): Array<[string, HookEntry[]]> {
  if (Array.isArray(node)) {
    if (node.some(entry => entry?.request?.callback)) found.push([at, node]);
    return found;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) collectHookArrays(node[key], at ? `${at}.${key}` : key, found);
  }
  return found;
}

const idOf = (entry: HookEntry): string | undefined => entry?.request?.callback?.id;

// Selected on the SAME id set the per-entry check below applies, not the narrower
// web-search one: selecting on WEB_SEARCH_PLUGIN_IDS meant a hook array carrying
// responsesNamespaceToolsPlugin without a web-search sibling was never visited at all, so
// the invariant held only by the two happening to be co-located today.
const toolHookArrays = collectHookArrays(apiConfig, '', [])
  .filter(([, entries]) => entries.some(entry => TOOL_PLUGIN_IDS.has(idOf(entry) ?? '')));

describe('shipped tool-plugin hook gating', () => {
  it('finds every tool-plugin hook array in the shipped config', () => {
    // A walker that silently matched nothing would leave describe.each below with no cases
    // and the suite green — the exact failure mode this file exists to close. 20 = the 2
    // Responses subpaths + 18 Anthropic per-model entries (9 models x 2 subpaths) at the
    // time of writing; adding a model raises it, so this is a floor, not a pin.
    expect(toolHookArrays.length).toBeGreaterThanOrEqual(20);
    const paths = toolHookArrays.map(([p]) => p);
    expect(paths).toContain('api_config.defaultHooks.openai.responses');
    expect(paths).toContain('api_config.defaultHooks.openai.responses-stream');
    expect(paths.filter(p => p.includes('model_list_changes')).length).toBeGreaterThanOrEqual(18);
  });

  describe.each(toolHookArrays)('%s', (_path, entries) => {
    it('gates every tool plugin on at least everything the masking plugin is gated on', () => {
      const masking = (entries as HookEntry[]).find(entry => idOf(entry) === MASKING_PLUGIN_ID);
      // No masking entry at all would make the superset check below vacuous, so a hook
      // array carrying a tool plugin has to have one.
      expect(masking).toBeDefined();
      const maskingMatch = masking!.request!.match || [];
      expect(maskingMatch).toContain('header:contentTypeJson');

      for (const entry of entries as HookEntry[]) {
        const id = idOf(entry) ?? '';
        if (!TOOL_PLUGIN_IDS.has(id)) continue;
        const toolMatch = entry.request!.match || [];
        for (const rule of maskingMatch) {
          expect(toolMatch).toContain(rule);
        }
        if (WEB_SEARCH_PLUGIN_IDS.has(id)) {
          expect(toolMatch).toContain('tools:hasWebSearch');
        }
      }
    });
  });
});
