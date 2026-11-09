/**
 * What a cockpit app needs outside its folder. Each of these fails only in a container or in CI, while
 * local development works, so they are pinned here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

describe('nginx template', () => {
  const template = read('docker', 'nginx', 'templates', 'nginx.conf.tmpl');

  it('has the app in the three name lists and its webapp rewrite', () => {
    const listOf = (start: string) => template.split('\n').find((line) => line.includes(start))!;
    expect(listOf('location ~* ^/admin/app/(shell|')).toContain('|plugins-app)');
    expect(listOf('location ~ ^/(shell|')).toContain('|plugins-app)');
    expect(listOf('location ~ ^/(usage-analytics|')).toContain('|plugins)');
    expect(template).toContain('rewrite ^/plugins/webapp/(.*)$ /app/plugins-app/webapp/$1 break;');
  });

  it('lets a 20 MB package through to /admin/api/plugins: no body limit under 21 MB applies', () => {
    const sizes = [...template.matchAll(/client_max_body_size\s+(\d+)([kKmMgG]?)/g)].map((m) => Number(m[1]) * ({ k: 1 / 1024, m: 1, g: 1024 } as Record<string, number>)[m[2].toLowerCase()]);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(21);
  });
});

describe('admin registration', () => {
  it('serves the app in Docker through ui5Apps', () => {
    expect(read('services', 'admin', 'src', 'index.ts')).toContain("name: 'plugins-app'");
  });

  it('mounts the app in local development and builds it', () => {
    const pkg = JSON.parse(read('services', 'admin', 'package.json'));
    expect(pkg.cds['cds-plugin-ui5'].modules['plugins-app']).toMatchObject({ path: 'app/plugins-app', mountPath: '/plugins' });
    expect(pkg.scripts.build).toContain('cd ../plugins-app && pnpm run build');
    expect(pkg.sapux).toContain('app/plugins-app');
  });

  it('has the build script the Dockerfile runs', () => {
    expect(JSON.parse(read('services', 'admin', 'app', 'plugins-app', 'package.json')).scripts['build:docker']).toBe('ui5 build --all --clean-dest --dest dist');
  });
});

describe('CI registration', () => {
  it('runs the journey for the admin role only', () => {
    expect(read('ci', 'scripts', 'ui-journeys', 'run.js')).toMatch(/name: 'plugins-app', mount: '\/plugins', minTests: \d+, roles: \['admin'\]/);
  });

  it('gates the type check', () => {
    expect(JSON.parse(read('ci', 'scripts', 'ui5-typecheck.gated.json')).apps).toContain('plugins-app');
  });

  it('expects the nav entry for an admin and not for a user', () => {
    const roles = read('ci', 'scripts', 'ui-journeys', 'roles.js');
    expect(roles).toMatch(/visibleNav:[^\]]*'Connections', 'Plugins'\]/);
    expect(roles).toMatch(/hiddenNav:[^\]]*'Connections', 'Plugins'\]/);
  });
});

describe('shell registration', () => {
  const controller = read('services', 'admin', 'app', 'shell', 'webapp', 'controller', 'App.controller.ts');

  it('mounts the component on both deployment paths', () => {
    expect(controller).toContain('componentName: "admin.plugins.Component"');
    expect(controller).toContain("'plugins': '/admin/app/plugins-app/'");
    expect(controller).toContain("'plugins': '/plugins/'");
    expect(controller).toContain('componentConfig = { name: "admin.plugins", url: componentUrl, manifest: true };');
  });

  it('routes to the screen and keeps the side navigation in step in all three places', () => {
    expect(controller.match(/"connections", "plugins"\]\.includes/g)).toHaveLength(3);
    expect(controller).toContain('router.navTo("pluginsList")');
    expect(controller).toContain('this.feRouter.navTo("pluginsList")');
    expect(controller).toContain('routeName === "pluginsList"');
  });

  it('has the entry text in all languages', () => {
    for (const suffix of ['', '_en', '_de', '_es', '_fr', '_it', '_nl', '_pt']) {
      expect(read('services', 'admin', 'app', 'shell', 'webapp', 'i18n', `i18n${suffix}.properties`)).toMatch(/^nav\.plugins=.+$/m);
    }
  });
});
