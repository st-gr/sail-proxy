/**
 * Refuses a request that changes something when the browser marks it as sent by another site.
 *
 * The cockpit signs in with the oauth2-proxy cookie, which a browser attaches to a request whatever
 * page sent it. Browsers say where a request came from in `Sec-Fetch-Site`: the cockpit's own
 * requests are `same-origin`, and a page on another host is `cross-site`, or `same-site` when it is a
 * sibling host under the same domain (which a SameSite=Lax cookie does not stop). Only those two are
 * refused, and only for methods that change something.
 *
 * A client that is not a browser (the gateway, CLI tools, scripts) sends no `Sec-Fetch-Site` and is
 * not affected; neither is a read, so links and bookmarks keep working. `Origin` is deliberately not
 * compared: behind nginx and Istio the host the admin sees need not match it, and every browser the
 * cockpit supports sends `Sec-Fetch-Site`.
 */
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REFUSED_SITES = new Set(['cross-site', 'same-site']);

type Headers = Record<string, string | string[] | undefined>;

export function isCrossSiteWrite(method: string, headers: Headers): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const site = headers['sec-fetch-site'];
  return typeof site === 'string' && REFUSED_SITES.has(site.toLowerCase());
}

export function createCrossSiteGuard() {
  return (req: any, res: any, next: any): void => {
    if (!isCrossSiteWrite(req.method, req.headers)) return next();
    logger.warn('CrossSiteGuard', `Refused ${req.method} ${req.originalUrl ?? req.url}: sent from another site (${req.headers['sec-fetch-site']})`, {
      origin: req.headers.origin,
    });
    res.status(403).json({
      error: { code: 'CROSS_SITE_REQUEST', message: 'A page on another site cannot change anything here. Use the Admin Cockpit itself.' },
    });
  };
}
