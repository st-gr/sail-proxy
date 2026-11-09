/**
 * The Plugins screen's rows, from the answer of GET /api/plugins. No UI5 imports, so it runs under
 * jest. Ids, summaries, error texts and rule ids come from an uploaded package or a gateway: they are
 * kept as data here and reach the view only through model bindings, never as HTML.
 */

export type Translator = (key: string, args?: (string | number)[]) => string;
export interface RowOptions { t?: Translator; language?: string; locale?: string }

/** English defaults, byte-identical to the bundle: jest gets them, the controller injects the bundle. */
const EN_TEXTS: Record<string, string> = {
  stateRunning: 'Running',
  stateFailed: 'Failed',
  stateIncompatible: 'Not compatible with gateway {0}',
  stateIncompatibleUnknown: 'Not compatible with this gateway',
  stateInstalled: 'Installed, not loaded yet',
  statePending: 'Waiting for the gateway',
  stateNotResponding: 'Gateway not responding',
  stateNotRespondingDetail: 'The change applies at the gateway\'s next start.',
  stateUnavailable: 'Status unavailable',
  stateDisabled: 'Disabled',
  stateRunningVersion: 'Running {0}',
  versionEnabled: '{0} (enabled)',
  enableAction: 'Enable',
  switchAction: 'Switch to this version',
  incompatibleVersion: 'Needs gateway {0}; this installation is {1}.',
  helpFallback: 'This help is not available in your language; it is shown in {0}.',
  allGateways: 'All gateways'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

type StateKey = 'running' | 'failed' | 'incompatible' | 'installed' | 'pending' | 'notResponding' | 'unavailable' | 'disabled';

/** The worst state of several instances is the plugin's: the higher, the worse. */
const SEVERITY: Record<string, number> = { running: 0, installed: 1, pending: 2, incompatible: 3, failed: 4 };
const STATE_OF: Record<StateKey, string> = {
  running: 'Success', failed: 'Error', incompatible: 'Warning', installed: 'Information',
  pending: 'Information', notResponding: 'Warning', unavailable: 'None', disabled: 'None'
};

export interface VersionInfo {
  version: string; uploadedBy: string; uploadedAtText: string; gateway: string; compatible: boolean;
  summaryText: string; helpNoteText: string; compatibilityText: string;
}

export interface PluginRow {
  id: string; enabledVersion: string | null; selectedVersion: string;
  versionOptions: { key: string; text: string }[]; versionInfos: VersionInfo[];
  stateKey: StateKey; statusText: string; statusState: string; errorText: string; detailText: string; rulesText: string;
  summaryText: string; helpNoteText: string; compatibilityText: string; uploadedBy: string; uploadedAtText: string;
  canEnable: boolean; enableText: string; canDisable: boolean; canRemove: boolean; canAddHooks: boolean; switchText: string; enableLabel: string;
}

const list = (value: any): any[] => (Array.isArray(value) ? value : []);
const str = (value: any): string => (typeof value === 'string' ? value : '');

/** Numeric parts in order, a pre-release below its release; enough for ordering stored versions. */
export function compareVersions(a: string, b: string): number {
  const [mainA, preA] = a.split(/[-+]/, 2);
  const [mainB, preB] = b.split(/[-+]/, 2);
  const partsA = mainA.split('.').map(Number);
  const partsB = mainB.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff;
  }
  if (a.includes('-') === b.includes('-')) return (preA ?? '').localeCompare(preB ?? '');
  return a.includes('-') ? -1 : 1;
}

/** Exact language, then the base language, then the first the manifest lists; `fallback` names the last case. */
export function helpFor(help: any, language: string): { summary: string; fallback: string } {
  if (!help || typeof help !== 'object') return { summary: '', fallback: '' };
  const langs = Object.keys(help);
  const wanted = language.replace('_', '-');
  const exact = langs.find((l) => l.toLowerCase() === wanted.toLowerCase())
    ?? langs.find((l) => l.toLowerCase() === wanted.split('-')[0].toLowerCase());
  if (exact) return { summary: str(help[exact]?.summary), fallback: '' };
  return langs.length ? { summary: str(help[langs[0]]?.summary), fallback: langs[0] } : { summary: '', fallback: '' };
}

const formatDate = (iso: string, locale: string): string => {
  const date = new Date(iso);
  return iso && !Number.isNaN(date.getTime()) ? date.toLocaleString(locale) : '';
};

const rulesTextOf = (groups: any[]): string =>
  [...new Set(groups.flatMap((rules) => list(rules).map((rule) => str(rule?.id))).filter(Boolean))].sort().join(', ');

