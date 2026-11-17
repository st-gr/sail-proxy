/**
 * The "Switches and levels" tab: the answer of getLoggingSettings as a form, and the form as the
 * parameters of setLoggingSettings (AdminService, srv/admin-service.cds). No UI5 imports.
 *
 * "config" means "as the configuration says": the record leaves that setting open (null).
 */

export interface SettingsResult {
  logStorageEnabled: boolean | null;
  payloadCaptureEnabled: boolean | null;
  defaultLevel: string | null;
  defaultLevelUntil: string | null;
  componentLevels: { component: string; level: string; until: string | null }[] | null;
  configurationLogStorageEnabled: boolean | null;
  configurationPayloadCaptureEnabled: boolean | null;
  /** The admin's seal key: 'strong', 'missing', 'too-short' or 'publicly-known' (D1). */
  traceKeyStatus: string | null;
  configurationDefaultLevel: string | null;
  configurationComponentLevels: { component: string; level: string }[] | null;
  /** The lowest level the page stores (observability.gateway_log.min_level; INFO when not set). */
  configurationStoredLevel?: string | null;
  environmentReported: boolean | null;
  environmentReportedAt: string | null;
  environmentFixed: { variable: string; value: string }[] | null;
  /** Whether the gateway writes payload files (the debug file logger, not the traces). */
  payloadFileLoggingEnabled?: boolean | null;
  warning: string | null;
}

/** 'none' = until changed; a number of minutes; 'keep' = the time limit already running. */
export const DURATION_KEYS = ['none', '15', '60', '240', '1440'];

export interface ComponentRow {
  component: string;
  level: string;
  duration: string;
  until: string | null;
  /** The configuration's own level for this component, if it names one. */
  configLevel: string | null;
}

export interface SettingsForm {
  storage: 'config' | 'on' | 'off';
  /** Payload capture (the light traces of the Payload Traces tab). */
  capture: 'config' | 'on' | 'off';
  defaultLevel: string;
  defaultDuration: string;
  defaultUntil: string | null;
  components: ComponentRow[];
  configuration: { storage: boolean; capture: boolean; defaultLevel: string | null; storedLevel: string; components: { component: string; level: string }[] };
  /** "VARIABLE=value" when the gateway's environment fixes the setting, else null. */
  fixed: { storage: string | null; defaultLevel: string | null };
  environmentReported: boolean;
}

export interface SettingsParams {
  logStorageEnabled: boolean | null;
  payloadCaptureEnabled: boolean | null;
  defaultLevel: string | null;
  defaultLevelMinutes: number | null;
  componentLevels: string | null;
}

export interface FormProblem { path: string; key: 'componentNameMissing' | 'componentNameTwice' }

const MAX_MINUTES = 1440;
const running = (until: string | null | undefined, now: Date): string | null =>
  until && Date.parse(until) > now.getTime() ? until : null;

function fixedValue(result: SettingsResult, variable: string): string | null {
  const hit = (result.environmentFixed ?? []).find((f) => f.variable === variable);
  return hit ? `${hit.variable}=${hit.value}` : null;
}

export function formFromResult(result: SettingsResult, now: Date): SettingsForm {
  const configComponents = [...(result.configurationComponentLevels ?? [])].sort((a, b) => a.component.localeCompare(b.component));
  const configLevelOf = (name: string) => configComponents.find((c) => c.component === name)?.level ?? null;
  const defaultUntil = result.defaultLevel ? running(result.defaultLevelUntil, now) : null;
  return {
    storage: result.logStorageEnabled === true ? 'on' : result.logStorageEnabled === false ? 'off' : 'config',
    capture: result.payloadCaptureEnabled === true ? 'on' : result.payloadCaptureEnabled === false ? 'off' : 'config',
    defaultLevel: result.defaultLevel || 'config',
    defaultDuration: defaultUntil ? 'keep' : 'none',
    defaultUntil,
    components: [...(result.componentLevels ?? [])]
      .sort((a, b) => a.component.localeCompare(b.component))
      .map((c) => {
        const until = running(c.until, now);
        return { component: c.component, level: c.level, duration: until ? 'keep' : 'none', until, configLevel: configLevelOf(c.component) };
      }),
    configuration: {
      storage: result.configurationLogStorageEnabled === true,
      capture: result.configurationPayloadCaptureEnabled === true,
      defaultLevel: result.configurationDefaultLevel || null,
      storedLevel: result.configurationStoredLevel || 'INFO',
      components: configComponents
    },
    fixed: { storage: fixedValue(result, 'GATEWAY_LOG_SHIPPING'), defaultLevel: fixedValue(result, 'LOG_LEVEL') },
    environmentReported: result.environmentReported === true
  };
}

/** A kept time limit that has run out by now: the service has dropped that level already. */
export const ranOut = (duration: string, until: string | null, now: Date): boolean =>
  duration === 'keep' && !!until && Date.parse(until) <= now.getTime();

