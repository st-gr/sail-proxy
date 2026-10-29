import express from 'express';
import { listExpressRoutes, toOpenApiPath } from '../src/express-routes';

const noop: express.RequestHandler = (_req, res) => { res.end(); };

describe('listExpressRoutes', () => {
  it('enumerates app routes and mounted routers in OpenAPI form', () => {
    const app = express();
    app.get('/health', noop);
    const files = express.Router();
    files.get('/', noop);
    files.get('/:id', noop);
    files.delete('/:id', noop);
    app.use('/openai/v1/files', files);
    const g = express.Router();
    g.post('/models/:model\\:generateContent', noop);
    app.use('/google/v1beta', g);

    expect(listExpressRoutes(app)).toEqual([
      { method: 'post', path: '/google/v1beta/models/{model}:generateContent' },
      { method: 'get', path: '/health' },
      { method: 'get', path: '/openai/v1/files' },
      { method: 'delete', path: '/openai/v1/files/{id}' },
      { method: 'get', path: '/openai/v1/files/{id}' }
    ]);
  });

  it('reports a router mounted at two prefixes under both', () => {
    const app = express();
    const r = express.Router();
    r.get('/x', noop);
    app.use('/a', r);
    app.use('/b', r);
    expect(listExpressRoutes(app).map(k => k.path)).toEqual(['/a/x', '/b/x']);
  });

  it('ignores middleware-only mounts and honours a prefix', () => {
    const app = express();
    app.use(['/p', '/q'], noop);
    expect(listExpressRoutes(app)).toEqual([]);
    const r = express.Router();
    r.get('/x', noop);
    expect(listExpressRoutes(r, '/pre')).toEqual([{ method: 'get', path: '/pre/x' }]);
  });

  it('decodes parameterised mounts and fails loudly on undecodable ones', () => {
    const app = express();
    const r = express.Router();
    r.get('/x', noop);
    app.use('/t/:tid', r);
    expect(listExpressRoutes(app)).toEqual([{ method: 'get', path: '/t/{tid}/x' }]);
    const bad = express();
    bad.use(['/p', '/q'], r);
    expect(() => listExpressRoutes(bad)).toThrow(/Cannot decode/);
  });

  it('reports all() routes as method all', () => {
    const app = express();
    app.all('/any', noop);
    expect(listExpressRoutes(app)).toEqual([{ method: 'all', path: '/any' }]);
  });
});

describe('toOpenApiPath', () => {
  it('converts params, escaped colons and trailing slashes', () => {
    expect(toOpenApiPath('/a/:b/c/')).toBe('/a/{b}/c');
    expect(toOpenApiPath('/m/:model\\:go')).toBe('/m/{model}:go');
    expect(toOpenApiPath('/')).toBe('/');
  });
});
