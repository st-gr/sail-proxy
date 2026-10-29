/**
 * The Connections app for an SAP AI Core connection (connections-app annotations.cds and manifest):
 * which fields, sections and header actions show for which provider type. The UI.Hidden expressions
 * and the manifest's visible bindings are evaluated here for a row of each type, active and in the draft.
 */
import path from 'path';
import manifest from '../../../app/connections-app/webapp/manifest.json';
import { parseServiceKey, tenantFromServiceKey } from '@libs/service-key-parser/parser';
const cds = require('@sap/cds');

const ANNOTATIONS = path.resolve(__dirname, '../../../app/connections-app/annotations.cds');
const TYPES = ['azure-openai', 'bedrock', 'openai', 'anthropic', 'sap-ai-core'];

type Row = Record<string, unknown>;

/** Evaluates an $edmJson expression (the subset the annotations use) against a row. */
function evaluate(e: any, row: Row): unknown {
  if (e === null || typeof e !== 'object') return e;
  if ('$Path' in e) return row[e.$Path];
  if ('$Eq' in e) return evaluate(e.$Eq[0], row) === evaluate(e.$Eq[1], row);
  if ('$Ne' in e) return evaluate(e.$Ne[0], row) !== evaluate(e.$Ne[1], row);
  if ('$And' in e) return e.$And.every((x: any) => !!evaluate(x, row));
  if ('$Or' in e) return e.$Or.some((x: any) => !!evaluate(x, row));
  if ('$Not' in e) return !evaluate(e.$Not, row);
  if ('$If' in e) return evaluate(e.$If[0], row) ? evaluate(e.$If[1], row) : evaluate(e.$If[2], row);
  throw new Error(`unsupported expression ${JSON.stringify(e)}`);
}

/** cds flattens `@UI.Hidden: { $edmJson: { $Op: … } }` to `@UI.Hidden.$edmJson.$Op`: the expression back, or the plain value. */
function annotation(target: any, name: string): any {
  if (name in target) return target[name];
  const prefix = `${name}.$edmJson.`;
  const key = Object.keys(target).find((k) => k.startsWith(prefix));
  return key ? { [key.slice(prefix.length)]: target[key] } : undefined;
}
const hidden = (target: any, row: Row): boolean => !!evaluate(annotation(target, '@UI.Hidden')?.$edmJson ?? annotation(target, '@UI.Hidden'), row);

/** Evaluates a manifest expression binding ("{= … }") against a row: ${path: 'x', targetType: 'any'} and ${x} read the raw value. */
function binding(expression: string, row: Row): boolean {
  const body = expression.replace(/^\{=\s*/, '').replace(/\s*\}$/, '')
    .replace(/\$\{path: '([A-Za-z]+)', targetType: 'any'\}/g, (_, p) => JSON.stringify(row[p] ?? null))
    .replace(/\$\{([A-Za-z]+)\}/g, (_, p) => JSON.stringify(row[p] ?? null));
  return new Function(`return (${body});`)() as boolean;
}

const row = (providerType: string, extra: Row = {}): Row => ({ providerType, IsActiveEntity: true, isActive: providerType !== 'sap-ai-core', authMode: null, apiMode: null, ...extra });

