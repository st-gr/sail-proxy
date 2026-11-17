import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir, getTemplatePath } from './paths';
import { displayPathOf, missingShippedEntries, previewOf, ShippedEntry } from './shippedDefaults';

export interface DefaultsNoticeOptions {
  /** The installed version. */
  current: string;
  configDir?: string;
  /** The default configuration this version ships. */
  templatePath?: string;
}

/** Settings (JSON pointers) that only the Docker and Kyma deployments use: in the standalone CLI they do nothing, so the notice never names them. */
const DOCKER_AND_KYMA_ONLY = ['/api_config/observability/gateway_log', '/api_config/observability/payload_capture'];

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The entries without the Docker/Kyma-only settings: an entry at or below one is dropped, and a
 * missing parent that holds one is kept with that setting taken out of its value.
 */
function withoutDockerAndKymaOnly(entries: ShippedEntry[]): ShippedEntry[] {
  const kept: ShippedEntry[] = [];
  for (const entry of entries) {
    if (DOCKER_AND_KYMA_ONLY.some((path) => entry.pointer === path || entry.pointer.startsWith(`${path}/`))) continue;
    let value = entry.value;
    for (const path of DOCKER_AND_KYMA_ONLY) {
      if (entry.kind !== 'key' || !path.startsWith(`${entry.pointer}/`)) continue;
      const keys = path.slice(entry.pointer.length + 1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
      const copy = JSON.parse(JSON.stringify(value));
      let node: any = copy;
      for (const key of keys.slice(0, -1)) node = isObject(node) ? node[key] : undefined;
      if (isObject(node)) delete node[keys[keys.length - 1]];
      value = copy;
    }
    kept.push(value === entry.value ? entry : { ...entry, value });
  }
  return kept;
}

/** The version whose defaults were last compared with the user's file, if any. */
function comparedVersion(record: string): string | undefined {
  try {
    const version = JSON.parse(readFileSync(record, 'utf-8')).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The settings this version's default configuration holds and the user's api_config.json lacks,
 * as a message, or null. "sail-proxy config" writes that file once and an update keeps it, so
 * settings a later version ships never reach it; a value that only differs is the user's own.
 *
 * The files are compared once per installed version, remembered in <configDir>/defaults-check.json:
 * without that record (a config an older version wrote) or with another version in it (the first
 * start after an update). It only tells, it never changes the file, and it never throws: a file
 * that is missing or cannot be read means no message and no record.
 */
export function defaultsNotice(opts: DefaultsNoticeOptions): string | null {
  try {
    const configDir = opts.configDir ?? getConfigDir();
    const record = join(configDir, 'defaults-check.json');
    if (comparedVersion(record) === opts.current) return null;

    const own = join(configDir, 'api_config.json');
    const shipped = opts.templatePath ?? getTemplatePath('api_config.template.json');
    const entries = withoutDockerAndKymaOnly(missingShippedEntries(JSON.parse(readFileSync(own, 'utf-8')), JSON.parse(readFileSync(shipped, 'utf-8'))));
    try {
      writeFileSync(record, JSON.stringify({ version: opts.current }));
    } catch { /* not remembered: the next start compares again */ }
    if (entries.length === 0) return null;

    return [
      `Your api_config.json lacks ${entries.length} ${entries.length === 1 ? 'setting' : 'settings'} of this version's default configuration:`,
      ...entries.map((entry) =>
        `  - ${displayPathOf(entry) || 'api_config'}${entry.kind === 'listEntry' ? ' (list entry)' : ''}: ${previewOf(entry.value)}`),
      'An update keeps your file as it is. To use a setting, copy it from the default file and restart the gateway.',
      `  Your file:    ${own}`,
      `  Default file: ${shipped}`,
      'This is shown once per installed version.'
    ].join('\n');
  } catch {
    return null;
  }
}

/** The message for the installed version, read from this package's package.json. */
export function checkDefaultsNotice(extra: Partial<DefaultsNoticeOptions> = {}): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return defaultsNotice({ current: pkg.version, ...extra });
  } catch {
    return null;
  }
}
