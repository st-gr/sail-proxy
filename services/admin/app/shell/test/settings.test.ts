import { changedSettings } from '../webapp/model/settings';

describe('changedSettings (what the Settings dialog Save writes)', () => {
  const current = { language: 'en', theme: 'sap_horizon' };

  it('writes nothing when nothing changed', () => {
    expect(changedSettings(current, { ...current })).toEqual([]);
  });
  it('writes only the changed values', () => {
    expect(changedSettings(current, { language: 'en', theme: 'system' })).toEqual(['theme']);
    expect(changedSettings(current, { language: 'de', theme: 'sap_horizon' })).toEqual(['language']);
  });
  it('writes the theme before the language: the language reloads the cockpit, so it comes last', () => {
    expect(changedSettings(current, { language: 'fr', theme: 'sap_horizon_dark' })).toEqual(['theme', 'language']);
  });
  it('the browser default ("") is a language of its own', () => {
    expect(changedSettings(current, { language: '', theme: 'sap_horizon' })).toEqual(['language']);
    expect(changedSettings({ language: '', theme: 'system' }, { language: '', theme: 'system' })).toEqual([]);
  });
});
