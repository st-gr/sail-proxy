import { applyDescriptor, buildDescriptors, documentOrderedKeys, mapEntriesOf, mapNodesOf } from '../webapp/model/schemaForm';
import { registerPlugin, clearPlugins, pluginFor } from '../webapp/model/formPlugins';
import apiConfigSchema, { siemSchemaDef } from '../webapp/model/apiConfigSchema';
import { groupSections, resolveGroupSchema } from '../webapp/model/apiConfigGroups';
import { wrapAt } from './helpers/wrapAt';

const siemSchema = siemSchemaDef as any;

const siemData = {
  enabled: false,
  batch_size: 100,
  interval_ms: 15000,
  reconcile_lookback_ms: 86400000,
  categories: ['security', 'audit'],
  sinks: [
    { name: 'datadog', type: 'datadog', enabled: false, site: 'datadoghq.com',
      api_key_env: 'SIEM_DATADOG_API_KEY' },
  ],
};

/** The shape the sink array now takes: a section per sink, each holding that sink's fields. */
interface SinkSections {
  kind: string;
  pointer: string;
  arrayItems?: { discriminated: boolean; skeleton: unknown };
  children: Array<{
    kind: string;
    label: string;
    collapsed?: boolean;
    arrayIndex?: number;
    children: Array<{ kind: string; pointer: string; label: string; readOnly?: boolean }>;
  }>;
}

/** The `sinks` descriptor for a given siem block, typed as the sections it is. */
const sinkSections = (data: unknown): SinkSections =>
  buildDescriptors(siemSchema, data, '/api_config/observability/siem', pluginFor)
    .find(x => x.pointer === '/api_config/observability/siem/sinks') as unknown as SinkSections;

