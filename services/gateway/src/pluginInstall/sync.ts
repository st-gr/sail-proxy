import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isCompatible, parsePluginPackage, validateManifest } from '@libs/plugin-package';
import type { PluginManifest } from '@libs/plugin-package';
import { INSTALLED_MARKER } from './marker';

export type WantedPlugin = { id: string; version: string; sha256: string };

/**
 * A list with a known gap: `unreadable` names packages the source holds but could
 * not read, so their ids are unknown and any installed plugin may be one of them.
 */
export type PackageListing = { wanted: WantedPlugin[]; unreadable: { name: string; error: string }[] };

/** `list` rejects on any failure and answers an empty list only for a real empty answer. */
export type PackageSource = {
  list(): Promise<WantedPlugin[] | PackageListing>;
  fetch(p: WantedPlugin): Promise<Uint8Array>;
};

export type SyncResult = {
  changed: boolean;
  plugins: { id: string; version: string; state: 'installed' | 'failed' | 'incompatible'; error?: string }[];
  listFailed?: string;
  unpackDisabledReason?: string;
  /** Sync-level problems (bad input, unusable folders); never a reason to reject. */
  error?: string;
};

export type SyncOptions = { pluginsDir: string; gatewayVersion: string; unpackAllowed: boolean };

export const UNPACK_DISABLED_DEV = 'a local development gateway does not unpack installed plugins';

const TMP_DIR = '.tmp';
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
// Ids cannot contain a dot, so `old.<id>.<rand>` is unambiguous.
const OLD_COPY = /^old\.([a-zA-Z0-9_-]+)\.[0-9a-f]{12}$/;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const random = (): string => crypto.randomBytes(6).toString('hex');

type Marker = { version: string; sha256: string };

/** An unreadable marker counts as "installed, unknown version" so it gets replaced. */
function readMarker(dir: string): Marker {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, INSTALLED_MARKER), 'utf8'));
    return { version: String(raw?.version ?? ''), sha256: String(raw?.sha256 ?? '') };
  } catch {
    return { version: '', sha256: '' };
  }
}

/** Installed plugin folders: real directories that contain the marker, nothing else. */
function scanInstalled(pluginsDir: string): Map<string, Marker> {
  const found = new Map<string, Marker>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === TMP_DIR) continue;
    const dir = path.join(pluginsDir, entry.name);
    if (fs.existsSync(path.join(dir, INSTALLED_MARKER))) found.set(entry.name, readMarker(dir));
  }
  return found;
}

/** The manifest of a plugin folder, shipped or installed; null unless it validates and names this id. */
export function readPluginManifest(pluginsDir: string, id: string): PluginManifest | null {
  if (!ID_PATTERN.test(id)) return null;
  try {
    const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(pluginsDir, id, 'manifest.json'), 'utf8')));
    return manifest.id === id ? manifest : null;
  } catch {
    return null;
  }
}

/** The installed plugin's manifest; null unless the marker is there and the manifest validates. */
export function readInstalledManifest(pluginsDir: string, id: string): PluginManifest | null {
  if (!ID_PATTERN.test(id) || !fs.existsSync(path.join(pluginsDir, id, INSTALLED_MARKER))) return null;
  return readPluginManifest(pluginsDir, id);
}

const hasEntry = (dir: string): boolean => fs.existsSync(path.join(dir, 'index.js'));

/**
 * Put back any old copy a crashed swap left in `.tmp` when its plugin folder is
 * missing, then empty the rest. Best effort: problems are returned, not thrown.
 */
