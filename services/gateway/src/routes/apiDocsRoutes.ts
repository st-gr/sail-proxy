import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import type { ConfigOptions } from '../../../../libs/config/types';
import { getDefaultLogger } from '../../../../libs/logger';

/**
 * The npm gateway's own API reference: Swagger UI over openapi/gateway.yaml, at /docs.
 *
 * The Docker and Kyma deployments serve the reference from the cockpit (behind its sign-in); the npm
 * package has no cockpit, so the gateway serves the page itself, and only while nothing but this
 * machine can reach it: the local deploy target listening on a loopback address. The page is public
 * otherwise-unauthenticated documentation, but an exposed listener is not the place for it.
 *
 * `dir` is what cli-tools/copy-api-docs.js fills (dist/api-docs). The page and its init script are
 * written here; no inline script (CSP), every URL is relative to the page.
 */

const logger = getDefaultLogger();

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SAIL-Proxy gateway API reference</title>
  <link rel="stylesheet" href="swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="swagger-ui-bundle.js"></script>
  <script src="init.js"></script>
</body>
</html>
`;

// The document lists the nginx path (/gateway) and the npm gateway's default port as servers; this
// page is served by the gateway itself, so Try-it goes to the origin the page was loaded from.
const INIT_JS = `window.ui = SwaggerUIBundle({
  url: 'gateway.yaml',
  dom_id: '#swagger-ui',
  deepLinking: true,
  validatorUrl: null,
  presets: [SwaggerUIBundle.presets.apis],
  plugins: [{
    statePlugins: {
      spec: {
        wrapActions: {
          updateJsonSpec: (original) => (spec) => original(Object.assign({}, spec, { servers: [{ url: window.location.origin }] }))
        }
      }
    }
  }]
});
`;

/** True for 127.0.0.0/8, ::1 and localhost; false for wildcard addresses and everything else. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return octets !== null && Number(octets[1]) === 127 && octets.slice(1).every(o => Number(o) <= 255);
}

export function createApiDocsRouter(dir: string): express.Router {
  const router: express.Router = express.Router();

  router.get('/', (req, res) => {
    const [pathname, query] = req.originalUrl.split('?');
    if (!pathname.endsWith('/')) {
      res.redirect(301, `${path.posix.basename(pathname)}/${query !== undefined ? `?${query}` : ''}`);
      return;
    }
    res.type('html').send(INDEX_HTML);
  });

  router.get('/init.js', (_req, res) => {
    res.type('application/javascript').send(INIT_JS);
  });

  router.use(express.static(dir, { index: false }));

  router.use((_req, res) => {
    res.status(404).type('text').send('Not found');
  });

  return router;
}

/**
 * The directory the gateway build fills: dist/api-docs when running the compiled code
 * (dist/services/gateway/src/routes), services/gateway/dist/api-docs when ts-node runs src/ (pnpm dev).
 * Undefined when neither exists, i.e. the gateway was never built.
 */
export function findApiDocsDir(from = __dirname): string | undefined {
  return [path.join(from, '../../../../api-docs'), path.join(from, '../../dist/api-docs')]
    .find(candidate => fs.existsSync(candidate));
}

/**
 * Mounts /docs when the deploy target is local and the listen address is loopback. Returns whether it did.
 * Without a built page directory nothing is mounted (one log line), rather than serving a blank page.
 */
export function mountApiDocs(app: express.Express, config: Pick<ConfigOptions, 'deployTarget' | 'host'>, dir?: string, from = __dirname): boolean {
  if (config.deployTarget !== 'local' || !isLoopbackHost(config.host)) return false;
  const docsDir = dir ?? findApiDocsDir(from);
  if (docsDir === undefined) {
    logger.info('Server', 'API reference not mounted: run the gateway build (pnpm build:gateway) to create dist/api-docs');
    return false;
  }
  app.use('/docs', createApiDocsRouter(docsDir));
  logger.info('Server', 'API reference mounted at /docs (loopback only)');
  return true;
}