describe('schemaForm', () => {
  beforeEach(() => clearPlugins());

  it('renders a boolean as a switch', () => {
    const d = buildDescriptors(siemSchema, siemData, '/api_config/observability/siem', pluginFor);
    const enabled = d.find(x => x.pointer === '/api_config/observability/siem/enabled');
    expect(enabled).toMatchObject({ kind: 'switch', value: false });
  });

  // A switch is where a setting is turned ON, and two of the sink switches disclose data
  // when they are. An operator must be able to read what one does at the control itself,
  // not only in a schema file they will never open.
  it('carries the schema description onto a switch, so a risky opt-in can state its risk', () => {
    const sinks = sinkSections(siemData);
    const byField = (field: string) =>
      sinks.children[0].children.find(c => c.pointer.endsWith(`/${field}`)) as any;

    expect(byField('allow_unmasked_content').description).toContain('RISK');
    expect(byField('allow_unmasked_content').description).toMatch(/never masked/i);
    expect(byField('include_credential_material').description).toBeDefined();
    // The schema's own text, not a second copy maintained here.
    expect(byField('include_content').description)
      .toBe(siemSchema.properties.sinks.items.properties.include_content.description);
  });

  // The switch above was the special case. Every property of this schema has a description
  // written to explain exactly these settings, and none of it reached the user; the tooltip
  // is now the ordinary mechanism, so a boolean is no longer the only field that can say
  // what it does.
  it('carries the schema description onto every kind of control, not only a switch', () => {
    const top = buildDescriptors(siemSchema, siemData, '/api_config/observability/siem', pluginFor);
    const byPointer = (pointer: string) => top.find(x => x.pointer === pointer) as any;

    // number, list and the array section itself.
    expect(byPointer('/api_config/observability/siem/batch_size').description)
      .toBe(siemSchema.properties.batch_size.description);
    expect(byPointer('/api_config/observability/siem/categories').description)
      .toBe(siemSchema.properties.categories.description);
    expect(byPointer('/api_config/observability/siem/sinks').description)
      .toBe(siemSchema.properties.sinks.description);

    // text, and the read-only discriminator select - which keeps its own "why you cannot
    // edit this" tooltip at the control layer, but still carries the description here.
    const sinkFields = sinkSections(siemData).children[0].children;
    const byField = (field: string) =>
      sinkFields.find(c => c.pointer.endsWith(`/${field}`)) as any;
    expect(byField('site').description)
      .toBe(siemSchema.properties.sinks.items.properties.site.description);
    expect(byField('type')).toMatchObject({
      kind: 'select',
      readOnly: true,
      description: siemSchema.properties.sinks.items.properties.type.description
    });
  });

  // An absent description must leave the key off rather than set it to "", so the control
  // layer renders no tooltip instead of an empty one.
  it('sets no description key at all when the schema has none', () => {
    const bare = {
      type: 'object',
      properties: {
        described: { type: 'string', description: 'This one says something.' },
        silent: { type: 'string' },
        blank: { type: 'string', description: '' }
      }
    };
    const d = buildDescriptors(bare, { described: 'a', silent: 'b', blank: 'c' }, '', pluginFor);

    expect((d.find(x => x.pointer === '/described') as any).description).toBe('This one says something.');
    expect(Object.prototype.hasOwnProperty.call(d.find(x => x.pointer === '/silent'), 'description')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(d.find(x => x.pointer === '/blank'), 'description')).toBe(false);
  });

  it('carries the schema minimum onto a number', () => {
    const d = buildDescriptors(siemSchema, siemData, '/api_config/observability/siem', pluginFor);
    const interval = d.find(x => x.pointer === '/api_config/observability/siem/interval_ms');
    expect(interval).toMatchObject({ kind: 'number', value: 15000, minimum: 1000 });
  });

  it('marks a type:integer field integer, so the control keeps whole-number stepping', () => {
    const schema = { type: 'object', properties: { retries: { type: 'integer' } } };
    const d = buildDescriptors(schema, { retries: 3 }, '', pluginFor);
    expect(d.find(x => x.pointer === '/retries')).toMatchObject({ kind: 'number', integer: true });
  });

  it('marks a type:number field NOT integer, so the control accepts decimals', () => {
    const schema = { type: 'object', properties: { rate: { type: 'number', minimum: 0, maximum: 1 } } };
    const d = buildDescriptors(schema, { rate: 0.5 }, '', pluginFor);
    expect(d.find(x => x.pointer === '/rate')).toMatchObject({
      kind: 'number', value: 0.5, integer: false, minimum: 0, maximum: 1
    });
  });

  it('carries multipleOf onto a number when the schema declares one', () => {
    const schema = { type: 'object', properties: { rate: { type: 'number', multipleOf: 0.1 } } };
    const d = buildDescriptors(schema, { rate: 0.3 }, '', pluginFor);
    expect(d.find(x => x.pointer === '/rate')).toMatchObject({ kind: 'number', integer: false, multipleOf: 0.1 });
  });

  it('omits multipleOf when the schema declares none', () => {
    const schema = { type: 'object', properties: { rate: { type: 'number' } } };
    const d = buildDescriptors(schema, { rate: 0.5 }, '', pluginFor);
    expect(Object.prototype.hasOwnProperty.call(d.find(x => x.pointer === '/rate'), 'multipleOf')).toBe(false);
  });

  it('carries minLength and maxLength onto a text field', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 40 } } };
    const d = buildDescriptors(schema, { name: 'datadog' }, '', pluginFor);
    expect(d.find(x => x.pointer === '/name')).toMatchObject({ kind: 'text', minLength: 1, maxLength: 40 });
  });

  it('renders an enum array as a list, not free text', () => {
    const d = buildDescriptors(siemSchema, siemData, '/api_config/observability/siem', pluginFor);
    const cats = d.find(x => x.pointer === '/api_config/observability/siem/categories');
    expect(cats).toMatchObject({ kind: 'list', values: ['security', 'audit'] });
  });

  it('renders the sink array as a section per sink, not one wide table', () => {
    const sinks = sinkSections(siemData);
    expect(sinks.kind).toBe('section');
    expect(sinks.children).toHaveLength(1);
    expect(sinks.children[0]).toMatchObject({ kind: 'section', label: 'datadog', collapsed: true });
  });

  it('shows a sink only the fields its own type declares', () => {
    const sinks = sinkSections(siemData);
    const fields = sinks.children[0].children.map(child => child.pointer.split('/').pop());

    // Common to every sink, plus datadog's own two. `name` is the panel's label, not a field.
    // In the item schema's DECLARED order - the seven common fields it declares first, then
    // datadog's own two - present or absent alike, so the panel never reshuffles as it is filled
    // in (see `documentOrderedKeys`).
    expect(fields).toEqual([
      'type', 'enabled', 'include_content', 'allow_unmasked_content', 'include_credential_material',
      'batch_size', 'interval_ms', 'site', 'api_key_env'
    ]);
    // Nothing from any other sink type.
    ['url', 'token_env', 'endpoint', 'headers_env', 'bucket', 'region', 'prefix',
      'dcr_endpoint', 'tenant_id', 'project_id', 'topic_id'].forEach(foreign => {
      expect(fields).not.toContain(foreign);
    });
  });

  it('leaves an optional field the sink has not set empty, never the text "null"', () => {
    const sparse = { ...siemData, sinks: [{ name: 'datadog', type: 'datadog', site: 'datadoghq.com' }] };
    const sinks = sinkSections(sparse);
    const children = sinks.children[0].children;

    expect(children.find(c => c.pointer.endsWith('/batch_size'))!.kind).toBe('number');
    expect(children.find(c => c.pointer.endsWith('/enabled'))).toMatchObject({ kind: 'switch', value: false });
    expect(children.some(c => c.kind === 'raw')).toBe(false);
    expect(JSON.stringify(sinks)).not.toContain('"json":"null"');
  });

  it('claims a type-specific optional field for its own type only', () => {
    const withS3 = {
      ...siemData,
      sinks: [
        siemData.sinks[0],
        { name: 'archive', type: 's3', bucket: 'b', region: 'r', prefix: 'siem',
          access_key_id_env: 'A_ID', secret_access_key_env: 'A_SECRET' }
      ]
    };
    const sinks = sinkSections(withS3);
    const fieldsOf = (i: number) => sinks.children[i].children.map(c => c.pointer.split('/').pop());

    expect(fieldsOf(1)).toContain('prefix');
    expect(fieldsOf(0)).not.toContain('prefix');
  });

  it('labels a sink by name, falling back to type and then the index', () => {
    const unnamed = {
      ...siemData,
      sinks: [
        { name: 'primary', type: 'webhook', url: 'https://siem.example.invalid/x' },
        { type: 'otel', endpoint: 'https://collector.example.invalid/v1/logs' },
        {}
      ]
    };
    const sinks = sinkSections(unnamed);
    expect(sinks.children.map(child => child.label)).toEqual(['primary', 'otel', '#2']);
  });

  it('surfaces a value belonging to another sink type instead of hiding it', () => {
    const crossed = {
      ...siemData,
      sinks: [{ ...siemData.sinks[0], bucket: 'left-over-from-an-s3-sink' }]
    };
    const sinks = sinkSections(crossed);
    const stray = sinks.children[0].children.find(c => c.pointer.endsWith('/bucket'))!;
    expect(stray.kind).toBe('raw');
    expect((stray as unknown as { reason: string }).reason).toContain('datadog');
  });

  it('still renders an array whose items carry no discrimination as a table', () => {
    // The generic path: an item schema with no `if`/`then` branches has no variants to split on,
    // so every item really does have the same shape and a table is the right control.
    const plainSchema = {
      type: 'object',
      properties: {
        endpoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: { host: { type: 'string' }, port: { type: 'integer' } }
          }
        }
      }
    };
    const plainData = { endpoints: [{ host: 'a.example.invalid', port: 1 }, { host: 'b.example.invalid', port: 2 }] };
    const d = buildDescriptors(plainSchema, plainData, '/root', pluginFor);
    const endpoints = d.find(x => x.pointer === '/root/endpoints') as
      { kind: string; columns: string[]; rows: unknown[][] };
    expect(endpoints.kind).toBe('table');
    expect(endpoints.columns).toEqual(['host', 'port']);
    expect(endpoints.rows).toHaveLength(2);
  });

  // `hooks.definitions`' `equals` is the schema's one union: a `header` rule compares against a
  // string, a `json-path` rule against whatever the body carries (the shipped `payload:maxTokens512`
  // compares against the number 512). Before this, a union `type` matched none of the single-type
  // rendering rules and every `equals` in the document - twelve of them - became a JSON blob.
  it('renders a union type by the member the data actually is, not as raw', () => {
    const unionSchema = {
      type: 'object',
      properties: { equals: { type: ['string', 'number', 'boolean'] } }
    };
    const at = (data: unknown) => buildDescriptors(unionSchema, { equals: data }, '/root', pluginFor)[0];
    expect(at('application/json')).toMatchObject({ kind: 'text', value: 'application/json' });
    expect(at(512)).toMatchObject({ kind: 'number', value: 512 });
    expect(at(true)).toMatchObject({ kind: 'switch', value: true });
  });

  it('renders an unset union as the first member, so an optional one is still a control', () => {
    const unionSchema = {
      type: 'object',
      properties: { equals: { type: ['string', 'number', 'boolean'] } }
    };
    const d = buildDescriptors(unionSchema, {}, '/root', pluginFor);
    expect(d[0]).toMatchObject({ kind: 'text', pointer: '/root/equals' });
  });

  it('still degrades a value no member of the union allows', () => {
    const unionSchema = {
      type: 'object',
      properties: { equals: { type: ['string', 'number', 'boolean'] } }
    };
    const d = buildDescriptors(unionSchema, { equals: { not: 'a scalar' } }, '/root', pluginFor);
    expect(d[0].kind).toBe('raw');
    expect((d[0] as { reason: string }).reason).toContain('string | number | boolean');
  });

  it('degrades an unrepresentable node visibly instead of dropping it', () => {
    const weird = { ...siemData, sinks: 'not-an-array' as unknown as [] };
    const d = buildDescriptors(siemSchema, weird, '/api_config/observability/siem', pluginFor);
    const sinks = d.find(x => x.pointer === '/api_config/observability/siem/sinks');
    expect(sinks!.kind).toBe('raw');
    expect((sinks as { reason: string }).reason).toBeTruthy();
  });

  it('delegates a registered pointer to its plugin', () => {
    registerPlugin('/api_config/observability/siem/sinks/*/api_key_env', 'credential');
    const slot = sinkSections(siemData).children[0].children
      .find(child => child.pointer.endsWith('/api_key_env'));
    expect(slot).toMatchObject({ kind: 'plugin', plugin: 'credential' });
  });

  it('never places a credential value in a descriptor', () => {
    registerPlugin('/api_config/observability/siem/sinks/*/api_key_env', 'credential');
    const d = buildDescriptors(siemSchema, siemData, '/api_config/observability/siem', pluginFor);
    expect(JSON.stringify(d)).not.toContain('SECRET');
  });

  it('round-trips unchanged data byte-identically', () => {
    const d = buildDescriptors(siemSchema, siemData, '/api_config/observability/siem', pluginFor);
    let out: unknown = wrapAt('/api_config/observability/siem', JSON.parse(JSON.stringify(siemData)));
    for (const desc of d) {
      if (desc.kind === 'switch' || desc.kind === 'number' || desc.kind === 'text') {
        out = applyDescriptor(out, desc.pointer, (desc as { value: unknown }).value);
      }
    }
    expect(out).toEqual(wrapAt('/api_config/observability/siem', siemData));
  });

  it('degrades a data key the schema does not define, instead of dropping it', () => {
    const extra = { ...siemData, undeclared_field: 'present in data, absent from schema' };
    const d = buildDescriptors(siemSchema, extra, '/api_config/observability/siem', pluginFor);
    const stray = d.find(x => x.pointer === '/api_config/observability/siem/undeclared_field');
    expect(stray).toBeDefined();
    expect(stray!.kind).toBe('raw');
    expect((stray as { reason: string }).reason).toContain('undeclared_field');
  });

  it('marks the sink array as addable and each sink as a removable element', () => {
    const withTwo = {
      ...siemData,
      sinks: [
        siemData.sinks[0],
        { name: 'second', type: 'datadog', site: 'datadoghq.eu', api_key_env: 'SIEM_SECOND_API_KEY' }
      ]
    };
    const sinks = sinkSections(withTwo);
    // The marker is no longer a bare `true`: it says what KIND of array this is (the sinks pick
    // their fields by a discriminator, which is what the sink dialog serves) and what a new element
    // of it would be. See the container-markers suite at the end of this file for the other half -
    // a hook list, addable in exactly the same sense and discriminated by nothing.
    expect(sinks.arrayItems).toEqual({ discriminated: true, skeleton: { name: '', type: 'webhook' } });
    expect(sinks.children.map(child => child.arrayIndex)).toEqual([0, 1]);
    // The pointer each affordance acts on: the array itself to add, one element to remove.
    expect(sinks.pointer).toBe('/api_config/observability/siem/sinks');
  });

  it('marks the discriminator read-only, so a panel s fields can never disagree with its type', () => {
    const type = sinkSections(siemData).children[0].children.find(c => c.pointer.endsWith('/type'))!;
    expect(type.kind).toBe('select');
    expect(type.readOnly).toBe(true);
  });

  it('leaves every other select editable', () => {
    // Only the field that selects the variant is fixed; nothing else is silently frozen with it.
    const others = sinkSections(siemData).children[0].children
      .filter(c => c.kind === 'select' && !c.pointer.endsWith('/type'));
    others.forEach(child => expect(child.readOnly).toBeUndefined());
  });

  it('labels a credential slot for what it configures, not as an environment variable', () => {
    // The env fallback is gone; `api_key_env` names the slot holding the API key, so the row is
    // labelled "API Key". Derived from the field name, not hard-coded per sink type.
    const labelOf = (data: unknown, field: string) =>
      sinkSections(data).children[0].children.find(c => c.pointer.endsWith('/' + field))!.label;

    expect(labelOf(siemData, 'api_key_env')).toBe('API Key');

    const s3 = { ...siemData, sinks: [{ name: 'archive', type: 's3', bucket: 'b', region: 'r',
      access_key_id_env: 'A_ID', secret_access_key_env: 'A_SECRET' }] };
    expect(labelOf(s3, 'access_key_id_env')).toBe('Access Key ID');
    expect(labelOf(s3, 'secret_access_key_env')).toBe('Secret Access Key');

    const otel = { ...siemData, sinks: [{ name: 'otel', type: 'otel',
      endpoint: 'https://collector.example.invalid/v1/logs', headers_env: 'SIEM_OTEL_HEADERS' }] };
    expect(labelOf(otel, 'headers_env')).toBe('Headers');

    // Nothing anywhere in the form still says "Env".
    const all = buildDescriptors(siemSchema, s3, '/api_config/observability/siem', pluginFor);
    expect(JSON.stringify(all)).not.toMatch(/"label":"[^"]*Env/);
  });

  it('carries the item enum onto a list, so the control can offer it', () => {
    const cats = buildDescriptors(siemSchema, siemData, '/api_config/observability/siem', pluginFor)
      .find(x => x.pointer === '/api_config/observability/siem/categories');
    // Without this the renderer would have to read the schema again from the control layer.
    expect(cats).toMatchObject({ kind: 'list', options: ['security', 'audit', 'usage'] });
  });

  it("drops the required marker from the discriminator, since it cannot be edited", () => {
    // `type` is required for every sink, whatever its variant - but it is also fixed at creation
    // and rendered read-only (see the discriminator test above), so a marker saying "you must
    // supply this" would be redundant on a control with nothing left to supply. `required` is
    // absent, not `false` - a descriptor a caller spreads must not gain a key.
    const type = sinkSections(siemData).children[0].children.find(c => c.pointer.endsWith('/type'))!;
    expect(type.readOnly).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(type, 'required')).toBe(false);
  });

  it("marks a field only the sink's own variant requires, and leaves that variant's optionals alone", () => {
    const requiredOf = (data: unknown, index: number) => {
      const children = sinkSections(data).children[index].children as
        Array<{ pointer: string; required?: boolean }>;
      return children.filter(c => c.required === true).map(c => c.pointer.split('/').pop());
    };

    const webhook = {
      ...siemData,
      sinks: [{ name: 'primary', type: 'webhook', url: 'https://siem.example.invalid/x' }]
    };
    // webhook's `then.required` is ['url']; `token_env` is its optional, and the common
    // `batch_size`/`interval_ms`/`enabled` are nobody's requirement. `type` is required too, but
    // read-only, so its own marker is dropped (see the discriminator test above) and it is absent
    // here.
    expect(requiredOf(webhook, 0).sort()).toEqual(['url']);

    const s3 = {
      ...siemData,
      sinks: [{ name: 'archive', type: 's3', bucket: 'b', region: 'r', prefix: 'siem',
        access_key_id_env: 'A_ID', secret_access_key_env: 'A_SECRET' }]
    };
    // s3 requires four of its five fields; `prefix` is the optional one.
    expect(requiredOf(s3, 0).sort())
      .toEqual(['access_key_id_env', 'bucket', 'region', 'secret_access_key_env']);
  });

  it('marks a field the sink is missing, so the form can say so before the backend does', () => {
    // The reported defect: a webhook added through the form carries no `url` yet. The field must
    // still be rendered, and rendered as required.
    const empty = { ...siemData, sinks: [{ name: 'primary', type: 'webhook' }] };
    const url = sinkSections(empty).children[0].children.find(c => c.pointer.endsWith('/url'))!;
    expect(url.kind).toBe('text');
    expect((url as unknown as { required?: boolean }).required).toBe(true);
  });

  it("does not carry one variant's requirement onto another variant's identically named field", () => {
    const mixed = {
      ...siemData,
      sinks: [
        { name: 'primary', type: 'webhook', url: 'https://siem.example.invalid/x' },
        siemData.sinks[0]
      ]
    };
    const sinks = sinkSections(mixed);
    const requiredNames = (index: number) => (sinks.children[index].children as
      Array<{ pointer: string; required?: boolean }>)
      .filter(c => c.required === true).map(c => c.pointer.split('/').pop());

    expect(requiredNames(0)).toContain('url');
    // The datadog sink has no `url` field at all, and its own requirements are its own. `type` is
    // required but read-only, so it carries no marker (see the discriminator test above).
    expect(requiredNames(1)).not.toContain('url');
    expect(requiredNames(1).sort()).toEqual(['api_key_env', 'site']);
  });

  it('leaves an optional field unmarked rather than marking it false', () => {
    // `required` is absent, not `false`: a descriptor a caller spreads must not gain a key.
    const children = sinkSections(siemData).children[0].children as
      Array<{ pointer: string; required?: boolean }>;
    const optional = children.find(c => c.pointer.endsWith('/batch_size'))!;
    expect(Object.prototype.hasOwnProperty.call(optional, 'required')).toBe(false);
  });

  it('refuses to build descriptors without an explicit plugin resolver', () => {
    expect(() =>
      (buildDescriptors as (...args: unknown[]) => unknown)(siemSchema, siemData, '/api_config/observability/siem')
    ).toThrow('resolvePlugin is required');
  });
});