/** The instances the screen looks at: all of them, or the one the admin chose. */
const instancesOf = (response: any, instance: string): any[] =>
  list(response?.gatewayStatus?.instances).filter((i) => !instance || i?.instance === instance);

function statusOf(plugin: any, response: any, instance: string, t: Translator): Pick<PluginRow, 'stateKey' | 'statusText' | 'statusState' | 'errorText' | 'detailText' | 'rulesText'> {
  const reports = list(plugin.status).filter((s) => !instance || s?.instance === instance);
  const instances = instancesOf(response, instance);
  const rulesText = rulesTextOf(reports.map((s) => s?.rules));
  const result = (stateKey: StateKey, statusText: string, detailText = '', errorText = '') =>
    ({ stateKey, statusText, statusState: STATE_OF[stateKey], errorText, detailText, rulesText });

  if (!plugin.enabledVersion) return result('disabled', t('stateDisabled'));
  if (response?.gatewayStatus?.available !== true) return result('unavailable', t('stateUnavailable'));
  if (instances.length === 0) return result('notResponding', t('stateNotResponding'), t('stateNotRespondingDetail'));

  // One state per instance. An instance that does not list the plugin, or still runs another version, has not caught up.
  const perInstance = instances.map((i) => {
    const report = reports.find((s) => s?.instance === i?.instance);
    const key: string = !report ? 'pending'
      : report.state === 'running' && report.version !== plugin.enabledVersion ? 'pending'
        : str(report.state) in SEVERITY ? report.state : 'failed';
    return { name: str(i?.instance), gatewayVersion: str(i?.gatewayVersion), report, key };
  });
  const worst = perInstance.reduce((a, b) => (SEVERITY[b.key] > SEVERITY[a.key] ? b : a));
  const textOf = (entry: typeof worst): string => {
    if (entry.key === 'failed') return t('stateFailed');
    if (entry.key === 'running') return t('stateRunning');
    if (entry.key === 'installed') return t('stateInstalled');
    if (entry.key === 'pending') return t('statePending');
    return entry.gatewayVersion ? t('stateIncompatible', [entry.gatewayVersion]) : t('stateIncompatibleUnknown');
  };
  const errorText = str(worst.report?.error);
  if (perInstance.length > 1) {
    return result(worst.key as StateKey, textOf(worst), perInstance.map((e) => `${e.name}: ${textOf(e)}`).join('; '), errorText);
  }
  // A single gateway on an older version: the state says it is waiting, the detail says what still runs.
  const stillRuns = worst.key === 'pending' && worst.report?.state === 'running' && worst.report.version;
  return result(worst.key as StateKey, textOf(worst), stillRuns ? t('stateRunningVersion', [worst.report.version]) : '', errorText);
}

function versionInfo(raw: any, response: any, language: string, locale: string, t: Translator): VersionInfo {
  const help = helpFor(raw?.help, language);
  const gateway = str(raw?.gateway);
  const compatible = raw?.compatible === true;
  return {
    version: str(raw?.version),
    uploadedBy: str(raw?.uploadedBy),
    uploadedAtText: formatDate(str(raw?.uploadedAt), locale),
    gateway,
    compatible,
    summaryText: help.summary,
    helpNoteText: help.fallback ? t('helpFallback', [help.fallback]) : '',
    compatibilityText: compatible ? '' : t('incompatibleVersion', [gateway, str(response?.adminVersion)])
  };
}

/** The selected version's parts of a row. The actions depend on it, so the screen calls this again on a change. */
function applySelected(row: PluginRow, selected: VersionInfo | undefined, settingOn: boolean): PluginRow {
  const isEnabled = !!selected && selected.version === row.enabledVersion;
  return {
    ...row,
    selectedVersion: selected?.version ?? '',
    summaryText: selected?.summaryText ?? '',
    helpNoteText: selected?.helpNoteText ?? '',
    compatibilityText: selected?.compatibilityText ?? '',
    uploadedBy: selected?.uploadedBy ?? '',
    uploadedAtText: selected?.uploadedAtText ?? '',
    canEnable: settingOn && !!selected && selected.compatible && !isEnabled,
    enableText: row.enabledVersion ? row.switchText : row.enableLabel,
    canRemove: !!selected && !isEnabled
  };
}

