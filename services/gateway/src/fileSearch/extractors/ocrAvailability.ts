// Whether this gateway may OCR PDF pages without a text layer (tesseract), and in which languages.
//
// Three inputs decide it:
// - FILE_SEARCH_OCR: `off` switches OCR off whatever the host has installed. The npm standalone
//   CLI (the lite gateway) always starts the gateway with it set (npm-dist/sail-proxy,
//   utils/gateway-env.ts), after the user's .env, so no setting can turn OCR back on there.
//   Unset or `auto` means: on when the tools are there.
// - The configured languages: api_config `file_search.parsing.ocr.languages` (default eng;
//   codes validated by configService.ocrLanguagesConfig, since they become a tesseract argument).
// - The tools: `tesseract` on this process's PATH and the language data it reports with
//   `--list-langs` (honouring this process's TESSDATA_PREFIX). The Docker/Kyma image ships eng;
//   local dev and CI install them. A configured language that is not installed is
//   skipped with one warning naming it; with none left (or no tesseract) OCR is off with a
//   warning, and such pages stay empty, as before.
//
// When tesseract is asked (`--list-langs`, one probe in flight at a time): on the first call, again
// whenever the configured list changes (e.g. a configuration activated in the cockpit), and again
// PROBE_RETRY_MS after a probe that failed (no tesseract yet). A successful probe is otherwise
// kept, so language data installed later is seen on the next list change or after a restart. A
// decision is logged when it differs from the last one logged.

import { getDefaultLogger } from '@libs/logger';
import { getFileSearchConfig } from '../../services/configService';
import { niceAvailable, runExtractor, type AllowedChildEnvName } from './runners';

const logger = getDefaultLogger();

/** The env variable that switches OCR off. */
export const OCR_SWITCH_ENV = 'FILE_SEARCH_OCR';

const OFF_VALUES = new Set(['off', 'false', '0', 'no', 'disabled']);
const AUTO_VALUES = new Set(['', 'auto', 'on', 'true', '1', 'yes', 'enabled']);

const LIST_LANGS_TIMEOUT_MS = 10_000;

/** How long a failed probe is kept before tesseract is asked again. */
export const PROBE_RETRY_MS = 60_000;

export interface OcrStatus {
  enabled: boolean;
  /** True when FILE_SEARCH_OCR switched OCR off (as the npm standalone CLI always does). */
  switchedOff: boolean;
  /** Why OCR is on or off, for logs and diagnostics. */
  reason: string;
  /** The languages OCR uses, in configured order (`-l` + join('+')); empty when OCR is off. */
  languages: string[];
  /** Configured languages tesseract has no data for (skipped). */
  missing: string[];
  /** Languages tesseract reported, when it ran. */
  installed?: string[];
}

export interface OcrProbe {
  /** Resolves `tesseract --list-langs` output (stdout); rejects when tesseract cannot run. */
  listLanguages(): Promise<string>;
}

/** `off` when FILE_SEARCH_OCR switches OCR off, otherwise `auto`. An unknown value counts as `auto`. */
let switchWarnedFor: string | null = null;

export function ocrSwitch(env: NodeJS.ProcessEnv = process.env): 'off' | 'auto' {
  const raw = (env[OCR_SWITCH_ENV] ?? '').trim().toLowerCase();
  if (OFF_VALUES.has(raw)) return 'off';
  if (!AUTO_VALUES.has(raw) && switchWarnedFor !== raw) {
    switchWarnedFor = raw;
    logger.warn('FileSearchOcr', `${OCR_SWITCH_ENV}="${raw.slice(0, 32)}" is not "off" or "auto"; using "auto"`);
  }
  return 'auto';
}

/**
 * The env a tesseract child gets: one thread (OMP_THREAD_LIMIT=1) and, when this process has
 * one, its TESSDATA_PREFIX. Nothing else (see runners.ts ALLOWED_CHILD_ENV).
 */
export function tesseractChildEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<AllowedChildEnvName, string>> {
  const childEnv: Partial<Record<AllowedChildEnvName, string>> = { OMP_THREAD_LIMIT: '1' };
  if (env.TESSDATA_PREFIX) childEnv.TESSDATA_PREFIX = env.TESSDATA_PREFIX;
  return childEnv;
}

const defaultProbe: OcrProbe = {
  listLanguages: () =>
    runExtractor('tesseract', ['--list-langs'], Buffer.alloc(0), {
      timeoutMs: LIST_LANGS_TIMEOUT_MS,
      env: tesseractChildEnv(),
    }),
};

/** Language codes from `tesseract --list-langs` output (its first line is a header). */
export function parseLanguageList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^list of available languages/i.test(line));
}

type ProbeResult = { ok: true; installed: string[] } | { ok: false; error: string };