function recoverTmp(pluginsDir: string): { problems: string[]; unusable?: string } {
  const problems: string[] = [];
  let unusable: string | undefined;
  const tmpRoot = path.join(pluginsDir, TMP_DIR);
  const kept = new Set<string>();
  try {
    fs.mkdirSync(tmpRoot, { recursive: true });
    for (const name of fs.readdirSync(tmpRoot)) {
      const match = OLD_COPY.exec(name);
      if (!match) continue;
      const from = path.join(tmpRoot, name);
      const to = path.join(pluginsDir, match[1]);
      try {
        if (!fs.existsSync(to) && fs.existsSync(path.join(from, INSTALLED_MARKER))) fs.renameSync(from, to);
      } catch (error) {
        kept.add(name); // possibly the only good copy: leave it for the next sync
        problems.push(`could not restore ${name}: ${message(error)}`);
      }
    }
    for (const name of fs.readdirSync(tmpRoot)) {
      if (kept.has(name)) continue;
      try {
        fs.rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
      } catch (error) {
        problems.push(`could not clear .tmp/${name}: ${message(error)}`);
      }
    }
  } catch (error) {
    unusable = `plugins/.tmp is unusable: ${message(error)}`;
  }
  return { problems, ...(unusable ? { unusable } : {}) };
}

/** Rename a live folder into `.tmp` (atomic), then delete it; a failed delete is not fatal. */
function moveAndDelete(pluginsDir: string, id: string, prefix: string): void {
  const aside = path.join(pluginsDir, TMP_DIR, `${prefix}.${id}.${random()}`);
  fs.renameSync(path.join(pluginsDir, id), aside);
  try {
    fs.rmSync(aside, { recursive: true, force: true });
  } catch {
    // left in .tmp; the next sync retries
  }
}

const wellFormed = (w: unknown): w is WantedPlugin =>
  typeof w === 'object' &&
  w !== null &&
  typeof (w as WantedPlugin).id === 'string' &&
  typeof (w as WantedPlugin).version === 'string' &&
  typeof (w as WantedPlugin).sha256 === 'string';

/**
 * Bring `plugins/<id>/` folders in line with the wanted list. Does not reload
 * and does not take the plugin lock. Always returns a result; it never rejects.
 *
 * The only places this yields are `source.list` and `source.fetch`. Everything
 * between them, each removal and each unpack-and-swap, is synchronous, so a reload
 * running during a sync can never see a half-replaced folder. Keep it that way:
 * the caller relies on it to run the sync outside the plugin lock.
 */
export async function syncPlugins(source: PackageSource, opts: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = { changed: false, plugins: [] };
  try {
    await run(source, opts, result);
  } catch (error) {
    result.error = [result.error, message(error)].filter(Boolean).join('; ');
  }
  return result;
}