/** Rows for the stored plugins, joined with what the gateways report; `instance` '' means all of them. */
export function pluginRows(response: any, instance: string, options: RowOptions = {}): PluginRow[] {
  const t = options.t ?? defaultTranslate;
  const language = options.language ?? 'en';
  const locale = options.locale ?? 'en-US';
  const settingOn = response?.enabled === true;
  return list(response?.plugins).map((plugin) => {
    const enabledVersion: string | null = plugin?.enabledVersion ?? null;
    const infos = list(plugin?.versions).map((v) => versionInfo(v, response, language, locale, t))
      .sort((a, b) => compareVersions(b.version, a.version));
    const base: PluginRow = {
      id: str(plugin?.id),
      enabledVersion,
      selectedVersion: '',
      versionOptions: infos.map((v) => ({ key: v.version, text: v.version === enabledVersion ? t('versionEnabled', [v.version]) : v.version })),
      versionInfos: infos,
      ...statusOf(plugin, response, instance, t),
      summaryText: '', helpNoteText: '', compatibilityText: '', uploadedBy: '', uploadedAtText: '',
      canEnable: false, enableText: '', canRemove: false,
      canDisable: enabledVersion !== null,
      canAddHooks: enabledVersion !== null,
      switchText: t('switchAction'),
      enableLabel: t('enableAction')
    };
    return applySelected(base, infos.find((v) => v.version === enabledVersion) ?? infos[0], settingOn);
  });
}

/** The row after the admin chose another version in its select; an unknown version changes nothing. */
export function withSelectedVersion(row: PluginRow, version: string, settingOn: boolean): PluginRow {
  const selected = row.versionInfos.find((v) => v.version === version);
  return selected ? applySelected(row, selected, settingOn) : row;
}

export interface SelectionActions { canEnable: boolean; enableText: string; canDisable: boolean; canRemove: boolean; canAddHooks: boolean }
export type RowAction = 'canEnable' | 'canDisable' | 'canRemove' | 'canAddHooks';

/** The selected rows an action applies to, and those it leaves as they are. */
export function rowsForAction(rows: PluginRow[], action: RowAction): { fitting: PluginRow[]; skipped: PluginRow[] } {
  return { fitting: rows.filter((row) => row[action]), skipped: rows.filter((row) => !row[action]) };
}

/**
 * The buttons above the table, for the selected rows. An action is on when it fits at least one of them;
 * it then acts on those, and the screen names the others. The Enable label follows the rows it would act on.
 */
export function selectionActions(rows: PluginRow[], t: Translator = defaultTranslate): SelectionActions {
  const fits = (action: RowAction): boolean => rows.some((row) => row[action]);
  const enabling = rowsForAction(rows, 'canEnable').fitting;
  return {
    canEnable: fits('canEnable'),
    enableText: t(enabling.length > 0 && enabling.every((row) => row.enabledVersion !== null) ? 'switchAction' : 'enableAction'),
    canDisable: fits('canDisable'),
    canRemove: fits('canRemove'),
    canAddHooks: fits('canAddHooks')
  };
}

/** The plugins that ship with the gateway: read-only, so no action state. A failed one still shows its error. */
export function builtinRows(response: any, instance: string, options: RowOptions = {}): Record<string, string>[] {
  const t = options.t ?? defaultTranslate;
  const reports = instancesOf(response, instance).flatMap((i) => list(i?.plugins)).filter((p) => p?.kind === 'shipped');
  return list(response?.builtins).map((builtin) => {
    const own = reports.filter((p) => p?.id === builtin?.id);
    const failed = own.find((p) => p?.state !== 'running');
    return {
      id: str(builtin?.id),
      versionText: str(builtin?.version),
      rulesText: rulesTextOf([builtin?.rules]),
      statusText: failed ? (failed.state === 'incompatible' ? t('stateIncompatibleUnknown') : t('stateFailed')) : own.length ? t('stateRunning') : '',
      errorText: str(failed?.error)
    };
  });
}

/** What the screen shows above the tables, and whether an upload can start. */
export function pageState(response: any, instance: string, options: RowOptions = {}): {
  settingOff: boolean; canUpload: boolean; statusUnavailable: boolean; notResponding: boolean; unpackDisabledReason: string;
  showInstances: boolean; instanceOptions: { key: string; text: string }[];
} {
  const t = options.t ?? defaultTranslate;
  const available = response?.gatewayStatus?.available === true;
  const all = list(response?.gatewayStatus?.instances);
  const names = all.map((i) => str(i?.instance)).sort();
  return {
    settingOff: response?.enabled === false,
    canUpload: response?.enabled === true,
    statusUnavailable: !available,
    notResponding: available && instancesOf(response, instance).length === 0,
    unpackDisabledReason: str(all.map((i) => i?.unpackDisabledReason).find((reason) => typeof reason === 'string' && reason !== '')),
    showInstances: names.length > 1,
    instanceOptions: [{ key: '', text: t('allGateways') }, ...names.map((name) => ({ key: name, text: name }))]
  };
}
