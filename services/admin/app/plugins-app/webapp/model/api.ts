/**
 * The Plugins app's calls to the admin's /api/plugins. No UI5 imports and an injected fetch, so it
 * runs under jest. Every method resolves to a result and never rejects. A refusal is shown by the
 * server's `message`, so a new code needs no change here.
 */

export type FetchLike = (input: string, init?: any) => Promise<any>;
export type Translator = (key: string, args?: (string | number)[]) => string;

export interface ApiError { status: number; code: string; message: string }
export interface ApiResult<T = any> { ok: boolean; status: number; body: T | null; error: ApiError | null }

/** English defaults, byte-identical to the bundle: jest gets them, the Component injects the bundle. */
const EN_TEXTS: Record<string, string> = {
  apiFileTooLarge: 'The file is larger than the server accepts.',
  apiRequestFailedStatus: 'The request failed with status {0}.',
  apiServerUnreachable: 'The server could not be reached.'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

/** Behind nginx (Docker, Kyma) the admin service's /api is served under /admin/api. */
export function basePath(deployTarget: string | null | undefined): string {
  return deployTarget === 'docker' ? '/admin/api/plugins' : '/api/plugins';
}

/** The warnings of an answer as text: enable and disable send objects with a message, suggested hooks sends strings. */
export function messagesOf(body: any): string[] {
  if (!body || !Array.isArray(body.warnings)) return [];
  return body.warnings.map((w: any) => (typeof w === 'string' ? w : String(w?.message ?? ''))).filter((text: string) => text !== '');
}

const enc = encodeURIComponent;
const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

export class PluginsApi {
  constructor(private readonly base: string, private readonly fetchFn: FetchLike, private readonly t: Translator = defaultTranslate) {}

  list(): Promise<ApiResult> {
    return this.send('', { method: 'GET', headers: { Accept: 'application/json' } });
  }

  /** The raw file is the body: the route takes application/zip, not a multipart form. */
  upload(file: Blob): Promise<ApiResult> {
    return this.send('', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/zip' }, body: file });
  }

  enable(id: string, version: string): Promise<ApiResult> {
    return this.send(`/${enc(id)}/enable`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ version }) });
  }

  disable(id: string): Promise<ApiResult> {
    return this.send(`/${enc(id)}/disable`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
  }

  /** One configuration with the suggested hooks of all these plugins. */
  addSuggestedHooks(ids: string[]): Promise<ApiResult> {
    return this.send('/suggested-hooks', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids }) });
  }

  removeVersion(id: string, version: string): Promise<ApiResult> {
    return this.send(`/${enc(id)}/versions/${enc(version)}`, { method: 'DELETE', headers: { Accept: 'application/json' } });
  }

  private async send(path: string, init: Record<string, unknown>): Promise<ApiResult> {
    let response: any;
    try {
      response = await this.fetchFn(this.base + path, { ...init, credentials: 'include' });
    } catch (error) {
      const failure: ApiError = { status: 0, code: 'network', message: this.t('apiServerUnreachable') };
      return { ok: false, status: 0, body: null, error: failure };
    }
    const text = await response.text().catch(() => '');
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch (error) { body = null; }
    if (response.ok) return { ok: true, status: response.status, body, error: null };
    return { ok: false, status: response.status, body, error: this.errorOf(response.status, body) };
  }

  private errorOf(status: number, body: any): ApiError {
    const code = body && typeof body.error === 'string' ? body.error : `http_${status}`;
    // A 413 without a JSON body is the reverse proxy refusing the upload before the admin sees it.
    const fallback = status === 413 ? this.t('apiFileTooLarge') : this.t('apiRequestFailedStatus', [status]);
    const message = body && typeof body.message === 'string' ? body.message : fallback;
    const details = body && Array.isArray(body.errors) ? body.errors.map(String) : [];
    return { status, code, message: [message, ...details].join('\n') };
  }
}
