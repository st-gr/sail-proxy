/**
 * What the Logs app needs outside its folder. Each of these fails only in a container or in CI, while
 * local development works, so they are pinned here (as plugins-app does for its own).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

describe('nginx template', () => {
  const template = read('docker', 'nginx', 'templates', 'nginx.conf.tmpl');
  const listOf = (start: string) => template.split('\n').find((line) => line.includes(start))!;

  it('has the app in the three name lists and its webapp rewrite', () => {
    expect(listOf('location ~* ^/admin/app/(shell|')).toMatch(/\|logs-app[|)]/);
    expect(listOf('location ~ ^/(shell|')).toMatch(/\|logs-app[|)]/);
    expect(listOf('location ~ ^/(usage-analytics|')).toMatch(/\|logs[|)]/);
    expect(template).toContain('rewrite ^/logs/webapp/(.*)$ /app/logs-app/webapp/$1 break;');
  });

  it('lets the export through to the admin: /admin/api/ goes to its /api/', () => {
    expect(template).toMatch(/location \/admin\/api\/ \{[^}]*proxy_pass http:\/\/admin_service\/api\/;/);
  });
});

describe('admin registration', () => {
  it('serves the app in Docker through ui5Apps', () => {
    expect(read('services', 'admin', 'src', 'index.ts')).toContain("name: 'logs-app'");
  });

  it('mounts the app in local development and builds it', () => {
    const pkg = JSON.parse(read('services', 'admin', 'package.json'));
    expect(pkg.cds['cds-plugin-ui5'].modules['logs-app']).toMatchObject({ path: 'app/logs-app', mountPath: '/logs' });
    expect(pkg.scripts.build).toContain('cd ../logs-app && pnpm run build');
    expect(pkg.sapux).toContain('app/logs-app');
  });

  it('has the build script the Dockerfile runs', () => {
    expect(JSON.parse(read('services', 'admin', 'app', 'logs-app', 'package.json')).scripts['build:docker']).toBe('ui5 build --all --clean-dest --dest dist');
  });
});

describe('CI registration', () => {
  it('runs the journey for the admin role only', () => {
    expect(read('ci', 'scripts', 'ui-journeys', 'run.js')).toMatch(/name: 'logs-app', mount: '\/logs', minTests: \d+, roles: \['admin'\]/);
  });

  it('gates the type check', () => {
    expect(JSON.parse(read('ci', 'scripts', 'ui5-typecheck.gated.json')).apps).toContain('logs-app');
  });

  it('expects the nav entry for an admin and not for a user', () => {
    const roles = read('ci', 'scripts', 'ui-journeys', 'roles.js');
    expect(roles).toMatch(/visibleNav:[^\]]*'Logs'[,\]]/);
    expect(roles).toMatch(/hiddenNav:[^\]]*'Logs'[,\]]/);
  });
});

describe('shell registration', () => {
  const controller = read('services', 'admin', 'app', 'shell', 'webapp', 'controller', 'App.controller.ts');

  it('mounts the component on both deployment paths', () => {
    expect(controller).toContain('componentName: "admin.logs.Component"');
    expect(controller).toContain("'logs': '/admin/app/logs-app/'");
    expect(controller).toContain("'logs': '/logs/'");
    expect(controller).toContain('componentConfig = { name: "admin.logs", url: componentUrl, manifest: true };');
  });

  it('routes to the screen and keeps the side navigation in step', () => {
    expect(controller.match(/"plugins", "logs"\]\.includes/g)).toHaveLength(3);
    expect(controller).toContain('router.navTo("logsList")');
    expect(controller).toContain('this.feRouter.navTo("logsList")');
    expect(controller).toContain('routeName === "logsList"');
  });

  it('has the entry text in all languages', () => {
    for (const suffix of ['', '_en', '_de', '_es', '_fr', '_it', '_nl', '_pt']) {
      expect(read('services', 'admin', 'app', 'shell', 'webapp', 'i18n', `i18n${suffix}.properties`)).toMatch(/^nav\.logs=.+$/m);
    }
  });
});
