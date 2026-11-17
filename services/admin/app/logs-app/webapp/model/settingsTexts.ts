/**
 * The texts of the "Switches and levels" tab: the configured value in the first item of each list,
 * a setting the gateway's environment fixes (shown as text, not as a list), when a level with a time
 * limit ends, and the note that levels more verbose than the stored level reach only the gateway's
 * own output. No UI5 imports; the controller passes the bundle's translator and a time formatter.
 */
import { ranOut, type SettingsForm } from './settingsForm';

export type Translator = (key: string, args?: (string | number)[]) => string;

export interface FormTexts {
  storageConfigItem: string;
  captureConfigItem: string;
  defaultConfigItem: string;
  storageFixed: string;
  defaultFixed: string;
  defaultEnds: string;
  verboseNote: string;
  configurationComponents: string;
  components: { configText: string; endsText: string }[];
}

const RANK: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

/** "VARIABLE=value" (SettingsForm.fixed) as its two parts. */
function split(fixed: string): { variable: string; value: string } {
  const at = fixed.indexOf('=');
  return { variable: fixed.slice(0, at), value: fixed.slice(at + 1) };
}

/** The levels the gateway now writes at: the default (fixed, set here, or configured) and every component. */
function levelsInUse(form: SettingsForm): string[] {
  const levels: string[] = [];
  if (form.fixed.defaultLevel) levels.push(split(form.fixed.defaultLevel).value.toUpperCase());
  else if (form.defaultLevel !== 'config') levels.push(form.defaultLevel);
  else if (form.configuration.defaultLevel) levels.push(form.configuration.defaultLevel);
  const named = new Set(form.components.map((row) => row.component.trim()));
  for (const row of form.components) levels.push(row.level);
  for (const c of form.configuration.components) if (!named.has(c.component)) levels.push(c.level);
  return levels;
}

export function describeForm(form: SettingsForm, t: Translator, formatTime: (iso: string) => string, now: Date): FormTexts {
  const configDefault = form.configuration.defaultLevel ?? t('configurationNotSet');
  const onOff = (on: boolean) => t(on ? 'storageOn' : 'storageOff');
  const ends = (duration: string, until: string | null) =>
    ranOut(duration, until, now) ? t('levelRanOut') : duration === 'keep' && until ? t('endsAt', [formatTime(until)]) : '';
  const fixedText = (fixed: string | null, value: (raw: string) => string) => {
    if (!fixed) return '';
    const parts = split(fixed);
    return t('fixedValue', [value(parts.value), parts.variable]);
  };
  const stored = form.configuration.storedLevel;
  const verbose = levelsInUse(form).some((level) => (RANK[level] ?? -1) > (RANK[stored] ?? RANK.INFO));
  const listed = form.configuration.components.map((c) => `${c.component}: ${c.level}`).join(', ');
  return {
    storageConfigItem: t('asConfigured', [onOff(form.configuration.storage)]),
    captureConfigItem: t('asConfigured', [onOff(form.configuration.capture)]),
    defaultConfigItem: t('asConfigured', [configDefault]),
    storageFixed: fixedText(form.fixed.storage, () => t('storageOff')),
    defaultFixed: fixedText(form.fixed.defaultLevel, (value) => value.toUpperCase()),
    defaultEnds: ends(form.defaultDuration, form.defaultUntil),
    verboseNote: verbose ? t('verboseNote', [stored]) : '',
    configurationComponents: listed ? t('configurationComponents', [listed]) : t('configurationComponentsNone'),
    components: form.components.map((row) => ({
      configText: row.configLevel ?? t('configurationDefault', [configDefault]),
      endsText: ends(row.duration, row.until)
    }))
  };
}