/**
 * The third and last of draft-07's property-matching steps: a key matched by neither `properties`
 * nor `patternProperties` is declared by a schema-valued `additionalProperties`. Every dynamically
 * keyed map in this document is written that way - `providers`' per-provider entries,
 * `models.overrides`' per-model entries, `hooks.defaults`' per-endpoint entries, and
 * `param_renames`' per-parameter strings - and until this task `buildChildren` read none of them,
 * so each entry degraded to one opaque JSON blob no matter how well its subschema described it.
 */
describe('schemaForm - a key declared only by a schema-valued additionalProperties', () => {
  beforeEach(() => clearPlugins());

  const mapSchema = {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    additionalProperties: {
      type: 'object',
      properties: { retries: { type: 'integer', minimum: 1 }, label: { type: 'string' } }
    }
  };

  it('renders the entry through that subschema instead of degrading it to raw', () => {
    const descriptors = buildDescriptors(
      mapSchema,
      { enabled: true, 'model-a': { retries: 3, label: 'A' } },
      '/root',
      pluginFor
    );

    expect(descriptors.map(d => d.kind)).toEqual(['switch', 'section']);
    const entry = descriptors[1] as unknown as { label: string; children: Array<{ kind: string; pointer: string }> };
    expect(entry.label).toBe('Model-a');
    expect(entry.children).toEqual([
      { kind: 'number', pointer: '/root/model-a/retries', label: 'Retries', value: 3, integer: true, minimum: 1 },
      { kind: 'text', pointer: '/root/model-a/label', label: 'Label', value: 'A' }
    ]);
  });

  it('still degrades to raw when additionalProperties is the boolean true - that declares nothing', () => {
    const open = { type: 'object', properties: { enabled: { type: 'boolean' } }, additionalProperties: true };
    const descriptors = buildDescriptors(open, { enabled: true, 'model-a': { retries: 3 } }, '/root', pluginFor);

    expect(descriptors.map(d => d.kind)).toEqual(['switch', 'raw']);
    expect(descriptors[1]).toMatchObject({ pointer: '/root/model-a', reason: 'No schema defines property "model-a".' });
  });
});

