import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import semver from 'semver';
import { parsePluginPackage, PLUGIN_PACKAGE_LIMITS } from '@libs/plugin-package';
import { getDefaultLogger } from '@libs/logger';
import type { PackageListing, PackageSource, WantedPlugin } from './sync';

const logger = getDefaultLogger();
const LOG = 'PluginInstall';

type Candidate = { file: string; wanted: WantedPlugin };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One zip file into a candidate, or the reason (logged) it cannot be used. */
function readCandidate(dir: string, name: string): Candidate | { error: string } {
  const file = path.join(dir, name);
  try {
    const size = fs.statSync(file).size;
    if (size > PLUGIN_PACKAGE_LIMITS.maxCompressedBytes) {
      const error = `over the ${PLUGIN_PACKAGE_LIMITS.maxCompressedBytes} byte package limit`;
      logger.warn(LOG, `Ignoring ${name}: ${error}`);
      return { error };
    }
    const bytes = fs.readFileSync(file);
    const { manifest } = parsePluginPackage(bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return { file, wanted: { id: manifest.id, version: manifest.version, sha256 } };
  } catch (error) {
    logger.warn(LOG, `Ignoring ${name}: ${message(error)}`);
    return { error: message(error) };
  }
}

/**
 * Packages from a folder of zip files: the standalone CLI's store. Only `*.zip`
 * at the top level counts; everything else is logged and skipped. A zip that cannot
 * be read or has a bad manifest is `unreadable`: its id is unknown, so the sync must
 * not take it for a removed plugin. Of two zips of one id the higher version wins; on
 * the same version the first file name does, so directory order never decides. A
 * missing folder is an empty list, any other read failure rejects so that it is not
 * mistaken for one.
 */
export function createFolderSource(dir: string): PackageSource {
  let files = new Map<string, string>();
  const key = (w: WantedPlugin) => `${w.id}\u0000${w.version}\u0000${w.sha256}`;

  return {
    async list() {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { wanted: [], unreadable: [] };
        throw error;
      }

      const best = new Map<string, Candidate>();
      const unreadable: PackageListing['unreadable'] = [];
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) {
          logger.info(LOG, `Ignoring ${entry.name} in ${dir}: not a .zip file`);
          continue;
        }
        const candidate = readCandidate(dir, entry.name);
        if ('error' in candidate) {
          unreadable.push({ name: entry.name, error: candidate.error });
          continue;
        }
        const current = best.get(candidate.wanted.id);
        if (!current) {
          best.set(candidate.wanted.id, candidate);
          continue;
        }
        const newer = semver.gt(candidate.wanted.version, current.wanted.version);
        const [kept, dropped] = newer ? [candidate, current] : [current, candidate];
        logger.warn(
          LOG,
          `Two packages of plugin ${kept.wanted.id}: using ${path.basename(kept.file)} (${kept.wanted.version}), ` +
            `ignoring ${path.basename(dropped.file)} (${dropped.wanted.version})`,
        );
        best.set(candidate.wanted.id, kept);
      }

      files = new Map([...best.values()].map(c => [key(c.wanted), c.file]));
      return { wanted: [...best.values()].map(c => c.wanted), unreadable };
    },

    async fetch(wanted) {
      const file = files.get(key(wanted));
      if (!file) throw new Error(`no package listed for ${wanted.id} ${wanted.version}`);
      return fs.readFileSync(file);
    },
  };
}
