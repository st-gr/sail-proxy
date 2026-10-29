import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { groupSections } from '../webapp/model/apiConfigGroups';
import { evaluateApiConfigDocument } from '../webapp/model/documentGate';
import { buildDescriptors } from '../webapp/model/schemaForm';
import { clearPlugins, pluginFor } from '../webapp/model/formPlugins';

/**
 * `capabilities.file_search.chunking`: the form must show exactly what the gateway runs. The gateway
 * (configService.ts `chunkingConfig`) resolves an absent strategy to "static" and an absent
 * contextual to false - the values the form shows for an unset select (the schema `default`) and an
 * unset switch (off). The one shape the form cannot show, contextual on without a strategy, is
 * refused by the gate, so the form never saves it.
 */
describe('file_search.chunking in the Configuration form', () => {
  beforeEach(() => clearPlugins());

  const shippedConfig = require('../../../../gateway/api_config.json');
  const shipped = shippedConfig.api_config;
  const clone = (value: unknown): any => JSON.parse(JSON.stringify(value));

  const flatten = (descriptors: any[]): any[] =>
    descriptors.reduce<any[]>((all, d) => all.concat([d], d.kind === 'section' ? flatten(d.children) : []), []);

  const chunkingControls = (chunking: unknown) => {
    const section = groupSections(apiConfigSchema, 'capabilities').find(s => s.key === 'file_search');
    if (!section) throw new Error('schema has no capabilities.file_search section');
    const fileSearch = clone(shipped.capabilities.file_search);
    if (chunking === undefined) delete fileSearch.chunking;
    else fileSearch.chunking = chunking;
    const tree = flatten(buildDescriptors(section.schema as object, fileSearch, section.pointer, pluginFor));
    const at = (key: string) => tree.find(d => d.pointer === `/api_config/capabilities/file_search/chunking/${key}`);
    return { strategy: at('strategy').value, contextual: at('contextual').value };
  };

  const gateErrors = (chunking: unknown): string[] => {
    const document = clone(shippedConfig);
    document.api_config.capabilities.file_search.chunking = chunking;
    return evaluateApiConfigDocument(apiConfigSchema, document).errors;
  };

  it('shows an upgraded block (sizes only) as static without contexts, which the gateway runs', () => {
    expect(chunkingControls({ max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 }))
      .toEqual({ strategy: 'static', contextual: false });
  });

  it('shows a missing or empty block as static without contexts', () => {
    expect(chunkingControls(undefined)).toEqual({ strategy: 'static', contextual: false });
    expect(chunkingControls({})).toEqual({ strategy: 'static', contextual: false });
  });

  it('shows the shipped block as structure with contexts', () => {
    expect(shipped.capabilities.file_search.chunking)
      .toEqual({ strategy: 'structure', max_chunk_size_tokens: 800, chunk_overlap_tokens: 0, contextual: true });
    expect(chunkingControls(shipped.capabilities.file_search.chunking))
      .toEqual({ strategy: 'structure', contextual: true });
  });

  it('shows structure without a contextual key as contexts off, which the gateway runs', () => {
    expect(chunkingControls({ strategy: 'structure' })).toEqual({ strategy: 'structure', contextual: false });
  });

  it('the gate refuses contextual on unless the strategy is set to structure', () => {
    expect(gateErrors({ contextual: true }).some(e => e.includes('/chunking'))).toBe(true);
    expect(gateErrors({ max_chunk_size_tokens: 800, contextual: true }).some(e => e.includes('/chunking'))).toBe(true);
    expect(gateErrors({ strategy: 'static', contextual: true }).some(e => e.includes('/chunking'))).toBe(true);
    expect(gateErrors({ strategy: 'structure', contextual: true })).toEqual([]);
    expect(gateErrors({ strategy: 'structure', contextual: false })).toEqual([]);
    expect(gateErrors({ max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 })).toEqual([]);
    expect(gateErrors({ contextual: false })).toEqual([]);
  });
});
