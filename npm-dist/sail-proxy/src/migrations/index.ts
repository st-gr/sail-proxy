import { promises as fsp } from 'fs';
import { join } from 'path';

/** Version of the file layout in the config folder (<configDir>/format-version; missing = 1). */
export const CONFIG_FORMAT = 1;

export type Migration = { from: number; to: number; run(configDir: string): Promise<void> };

/** Ordered file migrations. Each runs on the live folder; a failure rolls everything back. */
export const MIGRATIONS: Migration[] = [];

export class ConfigMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigMigrationError';
  }
}

const VERSION_FILE = 'format-version';
// Never copied nor restored: logs are large and not config, backups hold the upgrade bundles
// and this function's own copies.
const EXCLUDED = new Set(['logs', 'backups']);

async function topLevel(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir)).filter((n) => !EXCLUDED.has(n));
}

async function readVersion(configDir: string): Promise<number> {
  let raw: string;
  try {
    raw = await fsp.readFile(join(configDir, VERSION_FILE), 'utf-8');
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return 1;
    throw new ConfigMigrationError(`cannot read ${VERSION_FILE}: ${e?.message ?? e}`);
  }
  const v = raw.trim();
  if (!/^\d+$/.test(v) || Number(v) < 1) {
    throw new ConfigMigrationError(`${VERSION_FILE} is not a format number: "${v.slice(0, 40)}"`);
  }
  return Number(v);
}

async function copyInto(srcDir: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  // Entry by entry: the backup lives inside configDir, which fs.cp refuses to copy wholesale.
  for (const name of await topLevel(srcDir)) {
    await fsp.cp(join(srcDir, name), join(destDir, name), { recursive: true, preserveTimestamps: true });
  }
}

async function restore(backup: string, configDir: string): Promise<void> {
  for (const name of await topLevel(configDir)) {
    await fsp.rm(join(configDir, name), { recursive: true, force: true });
  }
  await copyInto(backup, configDir);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Bring the config folder to the newest file format, all or nothing: before the first migration
 * the folder (minus logs/ and backups/) is copied to <configDir>/backups/format-<from>-<ts>/;
 * any error restores that copy and throws ConfigMigrationError. A folder written by a newer
 * sail-proxy is refused untouched.
 */
export async function migrateConfigDir(
  configDir: string,
  migrations: Migration[] = MIGRATIONS
): Promise<{ from: number; to: number; backup?: string }> {
  const latest = Math.max(CONFIG_FORMAT, ...migrations.map((m) => m.to));
  const from = await readVersion(configDir);
  if (from > latest) {
    throw new ConfigMigrationError(
      `this config was written by a newer sail-proxy (config format ${from}, this version understands ${latest}). Update sail-proxy.`
    );
  }

  const steps: Migration[] = [];
  let at = from;
  for (;;) {
    const next = migrations.find((m) => m.from === at);
    if (!next) break;
    steps.push(next);
    at = next.to;
  }
  if (at !== latest && at !== from) {
    throw new ConfigMigrationError(`no migration path from config format ${at} to ${latest}`);
  }

  if (steps.length === 0) {
    if (from === 1 && at === 1) {
      // Nothing migrated: the marker is a convenience, an unwritable folder must still start.
      await writeVersion(configDir, 1).catch(() => undefined);
    }
    return { from, to: at };
  }

  const backup = join(configDir, 'backups', `format-${from}-${stamp()}`);
  try {
    await copyInto(configDir, backup);
  } catch (e: any) {
    await fsp.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    throw new ConfigMigrationError(`could not back up the config before migrating: ${e?.message ?? e}`);
  }

  try {
    for (const m of steps) await m.run(configDir);
    await writeVersion(configDir, at);
  } catch (e: any) {
    try {
      await restore(backup, configDir);
    } catch (re: any) {
      throw new ConfigMigrationError(
        `migration failed (${e?.message ?? e}) and restoring the copy failed (${re?.message ?? re}); your files are in ${backup}`
      );
    }
    throw new ConfigMigrationError(`migration failed, config restored unchanged: ${e?.message ?? e}`);
  }
  return { from, to: at, backup };
}

async function writeVersion(configDir: string, v: number): Promise<void> {
  await fsp.writeFile(join(configDir, VERSION_FILE), `${v}\n`);
}
