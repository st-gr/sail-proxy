/**
 * The Logs app's calls to the admin's OData service: the GatewayLog read and the three logging
 * settings operations. No UI5 imports and an injected fetch, so it runs under jest. Every method
 * resolves to a result and never rejects. A refusal is shown by the service's translated message;
 * its code is kept so the page can put it at the field it belongs to.
 */
import type { SettingsParams, SettingsResult } from './settingsForm';

export type FetchLike = (input: string, init?: any) => Promise<any>;
export type Translator = (key: string, args?: (string | number)[]) => string;

export interface ApiError { status: number; code: string; message: string }
export interface ApiResult<T = any> { ok: boolean; status: number; body: T | null; error: ApiError | null; date?: string | null }
/** serverDate: the answer's Date header, the server's time of the read (nginx in Docker and Kyma). */
export interface EntriesBody { entries: any[]; count: number | null; serverDate: string | null }

export interface OpenedTrace { masked: boolean; prompt: string | null; answer: string | null; problem: string | null }
export interface OpenedStage { stage: string; content: string | null; cut: boolean; problem: string | null }
export interface StartedCapture { ID: string; endsAt: string; credentialCount: number; keyWarning: string | null }
export interface ActiveCapture { ID: string; endsAt: string; startedBy: string; keyCount: number; addressCount: number }

/** A function parameter in the URL: an OData string literal (a quote inside doubled), URL-encoded. */
const odataString = (value: string): string => encodeURIComponent(`'${String(value).replace(/'/g, "''")}'`).replace(/%27/g, "'");