/**
 * `providers.openai` and `providers.openrouter` declare no `type` and no `properties` of their own:
 * each is a bare `allOf` of `$defs/providerCommon` and its own extension. Read literally that is a
 * node of unknown shape, and the whole provider rendered as one `raw` JSON blob.
 */
describe('schemaForm - an object schema composed through allOf', () => {
  beforeEach(() => clearPlugins());

  const composed = {
    $defs: {
      base: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, retries: { type: 'integer' } }
      }
    },
    allOf: [
      { $ref: '#/$defs/base' },
      { type: 'object', properties: { extension: { type: 'boolean' } } }
    ]
  };

  it('renders the fields both branches contribute, in branch order', () => {
    const descriptors = buildDescriptors(composed, { name: 'x', retries: 2, extension: true }, '/root', pluginFor);

    expect(descriptors.map(d => d.pointer)).toEqual(['/root/name', '/root/retries', '/root/extension']);
    expect(descriptors.map(d => d.kind)).toEqual(['text', 'number', 'switch']);
  });

  it('carries a composed branch\'s own `required` onto the field it names', () => {
    const descriptors = buildDescriptors(composed, { name: 'x' }, '/root', pluginFor) as
      Array<{ pointer: string; required?: boolean }>;

    expect(descriptors.find(d => d.pointer === '/root/name')!.required).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(descriptors.find(d => d.pointer === '/root/retries')!, 'required')).toBe(false);
  });
});

