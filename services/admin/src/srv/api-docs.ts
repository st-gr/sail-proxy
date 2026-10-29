import express from 'express';
import * as path from 'path';

/**
 * The API reference page: Swagger UI over the four OpenAPI documents in openapi/.
 *
 * Mounted at /api/docs behind the auth middleware (src/index.ts); nginx exposes it as /admin/api/docs/
 * behind the cockpit sign-in. `dir` is the directory cli-tools/copy-api-docs.js fills (dist/api-docs):
 * the Swagger UI files and the documents. The page and its init script are written here and every
 * URL in them is relative to the page, so it works under any prefix. No inline script (CSP).
 *
 * Try-it sends requests to the documents' servers on the current origin (/gateway, /admin/odata/v4/admin,
 * /admin/api) with the cockpit cookie; gateway calls take the API key pasted into Authorize.
 */

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SAIL-Proxy API reference</title>
  <link rel="stylesheet" href="swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="swagger-ui-bundle.js"></script>
  <script src="swagger-ui-standalone-preset.js"></script>
  <script src="init.js"></script>
</body>
</html>
`;

const INIT_JS = `window.ui = SwaggerUIBundle({
  urls: [
    { url: 'gateway.yaml', name: 'Gateway' },
    { url: 'admin-odata.json', name: 'Admin OData' },
    { url: 'admin-rest.yaml', name: 'Admin REST' },
    { url: 'ollama.yaml', name: 'Ollama' }
  ],
  dom_id: '#swagger-ui',
  deepLinking: true,
  withCredentials: true,
  validatorUrl: null,
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  plugins: [SwaggerUIBundle.plugins.DownloadUrl],
  layout: 'StandaloneLayout'
});
`;

export function createApiDocsRouter(dir: string): express.Router {
  const router: express.Router = express.Router();

  router.get('/', (req, res) => {
    const [pathname, query] = req.originalUrl.split('?');
    if (!pathname.endsWith('/')) {
      // Relative, so the redirect also lands right behind nginx's /admin prefix.
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