/** English defaults, byte-identical to the bundle: jest gets them, the controllers inject the bundle. */
const EN_TEXTS: Record<string, string> = {
  apiNotAdmin: 'Only administrators can see this page.',
  apiRequestFailedStatus: 'The request failed with status {0}.',
  apiServerUnreachable: 'The server could not be reached.'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

export class LogsApi {
  constructor(private readonly base: string, private readonly fetchFn: FetchLike, private readonly t: Translator = defaultTranslate, private readonly language = '') {}

  async entries(url: string): Promise<ApiResult<EntriesBody>> {
    const result = await this.send(url, { method: 'GET' });
    if (!result.ok) return result;
    const body = result.body ?? {};
    const count = typeof body['@odata.count'] === 'number' ? body['@odata.count'] : null;
    return { ...result, body: { entries: Array.isArray(body.value) ? body.value : [], count, serverDate: result.date ?? null } };
  }

  getSettings(): Promise<ApiResult<SettingsResult>> {
    return this.send(`${this.base}/getLoggingSettings()`, { method: 'GET' });
  }

  /** The component names of the stored gateway log (the suggestions for a component level). */
  logComponents(): Promise<ApiResult<{ value: string[] }>> {
    return this.send(`${this.base}/gatewayLogComponents()`, { method: 'GET' });
  }

  setSettings(params: SettingsParams): Promise<ApiResult<SettingsResult>> {
    return this.send(`${this.base}/setLoggingSettings`, { method: 'POST', body: JSON.stringify(params) });
  }

  resetSettings(): Promise<ApiResult<SettingsResult>> {
    return this.send(`${this.base}/resetLoggingSettings`, { method: 'POST', body: '{}' });
  }

  /** Empties what the service stores: the gateway log, the payload traces, or all; the body holds the number of rows deleted. */
  deleteStoredLogs(what: 'log' | 'traces' | 'all'): Promise<ApiResult<{ deleted: number; logEntries: number; traces: number }>> {
    return this.send(`${this.base}/deleteStoredLogs`, { method: 'POST', body: JSON.stringify({ what }) });
  }

  /** A trace's prompt and answer; for a trace that was not masked the service records the open. */
  openPayloadTrace(id: string): Promise<ApiResult<OpenedTrace>> {
    return this.send(`${this.base}/openPayloadTrace(ID=${odataString(id)})`, { method: 'GET' });
  }

  /** One stage of a raw trace, by its name (unique per request); the service records the open. */
  openRawStage(id: string, stage: string): Promise<ApiResult<OpenedStage>> {
    return this.send(`${this.base}/openRawStage(ID=${odataString(id)},stage=${odataString(stage)})`, { method: 'GET' });
  }

  startRawCapture(payload: { apiKeyIds: string[]; emails: string[]; minutes: number; reason: string }): Promise<ApiResult<StartedCapture>> {
    return this.send(`${this.base}/startRawCapture`, { method: 'POST', body: JSON.stringify(payload) });
  }

  stopRawCapture(id: string): Promise<ApiResult> {
    return this.send(`${this.base}/stopRawCapture`, { method: 'POST', body: JSON.stringify({ ID: id }) });
  }

  /** The raw capture sessions running now, earliest end first. */
  async activeRawCapture(): Promise<ApiResult<ActiveCapture[]>> {
    const result = await this.send(`${this.base}/activeRawCapture()`, { method: 'GET' });
    return result.ok ? { ...result, body: Array.isArray(result.body?.value) ? result.body.value : [] } : result;
  }

  /**
   * A download read with the session, so that a refusal (404, 409 keys-differ or malformed, whose
   * message is English only) is shown translated by its code instead of opening as a page.
   */
  async download(url: string): Promise<{ ok: true; blob: any; fileName: string } | { ok: false; status: number; code: string }> {
    let response: any;
    try {
      response = await this.fetchFn(url, { method: 'GET', credentials: 'include', headers: this.language ? { 'Accept-Language': this.language } : {} });
    } catch (error) {
      return { ok: false, status: 0, code: 'network' };
    }
    if (response.ok) {
      const disposition = typeof response.headers?.get === 'function' ? String(response.headers.get('Content-Disposition') ?? '') : '';
      const name = /filename="([^"]+)"/.exec(disposition);
      // The file keeps the server's name and type; only without a name does the type choose the ending.
      const type = typeof response.headers?.get === 'function' ? String(response.headers.get('Content-Type') ?? '') : '';
      const fallback = /^text\/plain\b/i.test(type) ? 'download.txt' : 'download.json';
      return { ok: true, blob: await response.blob(), fileName: name ? name[1] : fallback };
    }
    const text = await response.text().catch(() => '');
    let code = `http_${response.status}`;
    try { const body = JSON.parse(text); if (typeof body?.error === 'string') code = body.error; } catch (error) { /* no JSON */ }
    return { ok: false, status: response.status, code };
  }

  /** whoami's deployTarget ("docker" behind nginx in Docker and Kyma); "development" when it does not answer. */
  async deployTarget(): Promise<string> {
    const result = await this.send(`${this.base}/whoami`, { method: 'POST', body: '{}' });
    const target = result.ok ? result.body?.deployTarget : undefined;
    return typeof target === 'string' && target ? target : 'development';
  }

  private async send(url: string, init: { method: string; body?: string }): Promise<ApiResult> {
    // IEEE754Compatible: Edm.Int64 (seq) arrives as text, so no digit is lost beyond 2^53.
    const headers: Record<string, string> = { Accept: 'application/json;IEEE754Compatible=true' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.language) headers['Accept-Language'] = this.language;
    let response: any;
    try {
      response = await this.fetchFn(url, { ...init, headers, credentials: 'include' });
    } catch (error) {
      return { ok: false, status: 0, body: null, error: { status: 0, code: 'network', message: this.t('apiServerUnreachable') } };
    }
    const text = await response.text().catch(() => '');
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch (error) { body = null; }
    const date = typeof response.headers?.get === 'function' ? response.headers.get('Date') : null;
    if (response.ok) return { ok: true, status: response.status, body, error: null, date: typeof date === 'string' && date ? date : null };
    return { ok: false, status: response.status, body, error: this.errorOf(response.status, body) };
  }

  private errorOf(status: number, body: any): ApiError {
    if (status === 403) return { status, code: 'forbidden', message: this.t('apiNotAdmin') };
    const error = body && typeof body.error === 'object' ? body.error : null;
    const code = error && typeof error.code === 'string' ? error.code : `http_${status}`;
    const message = error && typeof error.message === 'string' ? error.message : this.t('apiRequestFailedStatus', [status]);
    return { status, code, message };
  }
}
