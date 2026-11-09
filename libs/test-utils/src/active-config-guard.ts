/**
 * Restore whichever API configuration was active before a test suite ran.
 *
 * Several admin integration suites POST `activateConfiguration` against a LIVE
 * admin service, and none of them put back what was there. On 2026-08-06 that
 * left a 98-byte test stub — "Test Configuration After Fix", no `defaultHooks`
 * at all — active on a developer's running stack. The gateway reads its
 * configuration from the admin service at runtime, so every plugin silently
 * stopped running: hosted tools went upstream verbatim and codex-cli got a 400
 * from SAP. The tests all passed. Nothing pointed at them.
 *
 * Refusing to run against a live service is the wrong answer — some end-to-end
 * suites require one. Restoring is the right one.
 *
 * Usage, at the top of a suite that activates anything:
 *
 *   guardActiveConfiguration();
 *
 * It registers its own beforeAll/afterAll, so it must be called inside a
 * `describe` or at module top level, like the Jest hooks it wraps.
 */

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The runner's hooks, read off globalThis rather than imported.
 *
 * This package has no jest types and should not grow a dependency on a test
 * runner just to expose one helper — every consumer already runs under one.
 */
type Hook = (fn: () => Promise<void> | void) => void;
function runnerHooks(): { beforeAll: Hook; afterAll: Hook } | null {
  const g = globalThis as any;
  return typeof g.beforeAll === 'function' && typeof g.afterAll === 'function'
    ? { beforeAll: g.beforeAll, afterAll: g.afterAll }
    : null;
}

interface ConfigRow { ID: string; name?: string; isActive?: boolean }

async function fetchJson(url: string, auth: string, timeoutMs: number): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: auth }, signal: controller.signal });
    return res.ok ? await res.json() : null;
  } catch {
    // No service listening, or it is too slow to answer. A unit-only run must
    // not fail here — there is nothing to protect in that case.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function activeConfig(baseUrl: string, auth: string, timeoutMs: number): Promise<ConfigRow | null> {
  const body = await fetchJson(
    `${baseUrl}/odata/v4/admin/ApiConfigurations?$select=ID,name,isActive&$filter=isActive eq true`,
    auth, timeoutMs,
  );
  return body?.value?.[0] ?? null;
}

export interface ActiveConfigGuardOptions {
  /** Defaults to ADMIN_SERVICE_URL, which setupTests populates. */
  baseUrl?: string;
  /** Defaults to the mocked-auth admin user the integration suites already use. */
  auth?: string;
  timeoutMs?: number;
}

export function guardActiveConfiguration(options: ActiveConfigGuardOptions = {}): void {
  const auth = options.auth
    || `Basic ${Buffer.from('admin@test.com:admin').toString('base64')}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let original: ConfigRow | null = null;
  let baseUrl = '';

  const hooks = runnerHooks();
  if (!hooks) {
    throw new Error('guardActiveConfiguration() must be called inside a test runner with beforeAll/afterAll');
  }
  const { beforeAll, afterAll } = hooks;

  beforeAll(async () => {
    // Read the URL here, not at module scope: setupTests sets ADMIN_SERVICE_URL
    // in its own beforeAll, which has not run when this module is imported.
    baseUrl = options.baseUrl || process.env.ADMIN_SERVICE_URL || '';
    if (!baseUrl) return;
    original = await activeConfig(baseUrl, auth, timeoutMs);
  });

  afterAll(async () => {
    if (!original || !baseUrl) return;
    const now = await activeConfig(baseUrl, auth, timeoutMs);
    if (now?.ID === original.ID) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/odata/v4/admin/activateConfiguration`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ configId: original.ID }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.warn(
        `[active-config-guard] restored "${original.name}" (${original.ID}); this suite left `
        + `"${now?.name ?? 'nothing'}" active`,
      );
    } catch (err: any) {
      // Loud, because the alternative is a developer's gateway quietly running
      // on a test stub — the exact failure this guard exists to prevent.
      console.error(
        `[active-config-guard] FAILED to restore "${original.name}" (${original.ID}): ${err?.message}. `
        + `The admin service is left with "${now?.name ?? 'unknown'}" active — reactivate it before using the gateway.`,
      );
    } finally {
      clearTimeout(timer);
    }
  });
}
