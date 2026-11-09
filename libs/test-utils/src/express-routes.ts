/**
 * Route enumeration for Express 4 apps and routers.
 * Walks the layer stack so tests can compare the routes a service really
 * serves with the routes its OpenAPI description documents.
 */

import { METHODS } from 'http';
import type express from 'express';

export type RouteKey = { method: string; path: string };

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `:name` -> `{name}`, `\:` -> `:`, trailing slash removed (except `/`). */
export const toOpenApiPath = (expressPath: string): string => {
  const colon = '\u0000';
  const converted = expressPath
    .replace(/\\:/g, colon)
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .split(colon)
    .join(':');
  return converted.length > 1 ? converted.replace(/\/+$/, '') || '/' : converted;
};

/** Recover the mount path of a `use()` layer from its regexp (Express 4 keeps it nowhere else). */
const mountPathOf = (layer: any): string => {
  if (layer.regexp?.fast_slash) return '';
  const source: string = layer.regexp?.source ?? '';
  const match = /^\^((?:\\\/|[^()|?*+[\]{}\\^$]|\\[.\-_~!$&'*+,;=@%])*?)(?:\\\/\?)?\(\?=\\\/\|\$\)$/.exec(
    source.replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, () => '\u0001')
  );
  if (!match) throw new Error(`Cannot decode Express mount path from regexp: ${source}`);
  const keys: string[] = (layer.keys ?? []).map((k: any) => String(k.name));
  let keyIndex = 0;
  const decoded = match[1]
    .replace(/\u0001/g, () => {
      const name = keys[keyIndex++];
      if (name === undefined) throw new Error(`Cannot decode Express mount path from regexp: ${source}`);
      return `/:${name}`;
    })
    .replace(/\\(.)/g, '$1');
  return decoded.replace(/\/+$/, '');
};

const ALL_METHODS = METHODS.map(m => m.toLowerCase());

const stackOf = (handle: any): any[] | undefined => handle?.stack ?? handle?._router?.stack;

const walk = (stack: any[], prefix: string, out: RouteKey[]): void => {
  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const paths: unknown[] = Array.isArray(route.path) ? route.path : [route.path];
      for (const p of paths) {
        if (typeof p !== 'string') {
          throw new Error(`Cannot enumerate non-string route path: ${String(p)}`);
        }
        const full = toOpenApiPath(prefix + p);
        const methods = Object.keys(route.methods ?? {}).filter(m => route.methods[m] && m !== '_all');
        // app.all()/router.all() registers the route for every HTTP method
        if (route.methods?._all || ALL_METHODS.every(m => methods.includes(m))) {
          out.push({ method: 'all', path: full });
        } else {
          for (const m of methods) out.push({ method: m, path: full });
        }
      }
    } else {
      const child = stackOf(layer.handle);
      if (child) walk(child, prefix + mountPathOf(layer), out);
    }
  }
};

/** All routes served by an app or router, in OpenAPI path form, de-duplicated and sorted. */
export const listExpressRoutes = (
  appOrRouter: express.Express | express.Router,
  prefix = ''
): RouteKey[] => {
  const stack = stackOf(appOrRouter) ?? [];
  const found: RouteKey[] = [];
  walk(stack, prefix, found);
  const unique = new Map(found.map(k => [`${k.method} ${k.path}`, k]));
  return [...unique.values()].sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0)
  );
};
