import { SESSION_RELOAD_KEY, SUPPORTED, STORAGE_KEY, isSupported, languageChangeAction, needsServerLanguage, resolveLanguage, serverLanguageAction } from '../webapp/model/language';

describe('resolveLanguage', () => {
  it('the sap-language URL parameter beats the stored choice', () => {
    expect(resolveLanguage('FR', 'de', ['en-US'])).toBe('FR');
  });
  it('a supported stored choice beats the browser', () => {
    expect(resolveLanguage(null, 'de', ['fr-FR', 'en'])).toBe('de');
  });
  it('a stored empty string follows the browser', () => {
    expect(resolveLanguage(null, '', ['nl-NL', 'en'])).toBe('nl');
  });
  it('an unsupported stored value follows the browser', () => {
    expect(resolveLanguage(null, 'ja', ['it-IT'])).toBe('it');
  });
  it('a regional browser language maps to its primary subtag', () => {
    expect(resolveLanguage(null, null, ['pt-BR'])).toBe('pt');
  });
  it('the first supported browser language wins', () => {
    expect(resolveLanguage(null, null, ['ja-JP', 'es-ES', 'de'])).toBe('es');
  });
  it('no supported language falls back to English', () => {
    expect(resolveLanguage(null, null, ['ja-JP', 'zh'])).toBe('en');
    expect(resolveLanguage(null, null, [])).toBe('en');
    expect(resolveLanguage('', undefined, undefined)).toBe('en');
  });
});

describe('isSupported', () => {
  it('accepts the supported codes, empty meaning the browser default', () => {
    for (const code of SUPPORTED) expect(isSupported(code)).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isSupported('ja')).toBe(false);
    expect(isSupported('DE')).toBe(false);
    expect(isSupported(null)).toBe(false);
    expect(isSupported(undefined)).toBe(false);
  });
  it('lists exactly the cockpit languages and uses the agreed storage key', () => {
    expect(SUPPORTED).toEqual(['', 'en', 'de', 'es', 'fr', 'it', 'nl', 'pt']);
    expect(STORAGE_KEY).toBe('sail.cockpit.language');
  });
});

describe('serverLanguageAction (adopting the signed-in user\'s language on load)', () => {
  it('a server value of null (never chosen) keeps the browser\'s choice', () => {
    expect(needsServerLanguage(null, 'de', null)).toBe(false);
    expect(needsServerLanguage(undefined, null, null)).toBe(false);
    expect(serverLanguageAction(null, 'de', null, true, null)).toBe('none');
  });
  it('a sap-language URL parameter is an explicit override', () => {
    expect(needsServerLanguage('de', 'fr', 'fr')).toBe(false);
    expect(serverLanguageAction('de', 'fr', 'fr', true, null)).toBe('none');
  });
  it('a server value equal to the stored one needs nothing', () => {
    expect(needsServerLanguage('de', 'de', null)).toBe(false);
    expect(serverLanguageAction('de', 'de', null, true, null)).toBe('none');
  });
  it('browser default on the server equals nothing stored', () => {
    expect(needsServerLanguage('', null, null)).toBe(false);
    expect(needsServerLanguage('', '', null)).toBe(false);
    expect(needsServerLanguage('', 'ja', null)).toBe(false);
  });
  it('a differing server value reloads once storage took it', () => {
    expect(needsServerLanguage('de', null, null)).toBe(true);
    expect(needsServerLanguage('', 'de', null)).toBe(true);
    expect(serverLanguageAction('de', null, null, true, null)).toBe('reload');
    expect(serverLanguageAction('', 'fr', '', true, null)).toBe('reload');
  });
  it('does not reload when storage is blocked or the write did not stick', () => {
    expect(serverLanguageAction('de', null, null, false, null)).toBe('none');
  });
  it('the same user does not reload a second time (marker equals the server value)', () => {
    expect(serverLanguageAction('de', 'fr', null, true, 'de')).toBe('none');
  });
  it('a different user with a different language reloads once more', () => {
    // user A adopted de (marker de, stored de); user B signs in on the tab with fr
    expect(serverLanguageAction('fr', 'de', null, true, 'de')).toBe('reload');
    // after adopting fr the marker is fr: no loop
    expect(serverLanguageAction('fr', 'fr', null, true, 'fr')).toBe('none');
    expect(serverLanguageAction('fr', 'de', null, true, 'fr')).toBe('none');
  });
  it('a different user with the same language does not reload', () => {
    expect(serverLanguageAction('de', 'de', null, true, 'de')).toBe('none');
    expect(serverLanguageAction('de', 'de', null, true, 'fr')).toBe('none');
  });
  it('a blocked storage never reloads, whatever the marker', () => {
    expect(serverLanguageAction('fr', 'de', null, false, 'de')).toBe('none');
    expect(serverLanguageAction('fr', 'de', null, false, null)).toBe('none');
  });
  it('ignores a server value the cockpit does not support', () => {
    expect(needsServerLanguage('xx', 'de', null)).toBe(false);
    expect(serverLanguageAction('xx', 'de', null, true, null)).toBe('none');
  });
  it('uses its own session marker key', () => {
    expect(SESSION_RELOAD_KEY).toBe('sail.cockpit.languageAdopted');
  });
});

describe('languageChangeAction (a Settings choice)', () => {
  it('applies a choice the account saved', () => {
    expect(languageChangeAction('de', true)).toBe('apply');
    expect(languageChangeAction('', true)).toBe('apply');
  });
  it('keeps the current language when the account could not save it', () => {
    expect(languageChangeAction('de', false)).toBe('keep');
    expect(languageChangeAction('', false)).toBe('keep');
  });
  it('ignores a code the cockpit does not offer', () => {
    expect(languageChangeAction('xx', true)).toBe('ignore');
    expect(languageChangeAction('xx', false)).toBe('ignore');
  });
  it('why: a choice applied only locally would be reverted by the account language on the next load', () => {
    // account fr, the save of de failed, de applied locally anyway -> the load adopts fr again
    expect(serverLanguageAction('fr', 'de', null, true, null)).toBe('reload');
  });
});
