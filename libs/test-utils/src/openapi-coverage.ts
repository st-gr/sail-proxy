/**
 * OpenAPI loading and route-coverage comparison for the API reference tests.
 */

import * as fs from 'fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse } from 'yaml';
import type { OpenAPIV3_1 } from 'openapi-types';
import type { RouteKey } from './express-routes';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Parse a YAML or JSON OpenAPI file and validate it; throws with the validator's message. */
export const loadOpenApi = async (file: string): Promise<OpenAPIV3_1.Document> => {
  const parsed = parse(fs.readFileSync(file, 'utf8'));
  await SwaggerParser.validate(structuredClone(parsed));
  return parsed as OpenAPIV3_1.Document;
};

/** Every path x operation, plus the same operations under each `x-sail-aliases` path. */
export const documentedRoutes = (doc: OpenAPIV3_1.Document): RouteKey[] => {
  const out: RouteKey[] = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    const pathItem = (item ?? {}) as Record<string, unknown>;
    const aliases = (pathItem['x-sail-aliases'] as string[] | undefined) ?? [];
    const methods = HTTP_METHODS.filter(m => pathItem[m]);
    for (const path of [p, ...aliases]) {
      for (const method of methods) out.push({ method, path });
    }
  }
  return out;
};

const keyOf = (k: RouteKey): string => `${k.method} ${k.path}`;

/** undocumented = served but in neither list; stale = listed but not served. */
export const compareRoutes = (
  actual: RouteKey[],
  documented: RouteKey[],
  internal: RouteKey[]
): { undocumented: RouteKey[]; stale: RouteKey[] } => {
  const served = new Set(actual.map(keyOf));
  const known = new Set([...documented, ...internal].map(keyOf));
  return {
    undocumented: actual.filter(k => !known.has(keyOf(k))),
    stale: [...documented, ...internal].filter(k => !served.has(keyOf(k)))
  };
};
