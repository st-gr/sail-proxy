import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { groupSections } from '../webapp/model/apiConfigGroups';
import { applyDescriptor, buildDescriptors, Descriptor } from '../webapp/model/schemaForm';
import { pluginFor } from '../webapp/model/formPlugins';
import { validateSection } from '../webapp/model/validateSection';
import { wrapAt } from './helpers/wrapAt';

/**
 * `platform.toolGovernance.mcpNaming.clients[]` carries `serverNames` and `namePattern`, which the
 * gateway reads (`mcpNaming.ts`) but the schema used to reject. The values below are the shipped
 * presets (`DEFAULT_MCP_NAMING`) plus a configured opencode entry.
 */
const section = groupSections(apiConfigSchema, 'platform').find(s => s.key === 'toolGovernance')!;

const data = {
  mcpNaming: {
    namePattern: '^mcp__(.+?)__(.+)$',
    clients: [
      { name: 'claude-code', userAgent: 'claude-cli', containerTools: [] },
      { name: 'codex', userAgent: 'codex-tui', containerTools: ['exec'], nestedCallPattern: 'tools\\.([A-Za-z0-9_]+)' },
      { name: 'opencode', userAgent: 'opencode', containerTools: [], serverNames: [] },
      { name: 'opencode-live', userAgent: 'opencode', containerTools: [], serverNames: ['probe', 'abap2ui5'], namePattern: '^([a-z0-9]+)_(.+)$' }
    ]
  }
};

function flatten(descriptors: Descriptor[]): Descriptor[] {
  const out: Descriptor[] = [];
  for (const d of descriptors) {
    out.push(d);
    if (d.kind === 'section') out.push(...flatten(d.children));
    else if (d.kind === 'table') d.rows.forEach(r => out.push(...flatten(r)));
    else if ('items' in d && Array.isArray((d as any).items)) {
      for (const item of (d as any).items) if (Array.isArray(item)) out.push(...flatten(item));
    }
  }
  return out;
}

describe('MCP naming clients: serverNames and namePattern', () => {
  it('validates the shipped presets and a client carrying both fields', () => {
    expect(validateSection(section.schema as object, data, section.pointer)).toEqual([]);
  });

  it.each([
    ['gateway', require('../../../../gateway/api_config.json')],
    ['admin', require('../../../api_config.json')],
    ['npm template', require('../../../../../npm-dist/sail-proxy/src/templates/api_config.template.json')]
  ])('validates the toolGovernance section of the shipped %s configuration', (_name, shipped) => {
    const toolGovernance = shipped.api_config.platform.toolGovernance;
    expect(toolGovernance.mcpNaming.clients.length).toBeGreaterThan(0);
    expect(validateSection(section.schema as object, toolGovernance, section.pointer)).toEqual([]);
  });

  it('still rejects a non-string server name and an unknown client key', () => {
    const client = `${section.pointer}/mcpNaming/clients/3`;
    const bad = JSON.parse(JSON.stringify(data));
    bad.mcpNaming.clients[3].serverNames = [1];
    expect(validateSection(section.schema as object, bad, section.pointer))
      .toEqual([`Schema validation error at '${client}/serverNames/0': must be string`]);
    const unknown = JSON.parse(JSON.stringify(data));
    unknown.mcpNaming.clients[3].serverName = ['probe'];
    expect(validateSection(section.schema as object, unknown, section.pointer))
      .toEqual([`Schema validation error at '${client}': must NOT have additional properties`]);
  });

  it('builds typed descriptors for both fields and round-trips the section unchanged', () => {
    const ds = buildDescriptors(section.schema as object, data, section.pointer, pluginFor);
    const all = flatten(ds);
    expect(all.filter(d => d.kind === 'raw')).toEqual([]);
    for (const key of ['serverNames', 'namePattern']) {
      expect(all.some(d => 'pointer' in d && d.pointer.endsWith(`/clients/3/${key}`))).toBe(true);
    }
    let out: unknown = wrapAt(section.pointer, JSON.parse(JSON.stringify(data)));
    for (const d of all) {
      if ('value' in d && d.pointer.includes('/mcpNaming/')) out = applyDescriptor(out, d.pointer, (d as { value: unknown }).value);
    }
    expect(out).toEqual(wrapAt(section.pointer, data));
  });
});
