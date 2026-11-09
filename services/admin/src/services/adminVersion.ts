import * as fs from 'fs';
import * as path from 'path';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

let cached: string | undefined;

/**
 * The admin's own version, read from the first package.json named `admin` found walking up from
 * `startDir`, as the gateway reads its own (services/gateway/src/pluginInstall/gatewayVersion.ts).
 * `npm_package_version` is unset under plain `node`, so it cannot be used. Admin and gateway ship
 * together, so this is the version a plugin's `gateway` range is checked against at upload and enable.
 */
export function readAdminVersion(startDir: string = __dirname): string {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && pkg.name === 'admin' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // missing or unreadable: keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  logger.error('PluginStore', `No admin package.json found above ${startDir}; using version 0.0.0`);
  return '0.0.0';
}

export function getAdminVersion(): string {
  if (cached === undefined) cached = readAdminVersion();
  return cached;
}