describe('connections-app for SAP AI Core', () => {
  let csn: any;
  let entity: any;
  beforeAll(async () => {
    csn = await cds.load(ANNOTATIONS);
    entity = csn.definitions['AdminService.ProviderConnections'];
  });

  it('shows the key-derived fields on the saved connection and the tenant settings for this type only', () => {
    const shown = (type: string, extra: Row = {}) => ['endpoint', 'region', 'clientId', 'tenantId', 'resourceGroup', 'productive', 'priceRegion', 'baseUrl', 'authMode', 'apiMode', 'accessKeyId']
      .filter((f) => !hidden(entity.elements[f], row(type, extra)));
    // The client id stays off the page (spec §4): the credential hint shows it masked
    expect(shown('sap-ai-core')).toEqual(['endpoint', 'region', 'tenantId', 'resourceGroup', 'productive', 'priceRegion']);
    // In the draft (create or edit) the fields the service key sets are not offered: only the settings are
    expect(shown('sap-ai-core', { IsActiveEntity: false })).toEqual(['resourceGroup', 'productive', 'priceRegion']);
    // The other types keep their fields and never see the SAP settings
    expect(shown('azure-openai', { authMode: 'entra-client-secret', apiMode: 'v1' })).toEqual(['endpoint', 'clientId', 'tenantId', 'authMode', 'apiMode']);
    expect(shown('azure-openai', { authMode: 'entra-client-secret', IsActiveEntity: false })).toEqual(['endpoint', 'clientId', 'tenantId', 'authMode', 'apiMode']);
    expect(shown('bedrock', { authMode: 'access-key' })).toEqual(['region', 'authMode', 'accessKeyId']);
    expect(shown('openai')).toEqual(['baseUrl']);
    expect(shown('anthropic')).toEqual(['baseUrl']);
  });

  it('lays the SAP settings out in the Endpoint section', () => {
    const fields = entity['@UI.FieldGroup#Endpoint.Data'].map((d: any) => d.Value['=']);
    for (const f of ['resourceGroup', 'productive', 'priceRegion']) expect([f, fields.includes(f)]).toEqual([f, true]);
    for (const f of ['resourceGroup', 'productive', 'priceRegion']) expect([f, typeof entity.elements[f]['@Common.Label']]).toEqual([f, 'string']);
  });

  it('explains Productive (a checkbox; the draft starts non-productive) and marks no checkbox as required', () => {
    const p = entity.elements.productive;
    expect(p['@Common.QuickInfo']).toBe('{i18n>connections.productiveInfo}');
    expect(annotation(p, '@Common.FieldControl')).toBeUndefined();
  });

  it('hides Clear Credential while the SAP AI Core connection is the active one (the server refuses it then)', () => {
    const clear = entity['@UI.Identification'].find((d: any) => d.Action === 'AdminService.clearCredential');
    expect(hidden(clear, row('sap-ai-core', { isActive: true }))).toBe(true);
    expect(hidden(clear, row('sap-ai-core', { isActive: false }))).toBe(false);
    for (const type of TYPES.filter((t) => t !== 'sap-ai-core')) expect([type, hidden(clear, row(type, { isActive: true }))]).toEqual([type, false]);
  });

  it('hides the Models section for SAP AI Core', () => {
    const facets: any[] = entity['@UI.Facets'];
    const models = facets.find((f) => f.ID === 'models');
    for (const type of TYPES) expect([type, hidden(models, row(type))]).toEqual([type, type === 'sap-ai-core']);
    for (const f of facets.filter((x) => x.ID !== 'models')) expect([f.ID, hidden(f, row('sap-ai-core'))]).toEqual([f.ID, false]);
  });

  it('keeps Active off the draft of an SAP AI Core connection (activate and deactivate set it)', () => {
    const active = entity['@UI.FieldGroup#General.Data'].find((d: any) => d.Value['='] === 'isActive');
    expect(hidden(active, row('sap-ai-core', { IsActiveEntity: false }))).toBe(true);
    expect(hidden(active, row('sap-ai-core'))).toBe(false);
    for (const type of TYPES.filter((t) => t !== 'sap-ai-core')) expect([type, hidden(active, row(type, { IsActiveEntity: false }))]).toEqual([type, false]);
  });

  it('offers activate and deactivate on saved SAP AI Core connections only', () => {
    const actions = entity.actions;
    for (const name of ['activate', 'deactivate']) {
      const available = annotation(actions[name], '@Core.OperationAvailable');
      for (const type of TYPES) {
        const r = { 'in/IsActiveEntity': true, 'in/providerType': type };
        expect([name, type, evaluate(available.$edmJson ?? available, r)]).toEqual([name, type, type === 'sap-ai-core']);
      }
      expect(evaluate(available.$edmJson ?? available, { 'in/IsActiveEntity': false, 'in/providerType': 'sap-ai-core' })).toBe(false);
    }
  });

  // seed.js stores this key with setCredential: it must parse, and the journey expects the region the parser takes from it.
  it('the journey fixture service key parses, under invented .invalid hosts', () => {
    const { sapConnection } = require('../../../../../ci/scripts/ui-journeys/fixtures');
    const text = JSON.stringify(sapConnection.serviceKey);
    const parsed = parseServiceKey(text);
    expect(parsed.SAP_AI_REGION).toBe(sapConnection.region);
    expect(tenantFromServiceKey(text).zone).toBe('uifixture-zone.example');
    for (const url of [parsed.SAP_AI_CORE_URL, parsed.AUTH_URL]) expect(new URL(url).hostname.endsWith('.invalid')).toBe(true);
    expect(sapConnection.productive).toBe(false);
  });

  describe('header actions', () => {
    const actions = () => (manifest as any)['sap.ui5'].routing.targets.ConnectionsObjectPage.options.settings.content.header.actions;
    const visibleFor = (r: Row) => Object.entries<any>(actions()).filter(([, a]) => binding(a.visible, r)).map(([k]) => k);

    it('SAP AI Core: Set Service Key and Activate while inactive, Deactivate while active; no credential or model actions', () => {
      expect(visibleFor(row('sap-ai-core', { isActive: false }))).toEqual(['TestConnection', 'SetServiceKey', 'Activate']);
      expect(visibleFor(row('sap-ai-core', { isActive: true }))).toEqual(['TestConnection', 'SetServiceKey', 'Deactivate']);
      expect(visibleFor(row('sap-ai-core', { IsActiveEntity: false }))).toEqual([]);
    });

    it('the other types keep Set Credential and Add Model and never see the SAP actions', () => {
      for (const type of TYPES.filter((t) => t !== 'sap-ai-core')) {
        for (const isActive of [true, false]) expect([type, visibleFor(row(type, { isActive }))]).toEqual([type, ['TestConnection', 'SetCredential', 'AddModel']]);
      }
    });

    // OData V4 formats every part to the target property's type before the expression runs: a bare ${providerType}
    // becomes a boolean "sap-ai-core" that throws, and the button keeps visible=true. Every part reads the raw value.
    it('reads every binding part raw (targetType any)', () => {
      for (const [key, a] of Object.entries<any>(actions())) {
        for (const prop of ['visible', 'enabled']) {
          const parts = String(a[prop]).match(/\$\{[^}]*\}/g) ?? [];
          for (const part of parts) expect([key, prop, part]).toEqual([key, prop, expect.stringMatching(/^\$\{path: '[A-Za-z]+', targetType: 'any'\}$/)]);
        }
      }
    });

    it('each action is enabled exactly when it is shown, with its own handler and text', () => {
      for (const [key, a] of Object.entries<any>(actions())) {
        expect([key, a.enabled]).toEqual([key, a.visible]);
        expect(a.press).toBe(`admin.connections.ext.controller.ConnectionActions.on${key}`);
        expect(a.text).toMatch(/^\{\{[a-zA-Z]+\}\}$/);
      }
    });
  });
});