/**
 * The same rule on the real schema and the real shipped document, not a synthetic one: every entry
 * of `models.overrides` is declared only by that section's schema-valued `additionalProperties`, so
 * before this task all 24 of them rendered as 24 opaque JSON blobs. This asserts the shape - a
 * section per model, with fields inside - rather than the fields themselves, which are
 * `$defs/modelOverride`'s own depth to grow later.
 */
describe('schemaForm - every models.overrides entry renders as a section, on the real schema', () => {
  beforeEach(() => clearPlugins());

  it('gives each per-model key its own typed section, not one raw blob per model', () => {
    const shipped = require('../../../../gateway/api_config.json').api_config;
    const section = groupSections(apiConfigSchema, 'models').find(s => s.key === 'overrides')!;
    const descriptors = buildDescriptors(section.schema as object, shipped.models.overrides, section.pointer, pluginFor);

    expect(descriptors.length).toBe(Object.keys(shipped.models.overrides).length);
    expect(descriptors.length).toBeGreaterThan(0);
    expect(descriptors.filter(d => d.kind !== 'section')).toEqual([]);
    for (const descriptor of descriptors) {
      expect((descriptor as { children: unknown[] }).children.length).toBeGreaterThan(0);
    }
  });
});

/**
 * `capabilities.file_search.hybrid.rerank.enabled` is the only tri-state in this document, and the
 * only enum whose members are not all strings: `false` never reranks, `"auto"` is best-effort, and
 * `true` demands the reranker and fails loudly without it (reranker.ts). A `Select`'s key is a
 * string, so the descriptor has to carry the members themselves as well as their keys - otherwise
 * the control hands back the TEXT "true" and the saved document reads as neither `true` nor
 * `false` at `enabled === true` / `enabled === false`.
 *
 * `optionValues` is added for exactly that enum and left OFF everywhere else, the same rule
 * `description` and the required marker follow: an all-string enum must keep the descriptor it
 * already had, so nothing downstream sees a key it did not see before.
 */
describe('schemaForm - a select over an enum with non-string members', () => {
  beforeEach(() => clearPlugins());

  const triState = {
    type: 'object',
    properties: {
      enabled: { type: ['boolean', 'string'], enum: [true, false, 'auto'], default: 'auto' }
    }
  };

  it('keys the options as text but carries the members themselves beside them', () => {
    const d = buildDescriptors(triState, { enabled: 'auto' }, '', pluginFor);
    expect(d[0]).toMatchObject({
      kind: 'select',
      value: 'auto',
      options: ['true', 'false', 'auto'],
      optionValues: [true, false, 'auto']
    });
  });

  // No cast: the descriptor's `value` is typed wide enough to hold the member it read, so this
  // guarantee is the compiler's rather than a test's assertion about it.
  it('keeps a boolean member a boolean, so the round trip writes back what it read', () => {
    const descriptor = buildDescriptors(triState, { enabled: false }, '', pluginFor)[0];
    if (descriptor.kind !== 'select') {
      throw new Error(`expected a select, got ${descriptor.kind}`);
    }
    expect(descriptor.value).toBe(false);
    expect(applyDescriptor({ enabled: false }, '/enabled', descriptor.value)).toEqual({ enabled: false });
  });

  it('falls back to the schema default when the document never set it', () => {
    const d = buildDescriptors(triState, {}, '', pluginFor);
    expect(d[0]).toMatchObject({ kind: 'select', value: 'auto' });
  });

  // The fallback screens on MEMBERSHIP, not on string-ness. A `default: false` rejected for not
  // being a string would fall through to '', which keys no item - an empty Select on a field whose
  // schema declares a default. No node in this document is shaped that way yet; this keeps the rule
  // true for the first one that is.
  it('falls back to a non-string default too, rather than to an empty key', () => {
    const booleanDefault = {
      type: 'object',
      properties: {
        enabled: { type: ['boolean', 'string'], enum: [true, false, 'auto'], default: false }
      }
    };
    expect(buildDescriptors(booleanDefault, {}, '', pluginFor)[0])
      .toMatchObject({ kind: 'select', value: false, options: ['true', 'false', 'auto'] });
  });

  // ... and a default the enum does not contain is not one: '' is the honest rendering of "this
  // field has no usable default", the behaviour every select had before non-string members existed.
  it('ignores a default that is not a member of the enum', () => {
    const strayDefault = {
      type: 'object',
      properties: { enabled: { type: 'string', enum: ['auto', 'never'], default: 'sometimes' } }
    };
    expect(buildDescriptors(strayDefault, {}, '', pluginFor)[0]).toMatchObject({ kind: 'select', value: '' });
  });

  it('adds no optionValues key at all to an ordinary all-string enum', () => {
    const strings = {
      type: 'object',
      properties: { method: { type: 'string', enum: ['pseudonymization', 'anonymization'] } }
    };
    const d = buildDescriptors(strings, { method: 'anonymization' }, '', pluginFor);
    expect(d[0]).toMatchObject({ kind: 'select', options: ['pseudonymization', 'anonymization'] });
    expect(Object.prototype.hasOwnProperty.call(d[0], 'optionValues')).toBe(false);
  });
});

/**
 * The container markers, on the real schema and the real shipped document.
 *
 * All three exist so the form's affordances can be read off the SCHEMA rather than off a list of
 * pointers kept by hand (`configMaps.ts`'s two entries, `ConfigForm.ts`'s `SINKS_POINTER`): a map
 * the schema declares must be addable without anyone having remembered to name it here, and a
 * section the document does not carry must stop pretending its defaults are settings.
 */