async function runProbe(probe: OcrProbe): Promise<ProbeResult> {
  try {
    return { ok: true, installed: parseLanguageList(await probe.listLanguages()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function decide(switchedOff: boolean, configured: string[], probed: ProbeResult | null): OcrStatus {
  if (switchedOff) {
    return { enabled: false, switchedOff: true, reason: `switched off (${OCR_SWITCH_ENV}=off)`, languages: [], missing: [] };
  }
  if (!probed || !probed.ok) {
    const error = probed && !probed.ok ? probed.error : 'not probed';
    return { enabled: false, switchedOff: false, reason: `tesseract is not available: ${error}`, languages: [], missing: [] };
  }
  const languages = configured.filter((lang) => probed.installed.includes(lang));
  const missing = configured.filter((lang) => !probed.installed.includes(lang));
  if (languages.length === 0) {
    return {
      enabled: false, switchedOff: false, languages, missing, installed: probed.installed,
      reason: `tesseract has none of the configured languages (${missing.join(', ')})`,
    };
  }
  return {
    enabled: true, switchedOff: false, languages, missing, installed: probed.installed,
    reason: `tesseract with ${languages.join('+')}`,
  };
}

/** Decide OCR availability now, without the cache. Exported for tests. */
export async function detectOcr(
  env: NodeJS.ProcessEnv,
  configured: string[],
  probe: OcrProbe = defaultProbe
): Promise<OcrStatus> {
  if (ocrSwitch(env) === 'off') return decide(true, configured, null);
  return decide(false, configured, await runProbe(probe));
}

/** Set once `nice` was checked: OCR and page rendering ask for low priority on every run. */
let niceChecked = false;

function logStatus(status: OcrStatus): void {
  if (!niceChecked) {
    niceChecked = true;
    if (!niceAvailable()) {
      logger.debug('FileSearchOcr', '"nice" is not on PATH: OCR and page rendering run at normal priority');
    }
  }
  if (status.enabled) {
    logger.info('FileSearchOcr', `OCR is on: ${status.reason}`);
    if (status.missing.length > 0) {
      logger.warn('FileSearchOcr', `OCR languages without installed language data are skipped: ${status.missing.join(', ')}`);
    }
  } else if (status.switchedOff) {
    logger.info('FileSearchOcr', `OCR is off: ${status.reason}`);
  } else {
    logger.warn('FileSearchOcr', `OCR is off: ${status.reason}; PDF pages without a text layer stay empty`);
  }
}

interface ProbeState {
  /** The configured list the probe was started for. */
  key: string;
  promise: Promise<ProbeResult>;
  result?: ProbeResult;
  settledAt?: number;
}

let probeState: ProbeState | null = null;
let lastLogged: string | null = null;

/** The configured OCR languages (file_search.parsing.ocr.languages, validated). */
function configuredLanguages(): string[] {
  return getFileSearchConfig().parsing.ocr.languages;
}

/** The probe result to decide with: the running probe, the kept one, or a new one (see the module comment). */
function currentProbe(key: string): Promise<ProbeResult> {
  const s = probeState;
  if (s && !s.result) return s.promise; // one probe in flight at a time
  if (s && s.result && s.key === key && (s.result.ok || Date.now() - (s.settledAt ?? 0) < PROBE_RETRY_MS)) {
    return s.promise;
  }
  const state: ProbeState = { key, promise: Promise.resolve({ ok: false, error: 'not probed' }) };
  state.promise = runProbe(defaultProbe).then((result) => {
    state.result = result;
    state.settledAt = Date.now();
    return result;
  });
  probeState = state;
  return state.promise;
}

/** OCR availability for this process and the current configuration (see the module comment). */
export async function getOcrStatus(): Promise<OcrStatus> {
  const configured = configuredLanguages();
  const status =
    ocrSwitch() === 'off' ? decide(true, configured, null) : decide(false, configured, await currentProbe(configured.join('+')));
  const signature = JSON.stringify([status.enabled, status.switchedOff, status.languages, status.missing, status.reason]);
  if (signature !== lastLogged) {
    lastLogged = signature;
    logStatus(status);
  }
  return status;
}

/** True when this gateway may OCR PDF pages (see the module comment). */
export async function isOcrEnabled(): Promise<boolean> {
  return (await getOcrStatus()).enabled;
}

/** The languages OCR runs with (build `-l` as join('+')); empty when OCR is off. */
export async function getOcrLanguages(): Promise<string[]> {
  return (await getOcrStatus()).languages;
}

/** Forget the cached probe and decision. Tests only. */
export function resetOcrStatusForTests(): void {
  probeState = null;
  lastLogged = null;
  switchWarnedFor = null;
}
