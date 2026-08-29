import { existsSync, accessSync, constants } from 'fs';
import { join, delimiter } from 'path';

/** Cross-platform, dependency-free PATH lookup for a harness binary. */
export function resolveBinary(name: string, installHint: string): string {
  const isWindows = process.platform === 'win32';
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (!existsSync(candidate)) continue;
      if (isWindows) return candidate;
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // exists but not executable; keep searching
      }
    }
  }
  throw new Error(`${name} not found on PATH. ${installHint}`);
}
