/**
 * index.html carries a dependency-free copy of the theme decision (it must run before UI5 boots).
 * This runs that inline script in a vm sandbox over the full matrix of URL parameters, stored
 * choices and system appearance, and compares what it hands UI5 (sap-ui-config.theme) with
 * resolveTheme in model/theme.ts, so the two copies cannot drift apart.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { STORAGE_KEY, resolveTheme, urlThemeOverride } from '../webapp/model/theme';

const html = fs.readFileSync(path.resolve(__dirname, '../webapp/index.html'), 'utf8');
const inlineScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((code) => code.includes(STORAGE_KEY));

interface Env { search: string; stored: string | null; prefersDark: boolean; storageThrows?: boolean; noMatchMedia?: boolean }

/** The theme the inline script configures for UI5 in the given browser state. */
function inlineTheme(env: Env): unknown {
  const sandbox: any = {
    URLSearchParams,
    navigator: { languages: ['en-US'], language: 'en-US' },
    location: { search: env.search },
    localStorage: {
      getItem: (key: string) => {
        if (env.storageThrows) throw new Error('SecurityError');
        return key === STORAGE_KEY ? env.stored : null;
      }
    }
  };
  if (!env.noMatchMedia) {
    sandbox.matchMedia = (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && env.prefersDark });
  }
  sandbox.window = sandbox;
  vm.runInNewContext(inlineScript as string, sandbox);
  return sandbox['sap-ui-config']?.theme;
}

const SEARCHES = ['', '?sap-language=EN', '?sap-theme=sap_fiori_3', '?sap-ui-theme=sap_horizon_dark',
  '?sap-ui-theme=sap_horizon&sap-theme=sap_horizon_hcb', '?sap-theme=', '?sap-ui-theme=&sap-language=DE'];
const STORED = [null, '', 'sap_horizon', 'sap_horizon_dark', 'system', 'sap_quartz_dark', 'SYSTEM'];

describe('the index.html inline theme script', () => {
  it('is found and sets a theme', () => {
    expect(inlineScript).toBeDefined();
    expect(inlineTheme({ search: '', stored: null, prefersDark: false })).toBe('sap_horizon');
  });

  const matrix: [string, string | null, boolean][] = [];
  for (const search of SEARCHES) for (const stored of STORED) for (const prefersDark of [false, true]) matrix.push([search, stored, prefersDark]);

  it.each(matrix)('url %p, stored %p, prefersDark %p: same theme as resolveTheme', (search, stored, prefersDark) => {
    expect(inlineTheme({ search, stored, prefersDark })).toBe(resolveTheme(urlThemeOverride(search), stored, prefersDark));
  });

  it('blocked storage means Light, as resolveTheme with nothing stored', () => {
    for (const prefersDark of [false, true]) {
      expect(inlineTheme({ search: '', stored: 'sap_horizon_dark', prefersDark, storageThrows: true }))
        .toBe(resolveTheme(null, null, prefersDark));
    }
  });

  it('no matchMedia means light for System, as resolveTheme with prefersDark false', () => {
    expect(inlineTheme({ search: '', stored: 'system', prefersDark: true, noMatchMedia: true }))
      .toBe(resolveTheme(null, 'system', false));
  });
});
