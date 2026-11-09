import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type UpgradePolicy = {
  minUpgradeFrom: string;
  postgresImage: string;
  storageLayoutChange: boolean;
};

export type MaterializedKit = {
  root: string;
  policy: UpgradePolicy;
  cleanup(): Promise<void>;
};

const KIT_MODULES_ENV = 'SAIL_PROXY_KIT_MODULES';

// dist/upgrade/kit.js -> package root
const packageRoot = path.resolve(__dirname, '..', '..');

/**
 * Copies the package's release kit to a temp directory so that release's setup scripts can run
 * from there (their paths are relative to their own location). The scripts find inquirer,
 * js-yaml and commander through SAIL_PROXY_KIT_MODULES, which points at this package's
 * node_modules for as long as the kit exists.
 */
export async function materializeKit(): Promise<MaterializedKit> {
  const kitDir = path.join(packageRoot, 'release-kit');
  if (!fs.existsSync(path.join(kitDir, 'upgrade-policy.json'))) {
    throw new Error(`This installation carries no release kit (${kitDir} is missing). Reinstall @st-gr/sail-proxy.`);
  }
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sail-proxy-kit-'));
  const previous = process.env[KIT_MODULES_ENV];
  try {
    await fs.promises.cp(kitDir, root, { recursive: true });
    const policy = JSON.parse(await fs.promises.readFile(path.join(root, 'upgrade-policy.json'), 'utf8')) as UpgradePolicy;
    process.env[KIT_MODULES_ENV] = path.join(packageRoot, 'node_modules');
    return {
      root,
      policy,
      async cleanup() {
        if (previous === undefined) delete process.env[KIT_MODULES_ENV];
        else process.env[KIT_MODULES_ENV] = previous;
        await fs.promises.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    throw error;
  }
}
