/**
 * The request guard of the S3 verification: an axios request interceptor on the instance the S3
 * backend sends with (axios' default instance). It runs before the adapter, so a refused request is
 * never sent. Allowed is exactly a PUT, GET, DELETE or HEAD of one of the run's planned keys (the
 * test files and the probe object), https://<bucket>.s3.<region>.amazonaws.com/<key>. Anything else -
 * a request on the bucket itself, another host, a query string (a list), a key outside the run
 * folder or not in the plan, another method - throws, and is recorded as a violation that fails the
 * run. The URL checked is the one axios will send: `getUri(config)`, which applies `baseURL` and
 * `params`.
 *
 * Errors and records never contain the bucket or host: keys only (they hold no bucket name).
 */
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import type { S3Op } from './plan';
import { ScriptError } from './errors';

export const GUARD_ERROR_CODE = 'ES3VERIFY_BLOCKED';

export interface GuardScope {
  bucket: string;
  region: string;
  runFolder: string;
  /** The planned keys (test files and the probe object); every request must name one of them. */
  keys: string[];
}

export interface GuardedRequest {
  op: S3Op;
  key: string;
}

export class GuardViolation extends Error {
  readonly code = GUARD_ERROR_CODE;
  constructor(reason: string) {
    super(`request refused by the verification guard: ${reason}`);
    this.name = 'GuardViolation';
  }
}

const OBJECT_OPS: Record<string, S3Op> = { put: 'PutObject', get: 'GetObject', delete: 'DeleteObject', head: 'HeadObject' };

/** Classifies a request, or throws GuardViolation. Pure. */
export function checkRequest(method: string | undefined, url: string | undefined, scope: GuardScope): GuardedRequest {
  const m = (method ?? 'get').toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(url ?? '');
  } catch {
    throw new GuardViolation('not an absolute URL');
  }
  const host = `${scope.bucket}.s3.${scope.region}.amazonaws.com`;
  if (parsed.protocol !== 'https:') throw new GuardViolation('not https');
  if (parsed.host !== host) throw new GuardViolation('not the bucket\'s host');
  if (parsed.username || parsed.password) throw new GuardViolation('credentials in the URL');
  if (parsed.search || parsed.hash || (url ?? '').includes('?')) throw new GuardViolation('a query string (no listing or sub-resource is allowed)');
  if (parsed.pathname === '/') throw new GuardViolation('a request on the bucket itself (no bucket-level request is allowed)');
  const key = parsed.pathname.slice(1);
  if (!key.startsWith(`${scope.runFolder}/`)) throw new GuardViolation('a key outside the run folder');
  if (!scope.keys.includes(key)) throw new GuardViolation(`a key that is not in the plan: ${key}`);
  const op = OBJECT_OPS[m];
  if (!op) throw new GuardViolation(`method ${m.toUpperCase()} on a key`);
  return { op, key };
}

export interface InstalledGuard {
  /** Every request the guard let through, in order. */
  allowed: GuardedRequest[];
  /** Every request it refused (the reason only). */
  violations: string[];
  /** Keys a PutObject was sent for: the keys this run may have created. */
  created(): string[];
  eject(): void;
}

/**
 * Installs the guard as the instance's only request interceptor. axios runs request interceptors
 * last-registered first (its default `transitional.legacyInterceptorReqResOrdering`), so an
 * interceptor registered BEFORE the guard would run AFTER it and could rewrite a checked request:
 * an instance that already has one is refused. One registered later runs before the guard, which
 * then checks its result. A request carrying its own adapter (which bypasses the instance's) is
 * refused as well. axios merges the default adapter list (['xhr', 'http', 'fetch']) into each
 * request as a copy, so adapters are compared by value, not identity.
 */
export function installGuard(instance: AxiosInstance, scope: GuardScope): InstalledGuard {
  const existing = ((instance.interceptors.request as any).handlers ?? []).filter(Boolean);
  if (existing.length > 0) throw new ScriptError('the axios instance already has request interceptors; refusing to run');
  const allowed: GuardedRequest[] = [];
  const violations: string[] = [];
  const id = instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    try {
      if (config.adapter !== undefined && !sameAdapter(config.adapter, instance.defaults.adapter)) {
        throw new GuardViolation('a request with its own adapter');
      }
      allowed.push(checkRequest(config.method, instance.getUri(config), scope));
    } catch (error: any) {
      violations.push(error?.message ?? String(error));
      throw error;
    }
    return config;
  }, undefined, { synchronous: true });
  return {
    allowed,
    violations,
    created: () => [...new Set(allowed.filter((r) => r.op === 'PutObject').map((r) => r.key))],
    eject: () => instance.interceptors.request.eject(id),
  };
}

/** The same adapter: the same function, or the same names/functions in the same order. */
export function sameAdapter(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/** Requests per operation, for comparing a run with its plan. */
export function countByOp(requests: GuardedRequest[]): Record<S3Op, number> {
  const counts: Record<S3Op, number> = { PutObject: 0, GetObject: 0, DeleteObject: 0, HeadObject: 0 };
  for (const r of requests) counts[r.op] += 1;
  return counts;
}
