import { DARK, LIGHT, STORAGE_KEY, SUPPORTED, SYSTEM, currentChoice, followsSystem, isSupported, resolveTheme, serverThemeAction, themeChangeAction, themeFor, urlThemeOverride } from '../webapp/model/theme';

describe('the theme choices', () => {
  it('are Light, Dark and System, stored under the agreed key', () => {
    expect(SUPPORTED).toEqual(['sap_horizon', 'sap_horizon_dark', 'system']);
    expect([LIGHT, DARK, SYSTEM]).toEqual(['sap_horizon', 'sap_horizon_dark', 'system']);
    expect(STORAGE_KEY).toBe('sail.cockpit.theme');
  });
  it('isSupported accepts exactly those', () => {
    for (const choice of SUPPORTED) expect(isSupported(choice)).toBe(true);
    for (const other of ['', 'sap_fiori_3', 'sap_quartz_dark', 'SYSTEM', 'dark', null, undefined]) {
      expect(isSupported(other)).toBe(false);
    }
  });
  it('a missing or unknown stored value means Light (the default for users who never chose)', () => {
    expect(currentChoice(null)).toBe(LIGHT);
    expect(currentChoice('sap_fiori_3')).toBe(LIGHT);
    expect(currentChoice(SYSTEM)).toBe(SYSTEM);
    expect(currentChoice(DARK)).toBe(DARK);
  });
});

describe('themeFor (a choice as a UI5 theme id)', () => {
  it('Light and Dark ignore the system setting', () => {
    expect(themeFor(LIGHT, true)).toBe('sap_horizon');
    expect(themeFor(DARK, false)).toBe('sap_horizon_dark');
  });
  it('System follows prefers-color-scheme', () => {
    expect(themeFor(SYSTEM, true)).toBe('sap_horizon_dark');
    expect(themeFor(SYSTEM, false)).toBe('sap_horizon');
  });
  it('an unknown choice is Light', () => {
    expect(themeFor('sap_quartz_dark', true)).toBe('sap_horizon');
  });
});

describe('resolveTheme (before UI5 boots)', () => {
  it('the sap-theme URL parameter wins', () => {
    expect(resolveTheme('sap_fiori_3', DARK, true)).toBe('sap_fiori_3');
  });
  it('then the stored choice', () => {
    expect(resolveTheme(null, DARK, false)).toBe('sap_horizon_dark');
    expect(resolveTheme('', SYSTEM, true)).toBe('sap_horizon_dark');
    expect(resolveTheme(null, SYSTEM, false)).toBe('sap_horizon');
  });
  it('else Light, also for an unsupported stored value', () => {
    expect(resolveTheme(null, null, true)).toBe('sap_horizon');
    expect(resolveTheme(undefined, 'sap_quartz_dark', true)).toBe('sap_horizon');
  });
});

describe('serverThemeAction (adopting the account theme on load)', () => {
  it('adopts a differing account theme', () => {
    expect(serverThemeAction(DARK, null, null)).toBe('adopt');
    expect(serverThemeAction(SYSTEM, DARK, null)).toBe('adopt');
    expect(serverThemeAction(LIGHT, DARK, null)).toBe('adopt');
  });
  it('needs nothing when both already mean the same choice', () => {
    expect(serverThemeAction(DARK, DARK, null)).toBe('none');
    // existing rows hold sap_horizon and nothing is stored yet: both mean Light
    expect(serverThemeAction(LIGHT, null, null)).toBe('none');
    expect(serverThemeAction(LIGHT, 'garbage', null)).toBe('none');
  });
  it('a sap-theme URL parameter is an explicit override', () => {
    expect(serverThemeAction(DARK, null, 'sap_horizon')).toBe('none');
  });
  it('ignores a missing or unsupported account value', () => {
    expect(serverThemeAction(null, DARK, null)).toBe('none');
    expect(serverThemeAction(undefined, null, null)).toBe('none');
    expect(serverThemeAction('sap_fiori_3', DARK, null)).toBe('none');
  });
});

describe('themeChangeAction (a saved Settings choice)', () => {
  it('applies a choice the account took', () => {
    expect(themeChangeAction(DARK, true)).toBe('apply');
    expect(themeChangeAction(SYSTEM, true)).toBe('apply');
  });
  it('keeps the current theme when the account did not take it', () => {
    expect(themeChangeAction(DARK, false)).toBe('keep');
  });
  it('ignores a choice the cockpit does not offer', () => {
    expect(themeChangeAction('sap_fiori_3', true)).toBe('ignore');
  });
});

describe('followsSystem (listen to prefers-color-scheme changes)', () => {
  it('only for the System choice without a URL override', () => {
    expect(followsSystem(SYSTEM, null)).toBe(true);
    expect(followsSystem(SYSTEM, 'sap_horizon')).toBe(false);
    expect(followsSystem(DARK, null)).toBe(false);
    expect(followsSystem(LIGHT, null)).toBe(false);
  });
});

describe('urlThemeOverride (the URL theme UI5 itself would take)', () => {
  it('reads sap-theme and sap-ui-theme alike', () => {
    expect(urlThemeOverride('?sap-theme=sap_horizon_dark')).toBe('sap_horizon_dark');
    expect(urlThemeOverride('?sap-ui-theme=sap_horizon_hcb')).toBe('sap_horizon_hcb');
    expect(urlThemeOverride('?sap-language=EN&sap-ui-theme=sap_horizon')).toBe('sap_horizon');
  });
  it('sap-theme wins when both are set', () => {
    expect(urlThemeOverride('?sap-ui-theme=sap_horizon&sap-theme=sap_horizon_dark')).toBe('sap_horizon_dark');
  });
  it('is null without one (an empty value is none)', () => {
    expect(urlThemeOverride('')).toBeNull();
    expect(urlThemeOverride('?sap-language=EN')).toBeNull();
    expect(urlThemeOverride('?sap-theme=')).toBeNull();
  });
  it('an sap-ui-theme override stops account adoption and the System listener like sap-theme', () => {
    const override = urlThemeOverride('?sap-ui-theme=sap_horizon');
    expect(serverThemeAction(DARK, null, override)).toBe('none');
    expect(followsSystem(SYSTEM, override)).toBe(false);
    expect(resolveTheme(override, DARK, true)).toBe('sap_horizon');
  });
});
