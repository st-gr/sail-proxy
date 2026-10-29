/**
 * The cockpit serves the API reference (Swagger UI and the four OpenAPI documents in openapi/) at
 * /api/docs/, which nginx exposes as /admin/api/docs/ behind the cockpit sign-in.
 *
 * The page directory is built with cli-tools/copy-api-docs.js (the admin build runs it into
 * dist/api-docs); these tests build one into a temporary directory and serve it with the router
 * behind the docker auth middleware, mounted the way src/index.ts mounts it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
  createHeadersPreview: (h: unknown) => h
}));

import { createAuthMiddleware } from '../../src/middleware/authMiddleware';
import { createApiDocsRouter } from '../../src/srv/api-docs';

const ADMIN_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(ADMIN_ROOT, '../..');
const COPY_SCRIPT = path.join(REPO_ROOT, 'cli-tools/copy-api-docs.js');
const DOCS = ['gateway.yaml', 'admin-odata.json', 'admin-rest.yaml', 'ollama.yaml'];
const SIGNED_IN = { 'x-auth-request-email': 'admin@example.com', 'x-auth-request-groups': 'admins' };

describe('API reference at /api/docs/', () => {
  const env = { ...process.env };
  let outDir: string;
  let app: express.Express;

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-docs-'));
    execFileSync(process.execPath, [COPY_SCRIPT, outDir, ...DOCS.map(d => path.join(REPO_ROOT, 'openapi', d))],
      { cwd: ADMIN_ROOT, stdio: 'pipe' });
    Object.assign(process.env, { DEPLOY_TARGET: 'docker', NODE_ENV: 'test' });
    app = express();
    app.use(createAuthMiddleware());
    app.use('/api/docs', createApiDocsRouter(outDir));
  });
  afterAll(() => {
    process.env = { ...env };
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('the copy step puts the Swagger UI files and the four documents in the directory', () => {
    expect(fs.readdirSync(outDir).sort()).toEqual(
      [...DOCS, 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js', 'swagger-ui.css'].sort());
  });

  it('the copy step fails on a missing document', () => {
    const result = spawnSync(process.execPath, [COPY_SCRIPT, outDir, path.join(REPO_ROOT, 'openapi/missing.yaml')],
      { cwd: ADMIN_ROOT, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing.yaml');
  });

  it('refuses a caller that is not signed in', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('swagger-ui-bundle.js');
  });

  it('serves the page to a signed-in user, with no inline script', async () => {
    const res = await request(app).get('/api/docs/').set(SIGNED_IN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('src="swagger-ui-bundle.js"');
    expect(res.text).toContain('src="init.js"');
    // Every <script> element loads a file and has no content of its own.
    const scripts = res.text.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script).toMatch(/^<script src="[^"]+"><\/script>$/);
    }
    expect(res.text).not.toMatch(/\son[a-z]+=/i);
  });

  it('the init script opens all four documents, relative to the page, and sends cookies', async () => {
    const res = await request(app).get('/api/docs/init.js').set(SIGNED_IN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    for (const doc of DOCS) expect(res.text).toContain(`url: '${doc}'`);
    expect(res.text).toContain('withCredentials: true');
  });

  it('serves a document and the Swagger UI files', async () => {
    const yaml = await request(app).get('/api/docs/gateway.yaml').set(SIGNED_IN);
    expect(yaml.status).toBe(200);
    expect(yaml.headers['content-type']).toMatch(/yaml/);
    expect(yaml.text).toContain('openapi:');
    const json = await request(app).get('/api/docs/admin-odata.json').set(SIGNED_IN);
    expect(json.status).toBe(200);
    expect(json.headers['content-type']).toMatch(/application\/json/);
    const bundle = await request(app).get('/api/docs/swagger-ui-bundle.js').set(SIGNED_IN);
    expect(bundle.status).toBe(200);
    expect(bundle.headers['content-type']).toMatch(/javascript/);
    const missing = await request(app).get('/api/docs/nothing.yaml').set(SIGNED_IN);
    expect(missing.status).toBe(404);
  });

  it.each([
    '/api/docs/..%2f..%2fpackage.json',
    '/api/docs/%2e%2e/package.json',
    '/api/docs/..%5c..%5cpackage.json',
    '/api/docs/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json'
  ])('does not serve files outside the directory, even signed in: %s', async (url) => {
    const res = await request(app).get(url).set(SIGNED_IN);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('"name"');
  });

  it('/api/docs redirects to /api/docs/ with a relative location that also works behind the /admin prefix', async () => {
    const res = await request(app).get('/api/docs').set(SIGNED_IN);
    expect(res.status).toBe(301);
    const location = res.headers.location;
    expect(new URL(location, 'http://host/api/docs').pathname).toBe('/api/docs/');
    expect(new URL(location, 'http://host/admin/api/docs').pathname).toBe('/admin/api/docs/');
  });
});