describe('schemaForm - schema-derived container markers', () => {
  beforeEach(() => clearPlugins());

  const shipped = require('../../../../gateway/api_config.json').api_config;

  /** One section, exactly as `ConfigFormTabs.buildTab` resolves it. */
  const sectionOf = (group: 'capabilities' | 'hooks' | 'models' | 'observability' | 'platform' | 'providers', key: string) => {
    const section = groupSections(apiConfigSchema, group).find(s => s.key === key);
    if (!section) {
      throw new Error(`schema has no ${group}.${key} section`);
    }
    return section;
  };

  /** Every descriptor of a section's tree, depth-first. */
  const flatten = (descriptors: any[]): any[] =>
    descriptors.reduce<any[]>((all, d) => all.concat([d], d.kind === 'section' ? flatten(d.children) : []), []);

  const treeOf = (group: any, key: string, data: unknown) => {
    const section = sectionOf(group, key);
    return flatten(buildDescriptors(section.schema as object, data, section.pointer, pluginFor));
  };

  // A scalar-valued map: one control per key, so the [+] needs a value to write as well as a key.
  // INFO, not TRACE, is the seed, and that is the schema's doing rather than a choice made here:
  // the enum's first member is TRACE, and `"default": "INFO"` on that value is what overrules it.
  // See `scalarSeed`, and `documentGate.test.ts` for the proof that the annotation changes no
  // validation verdict.
  it('seeds a new platform.logging.components override at INFO, the level the schema defaults to', () => {
    const components = treeOf('platform', 'logging', shipped.platform.logging)
      .find(d => d.pointer === '/api_config/platform/logging/components');

    expect(components.mapEntries).toEqual({
      valueKind: 'scalar',
      keyPattern: '^[a-zA-Z0-9_-]+$',
      scalarDefault: 'INFO',
      // The node's own `x-keySuggestions`, carried through verbatim: a non-restrictive list the Add
      // dialog seeds its ComboBox with, in the schema's order and its exact casing (`openaiController`
      // is lowercase-o on purpose - the gateway's component-key lookup is a case-sensitive match).
      // The keys stay OPEN: this is a suggestion list, not the closed `keyChoices` enumeration.
      keySuggestions: [
        'AnthropicService',
        'AwsBedrockService',
        'ConfigService',
        'ModelService',
        'openaiController',
        'OpenRouterController',
        'OpenRouterService',
        'RateLimitManager',
        'SAPAIService',
        'UsageTrackingService'
      ]
    });
    // Not merely "not TRACE": the first enum member is what would win without the annotation, so
    // this is the assertion that goes red if the annotation is dropped from either schema copy.
    expect((apiConfigSchema as any).$defs.platformGroup.properties.logging.properties.components
      .patternProperties['^[a-zA-Z0-9_-]+$'].enum[0]).toBe('TRACE');
  });

  // The suggestion list is a copy of the schema's array, not a reference into it: mutating the
  // marker must never reach back and rewrite the schema every other reader shares. And it is read
  // from the map CONTAINER's own node, defensively - a malformed `x-keySuggestions` is ignored
  // rather than trusted, so the marker never carries a non-string suggestion into the ComboBox.
  it('copies x-keySuggestions defensively, and ignores a malformed one', () => {
    const componentsNode = (apiConfigSchema as any).$defs.platformGroup.properties.logging.properties.components;
    const marker = mapEntriesOf(componentsNode, apiConfigSchema as any)!;
    expect(marker.keySuggestions).not.toBe(componentsNode['x-keySuggestions']);
    expect(marker.keySuggestions).toEqual(componentsNode['x-keySuggestions']);

    // A non-array, an empty array, and an array with a non-string member all yield no suggestions.
    const seedOf = (suggestions: unknown) => mapEntriesOf(
      { type: 'object', 'x-keySuggestions': suggestions, patternProperties: { '^[a-z]+$': { type: 'string' } } } as any,
      apiConfigSchema as any
    )!.keySuggestions;
    expect(seedOf('AnthropicService')).toBeUndefined();
    expect(seedOf([])).toBeUndefined();
    expect(seedOf(['ok', 3])).toBeUndefined();
    expect(seedOf(['ok', 'fine'])).toEqual(['ok', 'fine']);
  });

  // A number-valued map with no `default` seeds its `minimum` rather than a flat 0. The two are the
  // same value for every such map this schema declares today that has no `default` - every one of
  // them is `minimum: 0` - so the rule is stated against a synthetic schema as well, where the two
  // differ.
  it('seeds a number-valued map at the value schema\'s minimum when it declares no default', () => {
    const modelDelays = mapEntriesOf(
      (apiConfigSchema as any).$defs.platformGroup.properties.rate_limit_handling
        .properties.model_specific_delays,
      apiConfigSchema as any
    );
    expect(modelDelays!.valueKind).toBe('scalar');
    expect(modelDelays!.scalarDefault).toBe(0);

    // Where 0 is not an allowed value at all, seeding 0 would seed something the schema rejects.
    const ratio = mapEntriesOf(
      { type: 'object', patternProperties: { '^[a-z]+$': { type: 'number', minimum: 1, maximum: 4 } } } as any,
      apiConfigSchema as any
    );
    expect(ratio!.scalarDefault).toBe(1);

    // No minimum and no default is still 0 - there is nothing better to say.
    const unbounded = mapEntriesOf(
      { type: 'object', patternProperties: { '^[a-z]+$': { type: 'number' } } } as any,
      apiConfigSchema as any
    );
    expect(unbounded!.scalarDefault).toBe(0);

    // And a `default` outranks both.
    const defaulted = mapEntriesOf(
      { type: 'object', patternProperties: { '^[a-z]+$': { type: 'number', minimum: 1, default: 3 } } } as any,
      apiConfigSchema as any
    );
    expect(defaulted!.scalarDefault).toBe(3);
  });

  // pseudonymization.thresholds carries its own `default` on the value schema, so a new entry seeds
  // at 0.5 rather than at its `minimum` of 0 - masking a category only above half-confidence, not
  // always. See `ConfigFormMaps`'s add-dialog hint, which quotes this same `scalarDefault`.
  it('seeds a new pseudonymization.thresholds entry at 0.5, not at its minimum of 0', () => {
    const thresholds = mapEntriesOf(
      (apiConfigSchema as any).$defs.pseudonymizationConfig.properties.thresholds,
      apiConfigSchema as any
    );
    expect(thresholds!.valueKind).toBe('scalar');
    expect(thresholds!.scalarDefault).toBe(0.5);
  });

  // The two shapes hooks.defaults nests, in one pass: the section itself is a map of endpoints,
  // each endpoint is a map of subpaths, and each subpath is an appendable array of hooks.
  it('marks hooks.defaults as an object-valued map, its endpoints as array-valued maps, and its hook lists as appendable', () => {
    // The section's own marker: `buildDescriptors` on an object section returns that section's
    // CHILDREN, so the tab shell reads the section's own marker through `mapEntriesOf` - the same
    // computation, asked of the same schema.
    expect(mapEntriesOf(sectionOf('hooks', 'defaults').schema, apiConfigSchema as any))
      // `valueSkeleton` is what a [+] writes for a new endpoint key: an endpoint's schema requires
      // nothing, so it is the empty object - derived, not assumed. See `hooks.definitions` below
      // for the map where the same derivation is not empty.
      .toEqual({ valueKind: 'object', valueSkeleton: {} });

    const tree = treeOf('hooks', 'defaults', shipped.hooks.defaults);
    expect(tree.find(d => d.pointer === '/api_config/hooks/defaults/anthropic').mapEntries).toEqual({
      valueKind: 'array',
      keyPattern: '^(?!pseudonymization$)[a-zA-Z0-9_/-]+$'
    });
    expect(tree.find(d => d.pointer === '/api_config/hooks/defaults/anthropic/invoke').arrayItems).toEqual({
      discriminated: false,
      // The smallest hook `$defs/hookEntryArray` requires - and nothing optional beside it. It is
      // deliberately not yet valid: `match` needs one rule and `callback.id` a plugin name, which
      // is what the operator supplies. Inventing either would be inventing a setting.
      skeleton: { request: { callback: { id: '' }, match: [] } }
    });
  });

  // The sink array keeps its discriminated marker, so the sink dialog stays the case it serves
  // rather than becoming the only case an array can be added to.
  it('keeps observability.siem.sinks discriminated', () => {
    const sinks = treeOf('observability', 'siem', shipped.observability.siem)
      .find(d => d.pointer === '/api_config/observability/siem/sinks');

    expect(sinks.arrayItems.discriminated).toBe(true);
  });

  // The two maps `configMaps.ts` names by hand today. Marked from the schema here, so the folding
  // of that registry is a deletion rather than a rewrite.
  it('marks the two registry maps from the schema, so the registry has nothing left to say', () => {
    expect(mapEntriesOf(sectionOf('models', 'overrides').schema, apiConfigSchema as any))
      .toEqual({ valueKind: 'object', valueSkeleton: {} });
    // `providers` is a whole group rather than a section, so the tab shell reaches it through
    // `resolveGroupSchema` - the exact call `ConfigFormTabs.buildTab` makes - rather than through
    // `groupSections`. That is the caller whose schema is NOT `$ref`-free (see below).
    expect(mapEntriesOf(resolveGroupSchema(apiConfigSchema, 'providers'), apiConfigSchema as any))
      .toEqual({ valueKind: 'object', valueSkeleton: {} });
  });

  // The map whose entries the empty object does NOT serve. A rule definition requires a `type`, and
  // the four `if` branches below it all match vacuously while `type` is absent - so an entry added
  // as `{}` arrives with five errors instead of the one the operator can act on.
  it('seeds a new hooks.definitions rule with the type its schema requires, not with {}', () => {
    expect(mapEntriesOf(sectionOf('hooks', 'definitions').schema, apiConfigSchema as any)).toEqual({
      valueKind: 'object',
      keyPattern: '^[a-zA-Z0-9_:=-]+$',
      valueSkeleton: { type: 'header' }
    });
  });

  // The latent trap that made `rootSchema` a required argument. `resolveGroupSchema` resolves the
  // GROUP's own `$ref` and nothing below it, so `providersGroup.additionalProperties` is still
  // `{ $ref: '#/$defs/providerCommon' }`. Rooted at itself that ref resolves to nothing and the
  // value schema reads as typeless - which, unguarded, answered "a map of SCALARS seeded with ''",
  // i.e. a [+] that would create a provider as the empty string. It has to refuse, not guess.
  it('refuses a root the map\'s value $ref does not resolve against, rather than reading it as a scalar', () => {
    const providersGroup = resolveGroupSchema(apiConfigSchema, 'providers');

    expect(() => mapEntriesOf(providersGroup, providersGroup))
      .toThrow(/does not resolve against the rootSchema given/);
    // Named, so the failure says which ref could not be found rather than only that one could not.
    expect(() => mapEntriesOf(providersGroup, providersGroup)).toThrow(/#\/\$defs\/providerCommon/);
  });

  // Enumerated by a walk, not listed: a map added to the schema later is addable without an edit
  // here. The eight the design names are asserted by name; the rest are the maps reachable inside
  // a map's own entries, which the walk finds for free.
  it('enumerates every map node of the schema, the eight the design names among them', () => {
    const nodes = mapNodesOf(apiConfigSchema);

    expect(nodes.length).toBeGreaterThanOrEqual(8);
    for (const pointer of [
      '/api_config/providers',
      '/api_config/models/overrides',
      '/api_config/hooks/definitions',
      '/api_config/hooks/defaults',
      '/api_config/platform/logging/components',
      '/api_config/platform/rate_limit_handling/model_specific_delays',
      '/api_config/platform/rate_limit_handling/subpath_specific_delays',
      '/api_config/observability/pseudonymization/entities'
    ]) {
      expect(nodes).toContain(pointer);
    }
    // ... and the per-endpoint subpath maps of hooks.defaults, which have no fixed pointer: `*` is
    // one dynamic key, the same wildcard formPlugins uses for the sink credential slots.
    expect(nodes).toContain('/api_config/hooks/defaults/*');
    // A node that merely accepts unknown keys without describing them is NOT a map: `$defs/
    // modelOverride` is `additionalProperties: true`, which declares nothing to build an entry from.
    expect(nodes).not.toContain('/api_config/models/overrides/*');
  });

  // The reason absent sections stop rendering at all: every one of these fields would otherwise
  // show a value the operator never chose, on a section the document does not carry.
  it('renders an absent section as one marker with no fields at their defaults', () => {
    const section = sectionOf('platform', 'rate_limit_handling');
    const descriptors = buildDescriptors(section.schema as object, undefined, section.pointer, pluginFor);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      kind: 'section',
      pointer: '/api_config/platform/rate_limit_handling',
      absent: true,
      children: []
    });
    expect(flatten(descriptors).filter(d => 'value' in d)).toEqual([]);
  });

  // ... and the line that ruling stops at. A sub-block of a section the operator HAS configured is
  // a field of that section, not a section of its own, and keeps the behaviour it has always had.
  it('still renders a nested optional object inside a PRESENT section at its defaults', () => {
    const fileSearch = JSON.parse(JSON.stringify(shipped.capabilities.file_search));
    delete fileSearch.hybrid.rerank;

    const tree = treeOf('capabilities', 'file_search', fileSearch);
    const rerank = tree.find(d => d.pointer === '/api_config/capabilities/file_search/hybrid/rerank');

    expect(rerank.absent).toBeUndefined();
    expect(rerank.children.length).toBeGreaterThan(0);
    expect(tree.find(d => d.pointer.endsWith('/hybrid/rerank/enabled'))).toMatchObject({ kind: 'select' });
  });

  // A map container absent from a section that IS present is still a container, not a field: the
  // depth rule alone would have rendered it as an empty section, saying nothing.
  it('marks an absent map container absent wherever it sits, not only at section depth', () => {
    const logging = treeOf('platform', 'logging', { defaultLevel: 'DEBUG' })
      .find(d => d.pointer === '/api_config/platform/logging/components');

    expect(logging).toMatchObject({ absent: true, children: [] });
    expect(logging.mapEntries.valueKind).toBe('scalar');
  });
});