async function run(source: PackageSource, opts: SyncOptions, result: SyncResult): Promise<void> {
  if (!opts.unpackAllowed) {
    result.unpackDisabledReason = UNPACK_DISABLED_DEV;
    return;
  }
  if (!isCompatible({ gateway: '*' }, opts.gatewayVersion)) {
    result.error = `invalid gateway version "${opts.gatewayVersion}"`;
    return;
  }
  const { pluginsDir, gatewayVersion } = opts;

  const { problems, unusable } = recoverTmp(pluginsDir);
  const tmpProblems = [...problems, ...(unusable ? [unusable] : [])];
  if (tmpProblems.length) result.error = tmpProblems.join('; ');

  let wanted: WantedPlugin[];
  let unreadable: PackageListing['unreadable'];
  try {
    const answer = (await source.list()) as unknown;
    const listing = (Array.isArray(answer) ? { wanted: answer, unreadable: [] } : answer) as Partial<PackageListing> | null;
    const list: unknown = listing?.wanted;
    const gaps: unknown = listing?.unreadable;
    if (!Array.isArray(list) || !list.every(wellFormed) || !Array.isArray(gaps)) throw new Error('the plugin list is malformed');
    if (new Set(list.map(w => w.id)).size !== list.length) throw new Error('the plugin list holds a duplicate id');
    wanted = list;
    unreadable = gaps;
  } catch (error) {
    result.listFailed = message(error);
    return;
  }

  const tmpRoot = path.join(pluginsDir, TMP_DIR);
  const valid = wanted.filter(w => ID_PATTERN.test(w.id));
  const wantedIds = new Set(valid.map(w => w.id));
  const installed = scanInstalled(pluginsDir);
  // Nothing to do: a read-only install without plugins is no problem to report.
  if (unusable && wanted.length === 0 && installed.size === 0 && unreadable.length === 0) {
    if (problems.length) result.error = problems.join('; ');
    else delete result.error;
  }

  for (const gap of unreadable) {
    result.plugins.push({
      id: gap.name,
      version: '',
      state: 'failed',
      error: `could not read this package, so no installed plugin is removed on this run: ${gap.error}`,
    });
  }

  for (const [id, marker] of installed) {
    // The unreadable package may be this plugin: only a complete answer removes anything.
    if (wantedIds.has(id) || unreadable.length > 0) continue;
    try {
      moveAndDelete(pluginsDir, id, 'gone');
      result.changed = true;
    } catch (error) {
      result.plugins.push({ id, version: marker.version, state: 'failed', error: `could not remove: ${message(error)}` });
    }
  }

  for (const w of wanted) {
    if (!valid.includes(w)) {
      result.plugins.push({ id: w.id, version: w.version, state: 'failed', error: 'invalid plugin id' });
      continue;
    }
    const finalDir = path.join(pluginsDir, w.id);
    const previous = installed.get(w.id);
    const removeCurrent = () => {
      moveAndDelete(pluginsDir, w.id, 'gone');
      result.changed = true;
    };
    let fresh: string | undefined;
    try {
      if (fs.existsSync(finalDir) && !previous) {
        throw new Error(`plugins/${w.id} exists and is not an installed plugin`);
      }
      const current = previous ? readInstalledManifest(pluginsDir, w.id) : null;
      const intact = current !== null && hasEntry(finalDir);
      if (previous && previous.sha256 === w.sha256 && intact) {
        if (!isCompatible(current, gatewayVersion)) {
          removeCurrent();
          result.plugins.push({ id: w.id, version: w.version, state: 'incompatible', error: `requires gateway ${current.gateway}` });
        } else {
          result.plugins.push({ id: w.id, version: w.version, state: 'installed' });
        }
        continue;
      }

      const bytes = await source.fetch(w);
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== w.sha256) throw new Error('sha256 of the fetched package does not match');
      const { manifest, files } = parsePluginPackage(bytes);
      if (manifest.id !== w.id) throw new Error(`package id "${manifest.id}" does not match wanted id "${w.id}"`);
      if (!isCompatible(manifest, gatewayVersion)) {
        // A working previous version stays; a damaged or no-longer-fitting one goes.
        if (previous && !(intact && isCompatible(current, gatewayVersion))) removeCurrent();
        result.plugins.push({ id: w.id, version: w.version, state: 'incompatible', error: `requires gateway ${manifest.gateway}` });
        continue;
      }

      fresh = path.join(tmpRoot, `${w.id}-${random()}`);
      fs.mkdirSync(fresh, { recursive: true });
      const freshRoot = path.resolve(fresh) + path.sep;
      for (const file of files) {
        const target = path.resolve(fresh, file.path);
        if (!target.startsWith(freshRoot)) throw new Error(`unsafe path in package: ${file.path}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.data);
      }
      fs.writeFileSync(path.join(fresh, INSTALLED_MARKER), JSON.stringify({ version: manifest.version, sha256: w.sha256 }));

      // Swap: a crash leaves the old folder, the new one, or none (old copy restored by the next sync).
      const old = path.join(tmpRoot, `old.${w.id}.${random()}`);
      const hadOld = fs.existsSync(finalDir);
      if (hadOld) fs.renameSync(finalDir, old);
      try {
        fs.renameSync(fresh, finalDir);
      } catch (error) {
        if (hadOld) fs.renameSync(old, finalDir);
        throw error;
      }
      fresh = undefined;
      result.changed = true;
      if (hadOld) {
        try {
          fs.rmSync(old, { recursive: true, force: true });
        } catch {
          // left in .tmp; the next sync clears it
        }
      }
      result.plugins.push({ id: w.id, version: w.version, state: 'installed' });
    } catch (error) {
      if (fresh) {
        try {
          fs.rmSync(fresh, { recursive: true, force: true });
        } catch {
          // left in .tmp; the next sync clears it
        }
      }
      result.plugins.push({ id: w.id, version: w.version, state: 'failed', error: message(error) });
    }
  }
}