/** Minutes for a duration choice; 'keep' sends what is left of the running limit, rounded up. */
function minutesOf(duration: string, until: string | null, now: Date): number | null {
  if (duration === 'keep') {
    if (!until) return null;
    const left = Math.ceil((Date.parse(until) - now.getTime()) / 60_000);
    return Math.min(MAX_MINUTES, Math.max(1, left));
  }
  const minutes = Number(duration);
  return Number.isInteger(minutes) && minutes > 0 ? minutes : null;
}

/**
 * The parameters of setLoggingSettings; componentLevels is JSON { [component]: { level, minutes? } }.
 * A setting the gateway's environment fixes is sent as "as the configuration says": the variable has
 * the last word anyway, and the service refuses a value for it (LOGGING_FIXED_*), which would block
 * saving the rest; leaving the parameter out clears it too (the service replaces the record), so a
 * stored value under a fixed setting is cleared by any save, and the pop-up says so (clearedByFixed).
 * Switching storage off stays possible while GATEWAY_LOG_SHIPPING=off. A kept time limit that has run
 * out while the form was open sends nothing for that level: the service has dropped it already, and
 * re-arming it for a minute would surprise.
 */
export function paramsFromForm(form: SettingsForm, now: Date): SettingsParams {
  let logStorageEnabled = form.storage === 'on' ? true : form.storage === 'off' ? false : null;
  if (form.fixed.storage && logStorageEnabled === true) logStorageEnabled = null;
  const levelGiven = form.defaultLevel !== 'config' && !form.fixed.defaultLevel && !ranOut(form.defaultDuration, form.defaultUntil, now);
  const components: Record<string, { level: string; minutes?: number }> = {};
  const rows = form.components.filter((row) => !ranOut(row.duration, row.until, now));
  for (const row of rows) {
    const minutes = minutesOf(row.duration, row.until, now);
    components[row.component.trim()] = minutes === null ? { level: row.level } : { level: row.level, minutes };
  }
  return {
    logStorageEnabled,
    payloadCaptureEnabled: form.capture === 'on' ? true : form.capture === 'off' ? false : null,
    defaultLevel: levelGiven ? form.defaultLevel : null,
    defaultLevelMinutes: levelGiven ? minutesOf(form.defaultDuration, form.defaultUntil, now) : null,
    componentLevels: rows.length ? JSON.stringify(components) : null
  };
}

/** The variables whose stored value a save clears: the record holds a value the variable overrides. */
export function clearedByFixed(form: SettingsForm): string[] {
  const cleared: string[] = [];
  if (form.fixed.storage && form.storage === 'on') cleared.push('GATEWAY_LOG_SHIPPING');
  if (form.fixed.defaultLevel && form.defaultLevel !== 'config') cleared.push('LOG_LEVEL');
  return cleared;
}

export interface ComponentHint { key: 'componentCase' | 'componentUnknown'; args: string[] }

/**
 * A warning per component row, or null: the gateway matches a component level by the exact name it
 * logs with, so a name that differs only in case gets the right spelling, and a name no stored log
 * line has gets a warning (it may still be right: a component that has not logged yet). Nothing while
 * no names are known (the stored log is empty or storing is off). It never blocks saving.
 */
export function componentHints(rows: { component: string }[], known: string[]): (ComponentHint | null)[] {
  const exact = new Set(known);
  const byLower = new Map(known.map((name) => [name.toLowerCase(), name]));
  return rows.map((row) => {
    const name = row.component.trim();
    if (!name || known.length === 0 || exact.has(name)) return null;
    const match = byLower.get(name.toLowerCase());
    return match ? { key: 'componentCase', args: [match] } : { key: 'componentUnknown', args: [] };
  });
}

/**
 * The choices of a form, without what the page adds to a row for its display: equal signatures mean
 * nothing to save (the footer's Save and Cancel follow it).
 */
export function formSignature(form: SettingsForm): string {
  return JSON.stringify([form.storage, form.capture, form.defaultLevel, form.defaultDuration,
    form.components.map((row) => [row.component, row.level, row.duration])]);
}

/** What the page checks before it asks the service: every component row has a name, and no name twice. */
export function validateForm(form: SettingsForm): FormProblem[] {
  const problems: FormProblem[] = [];
  const seen = new Set<string>();
  form.components.forEach((row, index) => {
    const name = row.component.trim();
    const path = `/components/${index}/component`;
    if (!name) problems.push({ path, key: 'componentNameMissing' });
    else if (seen.has(name)) problems.push({ path, key: 'componentNameTwice' });
    seen.add(name);
  });
  return problems;
}

/** The field a refusal of the service belongs to; null: shown as a message. */
export function fieldOfErrorCode(code: string | null | undefined): 'storage' | 'defaultLevel' | 'defaultDuration' | null {
  switch (code) {
    case 'LOGGING_FIXED_LOG_SHIPPING': return 'storage';
    case 'LOGGING_LEVEL_INVALID':
    case 'LOGGING_FIXED_LOG_LEVEL': return 'defaultLevel';
    case 'LOGGING_MINUTES_INVALID':
    case 'LOGGING_MINUTES_WITHOUT_LEVEL': return 'defaultDuration';
    default: return null;
  }
}
