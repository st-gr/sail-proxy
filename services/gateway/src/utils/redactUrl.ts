/**
 * Masks the API key a client passes in the query string (`?key=`, `?api_key=`; the two names
 * extractApiKey accepts) so a request URL can be logged or put into an event.
 *
 * Only the value is replaced (`key=***`); the parameter name stays so an operator sees that a key
 * arrived in the URL, and the path and every other parameter are untouched. Parameter names are
 * compared case-insensitively and URL-decoded (`%6Bey=`), repeated parameters are all masked, and a
 * bracketed form (`key[a]=`) is masked too. A URL with none of these is returned unchanged.
 * Display only: nothing that routes or authenticates a request may use the result.
 */
const KEY_PARAMS = new Set(['key', 'api_key']);
const MASK = '***';

function isKeyParam(rawName: string): boolean {
  let name = rawName;
  try {
    name = decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    // undecodable name: compare it as written
  }
  return KEY_PARAMS.has(name.replace(/\[.*\]$/, '').toLowerCase());
}

export function redactUrl(url: string): string;
export function redactUrl(url: string | undefined): string | undefined;
export function redactUrl(url: string | undefined): string | undefined {
  if (typeof url !== 'string') return url;
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hash = url.indexOf('#', q);
  const queryEnd = hash === -1 ? url.length : hash;
  const query = url.slice(q + 1, queryEnd);
  const masked = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1 || !isKeyParam(pair.slice(0, eq))) return pair;
      return `${pair.slice(0, eq + 1)}${MASK}`;
    })
    .join('&');
  return url.slice(0, q + 1) + masked + url.slice(queryEnd);
}

/** The parsed counterpart of redactUrl for `req.query` (a copy; the request's own object is untouched). */
export function redactQuery(query: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!query) return query;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(query)) out[name] = isKeyParam(name) ? MASK : value;
  return out;
}