/**
 * The ruling this task carries out, at the level of one object's fields: a section's DECLARED
 * fields render in the schema's declaration order, always, present or absent alike, so the panel
 * never reshuffles as it is filled in. A key nothing declares - a map's own DYNAMIC entry - has no
 * schema order of its own, so it trails the declared fields in the document's (creation) order.
 *
 * This replaced a document-order-first rule (present keys first, then absent ones) that made a
 * partially-filled section rearrange itself as keys were added - the rate_limit_handling report,
 * where two added maps pushed the unset scalars below both and they read as "vanished". See
 * `documentOrderedKeys`'s own comment for the full account.
 *
 * `apiConfigGroups.test.ts` holds the same rule for a GROUP's sections, through the same
 * `documentOrderedKeys` - the two halves of the form cannot drift apart.
 */
describe('the order the form shows an object\'s keys in', () => {
  beforeEach(() => clearPlugins());

  const three = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } }
  } as any;

  /** The pointer's last segment of every descriptor, in the order the form would draw them. */
  const keysOf = (schema: any, data: unknown, pointer = '/api_config/platform/security'): string[] =>
    buildDescriptors(schema, data, pointer, pluginFor).map(d => d.pointer.split('/').pop() as string);

  it('walks the SCHEMA\'s declared order, not the document\'s', () => {
    // However the document orders (or reverses) the declared keys, the form shows the schema's
    // order - so a section cannot reshuffle when the document does.
    expect(keysOf(three, { b: 'x', a: 'y' })).toEqual(['a', 'b', 'c']);
    expect(keysOf(three, { c: 'x', b: 'y', a: 'z' })).toEqual(['a', 'b', 'c']);
  });

  it('shows a declared key in its schema position whether the document carries it or not', () => {
    // Present-first no longer applies: a single carried key does not lead the rest.
    expect(keysOf(three, { c: 'x' })).toEqual(['a', 'b', 'c']);
    // Nothing carried at all is the same order - the schema's - as everything carried.
    expect(keysOf(three, {})).toEqual(['a', 'b', 'c']);
  });

  it('trails a key nothing declares after the declared keys, in the document\'s order', () => {
    // It renders as `raw` (see `buildChildren`'s own note); it is a DYNAMIC key with no schema
    // position, so it follows the declared keys (schema order) in the document's own order.
    const keys = keysOf(three, { b: 'x', stray: 1, a: 'y' });
    expect(keys).toEqual(['a', 'b', 'c', 'stray']);
  });

  it('renders a mixed node declared-first (schema order), then its dynamic keys in document order', () => {
    // The one node in this schema that has both: `hooks.defaults.<endpoint>` declares
    // `pseudonymization` as a property beside its pattern-matched subpath keys (`invoke`,
    // `responses`). The declared `pseudonymization` leads whatever order the document lists the
    // dynamic subpaths in; the dynamic keys keep their creation order after it.
    const defaults = groupSections(apiConfigSchema, 'hooks').find(s => s.key === 'defaults')!;
    const endpoint = { invoke: [], pseudonymization: {}, responses: [] };
    const anthropic = buildDescriptors(
      defaults.schema as object,
      { anthropic: endpoint },
      '/api_config/hooks/defaults',
      pluginFor
    ).find(d => d.pointer === '/api_config/hooks/defaults/anthropic') as any;
    expect(anthropic.children.map((child: any) => child.pointer.split('/').pop()))
      .toEqual(['pseudonymization', 'invoke', 'responses']);
  });

  it('keeps rate_limit_handling\'s unset scalars in schema position when only its maps are present', () => {
    // The owner's exact report: the two delay maps are present (empty), the four scalars unset.
    // Under the old document-order-first rule the present maps led and the unset scalars fell
    // below both panels - they read as "vanished". The section's DECLARED order must hold: the
    // four scalars first, both maps after them, present or absent alike.
    const section = groupSections(apiConfigSchema, 'platform').find(s => s.key === 'rate_limit_handling')!;
    const onlyMaps = keysOf(
      section.schema as any,
      { model_specific_delays: {}, subpath_specific_delays: {} },
      section.pointer
    );
    expect(onlyMaps).toEqual([
      'enabled', 'default_delay_seconds', 'backoff_multiplier', 'max_delay_seconds',
      'model_specific_delays', 'subpath_specific_delays'
    ]);
    // And the order does not move as the maps are added one at a time, nor when nothing is set.
    expect(keysOf(section.schema as any, { model_specific_delays: {} }, section.pointer)).toEqual(onlyMaps);
    expect(keysOf(section.schema as any, {}, section.pointer)).toEqual(onlyMaps);
  });

  it('lists a map node\'s own entries in document (creation) order', () => {
    // A declared map renders in schema position (above), but its DYNAMIC entries have no schema
    // order and keep the order they were created in - unchanged by this task.
    const section = groupSections(apiConfigSchema, 'platform').find(s => s.key === 'rate_limit_handling')!;
    const map = buildDescriptors(
      section.schema as any,
      { model_specific_delays: { 'z-model': 2, 'a-model': 1 } },
      section.pointer,
      pluginFor
    ).find(d => d.pointer.endsWith('/model_specific_delays')) as any;
    expect(map.children.map((child: any) => child.pointer.split('/').pop())).toEqual(['z-model', 'a-model']);
  });

  it('documentOrderedKeys returns the declared keys in schema order, whatever order the data lists them', () => {
    const declared = ['a', 'b', 'c'];
    expect(documentOrderedKeys(declared, { c: 1, a: 2 })).toEqual(['a', 'b', 'c']);
    expect(documentOrderedKeys(declared, { b: 1 })).toEqual(['a', 'b', 'c']);
    expect(documentOrderedKeys(declared, {})).toEqual(['a', 'b', 'c']);
    expect(documentOrderedKeys(declared, undefined)).toEqual(['a', 'b', 'c']);
  });

  it('renders the shipped siem section in the shipped JSON\'s own order', () => {
    const shipped = require('../../../../gateway/api_config.json').api_config.observability.siem;
    const siem = groupSections(apiConfigSchema, 'observability').find(s => s.key === 'siem')!;
    const keys = keysOf(siem.schema as any, shipped, siem.pointer);
    expect(keys.slice(0, Object.keys(shipped).length)).toEqual(Object.keys(shipped));
  });

  // The guarantee the round-trip harness rests on: `applyDescriptor` writes by POINTER, so the
  // order descriptors come out in cannot reach the saved document. Reordering them - here, the
  // most hostile reordering there is - has to write the same bytes.
  it('changes nothing about what a round trip writes back - applyDescriptor addresses by pointer', () => {
    const descriptors = buildDescriptors(siemSchema, siemData, '/api_config/observability/siem', pluginFor);
    const write = (list: any[]): unknown => list.reduce<unknown>(
      (document, descriptor) => descriptor.kind === 'switch' || descriptor.kind === 'number' || descriptor.kind === 'text'
        ? applyDescriptor(document, descriptor.pointer, descriptor.value)
        : document,
      wrapAt('/api_config/observability/siem', JSON.parse(JSON.stringify(siemData)))
    );
    expect(JSON.stringify(write(descriptors.slice().reverse()))).toBe(JSON.stringify(write(descriptors)));
    expect(write(descriptors)).toEqual(wrapAt('/api_config/observability/siem', siemData));
  });
});
