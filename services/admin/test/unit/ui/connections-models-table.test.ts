/**
 * The Connections object page's models table (connections-app annotations.cds) is a responsive
 * table: columns without a high importance are dropped first when the width runs out. The four
 * model actions are toolbar buttons on the selected row (not inline), in this order, and the
 * columns an admin decides by must survive a laptop-wide window.
 */
import path from 'path';
import manifest from '../../../app/connections-app/webapp/manifest.json';
const cds = require('@sap/cds');

const ANNOTATIONS = path.resolve(__dirname, '../../../app/connections-app/annotations.cds');
const importance = (e: any): string | undefined => e['@UI.Importance']?.['#'];

describe('connections-app models table', () => {
  let items: any[];
  beforeAll(async () => {
    const csn = await cds.load(ANNOTATIONS);
    items = csn.definitions['AdminService.ConnectionModels']['@UI.LineItem#ForConnection'];
  });

  it('offers the four model actions in the toolbar, not inline, in order', () => {
    const actions = items.filter((e) => e.$Type === 'UI.DataFieldForAction');
    expect(actions.map((a) => a.Action)).toEqual(['AdminService.setListPrice', 'AdminService.publish', 'AdminService.unpublish', 'AdminService.remove']);
    for (const a of actions) expect([a.Action, a.Inline ?? false]).toEqual([a.Action, false]);
  });

  it('keeps the deciding columns at high or medium and demotes only the family', () => {
    const byValue = (v: string) => items.find((e) => e.Value?.['='] === v);
    for (const v of ['upstreamModel', 'isPublished', 'isPriced', 'inputCost', 'outputCost', 'priceCurrency']) {
      expect([v, ['High', 'Medium'].includes(importance(byValue(v)) ?? '')]).toEqual([v, true]);
    }
    for (const v of ['modelId', 'displayName']) expect([v, importance(byValue(v))]).toEqual([v, 'Medium']);
    expect(importance(byValue('family'))).toBe('Low');
  });

  // remove returns nothing: without side effects on the parent FE keeps the deleted rows in the table.
  it('refreshes the models table and the published count after Remove, Publish and Unpublish', async () => {
    const csn = await cds.load(ANNOTATIONS);
    const actions = csn.definitions['AdminService.ConnectionModels'].actions;
    // cds flattens the record: @Common.SideEffects.TargetEntities / .TargetProperties
    const effect = (a: string, key: string) => actions[a][`@Common.SideEffects.${key}`] ?? [];
    expect(effect('remove', 'TargetEntities').map((t: any) => t['='])).toEqual(['in.connection.models']);
    for (const a of ['remove', 'publish', 'unpublish']) {
      expect([a, effect(a, 'TargetProperties').includes('in/connection/publishedModels')]).toEqual([a, true]);
    }
  });

  // Fixed rem widths cut long upstream ids and the cost headers: the columns size themselves and the
  // responsive table pops columns in by their importance.
  it('sets no fixed width on a models column', () => {
    const table = (manifest as any)['sap.ui5'].routing.targets.ConnectionsObjectPage.options.settings.controlConfiguration['models/@com.sap.vocabularies.UI.v1.LineItem#ForConnection'];
    for (const [key, column] of Object.entries<any>(table.columns ?? {})) expect([key, column.width]).toEqual([key, undefined]);
  });

  it('selects several rows, but Set Price needs exactly one', () => {
    const table = (manifest as any)['sap.ui5'].routing.targets.ConnectionsObjectPage.options.settings.controlConfiguration['models/@com.sap.vocabularies.UI.v1.LineItem#ForConnection'];
    expect(table.tableSettings.selectionMode).toBe('Multi');
    expect(table.actions['DataFieldForAction::AdminService.setListPrice'].enableOnSelect).toBe('single');
    for (const other of ['publish', 'unpublish', 'remove']) expect(table.actions[`DataFieldForAction::AdminService.${other}`]).toBeUndefined();
  });
});
