/**
 * The npm gateway serves its own API reference at /docs, only on the local deploy target while it
 * listens on a loopback address. The page directory is built by cli-tools/copy-api-docs.js (the
 * gateway build runs it into dist/api-docs); these tests build one into a temporary directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ConfigLoader } from '../../../libs/config';
import type { ConfigOptions } from '../../../libs/config/types';
import { createApp } from '../src/app';
import { findApiDocsDir, isLoopbackHost, mountApiDocs } from '../src/routes/apiDocsRoutes';

const GATEWAY_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(GATEWAY_ROOT, '../..');
const COPY_SCRIPT = path.join(REPO_ROOT, 'cli-tools/copy-api-docs.js');
// The page loads only the bundle and the stylesheet, so the npm package carries only those.
const UI_FLAG = '--ui=swagger-ui-bundle.js,swagger-ui.css';

const appFor = (overrides: Partial<ConfigOptions>): express.Express =>
  createApp({ ...new ConfigLoader('gateway').loadConfig(), ...overrides }).app;

describe('isLoopbackHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.254', true],
    ['::1', true],
    ['[::1]', true],
    ['localhost', true],
    ['LOCALHOST', true],
    ['0.0.0.0', false],
    ['::', false],
    ['', false],
    ['192.168.1.5', false],
    ['10.0.0.1', false],
    ['128.0.0.1', false],
    ['127.0.0.256', false],
    ['127.0.0.1.example.com', false],
    ['example.com', false]
  ])('%j -> %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe('findApiDocsDir', () => {
  let root: string;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-layout-')); });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('finds dist/api-docs from the compiled layout (dist/services/gateway/src/routes)', () => {
    const compiled = path.join(root, 'compiled');
    fs.mkdirSync(path.join(compiled, 'dist/services/gateway/src/routes'), { recursive: true });
    fs.mkdirSync(path.join(compiled, 'dist/api-docs'));
    expect(findApiDocsDir(path.join(compiled, 'dist/services/gateway/src/routes')))
      .toBe(path.join(compiled, 'dist/api-docs'));
  });

  it('finds services/gateway/dist/api-docs from the source layout that ts-node runs (services/gateway/src/routes)', () => {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'services/gateway/src/routes'), { recursive: true });
    fs.mkdirSync(path.join(source, 'services/gateway/dist/api-docs'), { recursive: true });
    expect(findApiDocsDir(path.join(source, 'services/gateway/src/routes')))
      .toBe(path.join(source, 'services/gateway/dist/api-docs'));
  });

  it('returns undefined when the gateway was never built, and the mount is then skipped', () => {
    const unbuilt = path.join(root, 'unbuilt/services/gateway/src/routes');
    fs.mkdirSync(unbuilt, { recursive: true });
    expect(findApiDocsDir(unbuilt)).toBeUndefined();
    expect(mountApiDocs(express(), { deployTarget: 'local', host: '127.0.0.1' }, undefined, unbuilt)).toBe(false);
  });

  it('the checkout resolves to the directory the gateway build fills', () => {
    expect(findApiDocsDir(path.join(GATEWAY_ROOT, 'src/routes'))).toBe(path.join(GATEWAY_ROOT, 'dist/api-docs'));
  });
});

describe('API reference at /docs', () => {
  let outDir: string;

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-api-docs-'));
    execFileSync(process.execPath, [COPY_SCRIPT, UI_FLAG, outDir, path.join(REPO_ROOT, 'openapi/gateway.yaml')],
      { cwd: GATEWAY_ROOT, stdio: 'pipe' });
  });
  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('the copy step puts only the files the page loads, and the gateway document, in the directory', () => {
    expect(fs.readdirSync(outDir).sort()).toEqual(['gateway.yaml', 'swagger-ui-bundle.js', 'swagger-ui.css']);
  });

  it('the gateway build asks for exactly those files', () => {
    const build = JSON.parse(fs.readFileSync(path.join(GATEWAY_ROOT, 'package.json'), 'utf8')).scripts.build;
    expect(build).toContain(`copy-api-docs.js ${UI_FLAG} `);
  });

  it('is served by createApp on the local target listening on 127.0.0.1', async () => {
    const res = await request(appFor({ deployTarget: 'local', host: '127.0.0.1' })).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('src="swagger-ui-bundle.js"');
  });

  it.each([
    ['a wildcard address', { deployTarget: 'local' as const, host: '0.0.0.0' }],
    ['the IPv6 wildcard', { deployTarget: 'local' as const, host: '::' }],
    ['the docker target', { deployTarget: 'docker' as const, host: '127.0.0.1' }],
    ['the btp target', { deployTarget: 'btp' as const, host: '127.0.0.1' }]
  ])('is not mounted for %s', async (_name, overrides) => {
    const app = appFor(overrides);
    expect((await request(app).get('/docs/')).status).toBe(404);
    expect((await request(app).get('/docs')).status).toBe(404);
    expect((await request(app).get('/docs/init.js')).status).toBe(404);
  });

  it('mountApiDocs reports whether it mounted', () => {
    expect(mountApiDocs(express(), { deployTarget: 'local', host: 'localhost' }, outDir)).toBe(true);
    expect(mountApiDocs(express(), { deployTarget: 'local', host: '0.0.0.0' }, outDir)).toBe(false);
    expect(mountApiDocs(express(), { deployTarget: 'docker', host: '127.0.0.1' }, outDir)).toBe(false);
  });

  describe('when mounted', () => {
    let app: express.Express;
    beforeAll(() => {
      app = express();
      mountApiDocs(app, { deployTarget: 'local', host: '127.0.0.1' }, outDir);
    });

    it('serves a page with no inline script', async () => {
      const res = await request(app).get('/docs/');
      const scripts = res.text.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) expect(script).toMatch(/^<script src="[^"]+"><\/script>$/);
      expect(res.text).not.toMatch(/\son[a-z]+=/i);
    });

    it('the init script opens the gateway document and sends Try-it to the page origin', async () => {
      const res = await request(app).get('/docs/init.js');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/javascript/);
      expect(res.text).toContain(`url: 'gateway.yaml'`);
      expect(res.text).toContain('window.location.origin');
      expect(res.text).not.toContain('withCredentials');
    });

    it('serves the document and the Swagger UI files, and answers 404 for anything else', async () => {
      const yaml = await request(app).get('/docs/gateway.yaml');
      expect(yaml.status).toBe(200);
      expect(yaml.text).toContain('openapi:');
      expect((await request(app).get('/docs/swagger-ui-bundle.js')).status).toBe(200);
      expect((await request(app).get('/docs/admin-rest.yaml')).status).toBe(404);
    });

    it.each([
      '/docs/..%2f..%2fpackage.json',
      '/docs/%2e%2e/package.json',
      '/docs/..%5c..%5cpackage.json',
      '/docs/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json'
    ])('does not serve files outside the directory: %s', async (url) => {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('"name"');
    });

    it('/docs redirects to /docs/ with a relative location', async () => {
      const res = await request(app).get('/docs?x=1');
      expect(res.status).toBe(301);
      expect(new URL(res.headers.location, 'http://host/docs?x=1').pathname).toBe('/docs/');
      expect(new URL(res.headers.location, 'http://host/docs?x=1').search).toBe('?x=1');
    });
  });
});
