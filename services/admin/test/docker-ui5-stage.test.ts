/**
 * Admin image UI5 stage test
 *
 * The cockpit apps' UI5 build output does not depend on the target architecture. The admin image
 * builds it once, natively on the build host (`--platform=$BUILDPLATFORM`), and every platform's
 * production stage copies the finished app/ tree from that stage. Built per platform, the emulated
 * architecture spent about two hours in the UI5 builds of a multi-arch release build.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const df = fs.readFileSync(path.join(REPO_ROOT, 'docker', 'admin.Dockerfile'), 'utf8');
const lines = df.split('\n');
const APP_DIR = path.join(REPO_ROOT, 'services', 'admin', 'app');
const uiApps = fs.readdirSync(APP_DIR).filter((d) => fs.existsSync(path.join(APP_DIR, d, 'ui5.yaml')));

/** The lines of the stage named `name`, from its FROM line up to the next FROM line. */
function stage(name: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^FROM .* AS ${name}$`).test(l));
  if (start < 0) return [];
  const next = lines.findIndex((l, i) => i > start && /^FROM /.test(l));
  return lines.slice(start, next < 0 ? lines.length : next);
}

describe('Admin image UI5 stage', () => {
  it('builds UI5 once on the build host: the ui5 stage is FROM --platform=$BUILDPLATFORM node:24-alpine', () => {
    expect(df).toMatch(/^FROM --platform=\$BUILDPLATFORM node:24-alpine AS ui5$/m);
  });

  it('finds the apps by their ui5.yaml: no app is named in the Dockerfile', () => {
    const ui5 = stage('ui5').join('\n');
    for (const app of uiApps) expect(ui5).not.toMatch(new RegExp(`\\b${app}\\b`));
    expect(df).not.toContain('ui5 build');
    expect(ui5).toContain('app/*/ui5.yaml');
  });

  it('runs every app\'s build:docker script in the ui5 stage, one app after the other', () => {
    // Parallel builds were measured in 2026-10: 2 jobs saved 5% of the UI5 step, 3 jobs got
    // buildkitd OOM-killed in an 8 GiB VM, and CI builds on a 2 vCPU / 8 GB runner.
    const ui5 = stage('ui5').join('\n');
    expect(ui5).toMatch(/for yaml in app\/\*\/ui5\.yaml;[^]*?pnpm install && pnpm run build:docker/);
    expect(df).not.toMatch(/xargs|UI5_BUILD_JOBS/);
    expect(df.split('build:docker').length - 1).toBe(ui5.split('build:docker').length - 1);
  });

  it('every app with a ui5.yaml has a build:docker script that builds its whole framework into dist', () => {
    expect(uiApps.length).toBeGreaterThan(0);
    for (const app of uiApps) {
      const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, app, 'package.json'), 'utf8'));
      expect([app, pkg.scripts?.['build:docker']]).toEqual([
        app,
        expect.stringMatching(/^ui5 build --all( --exclude-dependency \S+)* --clean-dest --dest dist$/),
      ]);
    }
  });

  it('the production stage takes app/ from the ui5 stage through the tar bind', () => {
    expect(stage('production').join('\n')).toContain(
      '--mount=type=bind,from=ui5,source=/app/services/admin/app,target=/tmp/source-app'
    );
    expect(df).not.toContain('from=build,source=/app/services/admin/app');
  });

  it('the ui5 stage fails on a missing central resources folder or a missing sap-ui-core rewrite', () => {
    const ui5 = stage('ui5').join('\n');
    expect(ui5).toMatch(/\/admin\/resources\/sap-ui-core\.js[^\n]*\n[^\n]*ERROR: app\/\$app\/dist\/index\.html[^\n]*exit 1/);
    expect(ui5).toMatch(/\[ ! -d app\/resources \][^\n]*ERROR: app\/resources[^\n]*exit 1/);
  });
});
