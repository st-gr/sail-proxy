import fs from 'fs';
import path from 'path';

/**
 * Where the admin's api_config.json is, in the order file-config-service uses: cwd/config, cwd, and
 * last the source-relative path for local runs from src/. A path relative to __dirname alone points
 * into dist/ once compiled, so every Docker and Kyma deployment (started from /app/services/admin,
 * where the ConfigMap mounts the file) missed it. Only regular files count - a failed bind mount
 * leaves a directory with the file's name.
 */
export function findApiConfigPath(): string | null {
  const candidates = [
    path.join(process.cwd(), 'config', 'api_config.json'),
    path.join(process.cwd(), 'api_config.json'),
    path.resolve(__dirname, '../../api_config.json'),
  ];
  return candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) ?? null;
}

/** The `api_config` block of that file; throws when there is no file or it does not parse. */
export function readApiConfigBlock(): any {
  const p = findApiConfigPath();
  if (!p) throw new Error('api_config.json not found (looked in cwd/config, cwd and services/admin)');
  return JSON.parse(fs.readFileSync(p, 'utf8')).api_config ?? {};
}
