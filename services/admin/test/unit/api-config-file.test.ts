/**
 * sapCapacityService and clientIp read api_config.json at `path.resolve(__dirname, '../../api_config.json')`.
 * That is services/admin/api_config.json only when running from src/; the compiled module lives in
 * dist/services/admin/src/..., where the same path points into dist/ and nothing is there. In every
 * Docker and Kyma deployment both logged ENOENT (or silently fell back) and ran without the file:
 * the SAP billing factors and platform.billing.productive, and platform.security.trust_forwarded_for.
 * The containers start the admin from /app/services/admin, where the ConfigMap mounts the file, so
 * the lookup follows file-config-service: cwd/config, cwd, then the source-relative path for dev.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findApiConfigPath, readApiConfigBlock } from '../../src/utils/apiConfigFile';

describe('findApiConfigPath', () => {
  const originalCwd = process.cwd();
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-config-')); process.chdir(dir); });
  afterEach(() => { process.chdir(originalCwd); fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, apiConfig: object) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify({ api_config: apiConfig }));
  };

  it('finds the file in the working directory the containers start from', () => {
    write('api_config.json', { platform: { billing: { productive: true } } });
    expect(fs.realpathSync(findApiConfigPath()!)).toBe(fs.realpathSync(path.join(dir, 'api_config.json')));
    expect(readApiConfigBlock().platform.billing.productive).toBe(true);
  });

  it('prefers cwd/config/api_config.json, like file-config-service', () => {
    write('api_config.json', { marker: 'root' });
    write('config/api_config.json', { marker: 'config' });
    expect(readApiConfigBlock().marker).toBe('config');
  });

  it('skips a directory that carries the file name (a failed bind mount) instead of throwing EISDIR', () => {
    fs.mkdirSync(path.join(dir, 'api_config.json'));
    write('config/api_config.json', { marker: 'config' });
    expect(readApiConfigBlock().marker).toBe('config');
  });

  it('falls back to services/admin/api_config.json when the working directory has none (local dev)', () => {
    expect(findApiConfigPath()).toBe(path.resolve(__dirname, '../../api_config.json'));
  });
});
