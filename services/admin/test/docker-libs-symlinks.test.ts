/**
 * Admin image @libs symlinks test
 *
 * The admin image resolves `@libs/<name>` through one symlink per lib under
 * /app/node_modules/@libs (see docker/admin.Dockerfile) and then checks each one in a
 * `for lib in …` loop. A lib the admin's code imports but the Dockerfile does not link
 * builds fine and type-checks, and then the admin fails at boot on Docker and Kyma.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC_DIR = path.join(REPO_ROOT, 'services', 'admin', 'src');
const df = fs.readFileSync(path.join(REPO_ROOT, 'docker', 'admin.Dockerfile'), 'utf8');

/** Every file under `dir` whose name ends in .ts or .js. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|js)$/.test(entry.name) ? [full] : [];
  });
}

/** The names of every `@libs/<name>` the admin's src imports. */
function importedLibs(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(SRC_DIR)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/['"]@libs\/([a-z0-9-]+)/g)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

/** The libs named in the Dockerfile's `for lib in … ; do` check loop. */
function checkedLibs(): string[] {
  const loop = df.match(/for lib in ([^;]+);\s*do/);
  return loop ? loop[1].trim().split(/\s+/) : [];
}

describe('Admin image @libs symlinks', () => {
  const libs = importedLibs();

  it('finds the libs the admin imports', () => {
    expect(libs).toEqual(expect.arrayContaining(['logger', 'trace-seal']));
  });

  it.each(libs)('links @libs/%s to the libs build output', (lib) => {
    expect(df).toContain(`ln -sf /app/libs/dist/${lib} node_modules/@libs/${lib} `);
  });

  it.each(libs)('checks that @libs/%s resolves', (lib) => {
    expect(checkedLibs()).toContain(lib);
  });
});
