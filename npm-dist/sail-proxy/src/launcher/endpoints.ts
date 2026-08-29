import { getConfigPath, ensureConfigDir } from '../utils/paths';
import { getStoredApiKeys, addApiKey } from '../utils/apikey-storage';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';

export type EndpointSpec = { target: string; builtin?: true; rootUrl?: string; keyEnv?: string; key?: string };
const FILE = 'endpoint.json';

export function parseSetArgs(target: string, opts: { keyEnv?: string; key?: string }): EndpointSpec {
  if (target === 'local') return { target: 'local', builtin: true };
  let host: string;
  try { host = new URL(target).host; } catch { throw new Error(`Not a URL or "local": ${target}`); }
  if (opts.key && opts.keyEnv) throw new Error('Provide exactly one of --key or --key-env, not both.');
  if (!opts.key && !opts.keyEnv) throw new Error('A remote endpoint needs a key: --key-env <VAR> (preferred) or --key <value>.');
  const spec: EndpointSpec = { target: host, rootUrl: target };
  if (opts.keyEnv) spec.keyEnv = opts.keyEnv; else spec.key = opts.key;
  return spec;
}

export function setEndpoint(spec: EndpointSpec): void {
  ensureConfigDir();
  writeFileSync(getConfigPath(FILE), JSON.stringify(spec, null, 2));
}

export function showEndpoint(): EndpointSpec | null {
  const p = getConfigPath(FILE);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function getLocalPort(): number {
  const p = getConfigPath('.env');
  if (existsSync(p)) {
    const m = readFileSync(p, 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  }
  return 3000;
}

export function resolveEndpoint(): { rootUrl: string; resolveKey: () => string; isLocal: boolean } {
  const spec = showEndpoint() || { target: 'local', builtin: true };
  if (spec.builtin) {
    return {
      isLocal: true,
      rootUrl: `http://127.0.0.1:${getLocalPort()}`,
      resolveKey: () => {
        const keys = getStoredApiKeys();
        if (keys.length) return keys[0].key;
        const k = 'sk-' + randomBytes(24).toString('hex');
        addApiKey('sail-proxy-launcher', k);
        return k;
      },
    };
  }
  return {
    isLocal: false,
    rootUrl: spec.rootUrl!,
    resolveKey: () => {
      if (spec.keyEnv) {
        const v = process.env[spec.keyEnv];
        if (!v) throw new Error(`Env var ${spec.keyEnv} is not set. Run: export ${spec.keyEnv}=<gateway-api-key>`);
        return v;
      }
      return spec.key!;
    },
  };
}
