/**
 * The Connections list (connections-app): the credential column shows the masked hint, or a dash
 * when no credential is set (a custom column; a DataField cell would stay empty).
 */
import fs from 'fs';
import path from 'path';
import manifest from '../../../app/connections-app/webapp/manifest.json';
const cds = require('@sap/cds');

const APP = path.resolve(__dirname, '../../../app/connections-app');

describe('connections-app list table', () => {
  const columns = () => (manifest as any)['sap.ui5'].routing.targets.ConnectionsList.options.settings.controlConfiguration['@com.sap.vocabularies.UI.v1.LineItem'].columns ?? {};

  it('shows the credential hint in a custom column, in the hint\'s place', async () => {
    const csn = await cds.load(path.join(APP, 'annotations.cds'));
    const items: any[] = csn.definitions['AdminService.ProviderConnections']['@UI.LineItem'];
    expect(items.map((e) => e.Value?.['='])).not.toContain('credentialHint');
    const column = columns().CredentialColumn;
    expect(column).toMatchObject({
      header: '{{credentialColumn}}', template: 'admin.connections.ext.fragment.CredentialCell',
      importance: 'Medium', properties: ['credentialHint'], position: { anchor: 'DataField::lastTestResult', placement: 'Before' },
    });
  });

  // ListJourney reads the provider type's text from the fixture: it must be the text the list shows.
  it('the journey fixture names the provider type as the English bundle does', () => {
    const fixtures = require('../../../../../ci/scripts/ui-journeys/fixtures');
    const en = fs.readFileSync(path.resolve(__dirname, '../../../_i18n/i18n.properties'), 'utf8');
    const text = /^connections\.providerType\.openai=(.*)$/m.exec(en)?.[1];
    expect(fixtures.connection.providerType).toBe('openai');
    expect(fixtures.connection.providerTypeText).toBe(text);
    const sap = /^connections\.providerType\.sapAiCore=(.*)$/m.exec(en)?.[1];
    expect(fixtures.sapConnection.providerType).toBe('sap-ai-core');
    expect(fixtures.sapConnection.providerTypeText).toBe(sap);
  });

  it('the cell shows the hint, else the empty-value text', () => {
    const fragment = fs.readFileSync(path.join(APP, 'webapp/ext/fragment/CredentialCell.fragment.xml'), 'utf8');
    expect(fragment).toMatch(/<Text [^>]*text="\{= \$\{credentialHint\} \|\| \$\{i18n>emptyValue\} \}"/);
  });
});
