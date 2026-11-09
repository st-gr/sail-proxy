import * as fs from 'fs';
import * as path from 'path';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

/**
 * The gateway's own version, read from the first package.json named `gateway`
 * found walking up from `startDir`. `process.env.npm_package_version` is unset
 * under plain `node`, so it cannot be used.
 */
export function getGatewayVersion(startDir: string = __dirname): string {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (pkg && pkg.name === 'gateway' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // missing or unreadable: keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  logger.error('PluginLoader', `No gateway package.json found above ${startDir}; using version 0.0.0`);
  return '0.0.0';
}
