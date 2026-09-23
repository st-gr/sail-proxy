/**
 * Null-prototype-safe reads of Express `req.query` values.
 *
 * Express 4.22 fixed CVE-2024-51999 by parsing the extended query string with
 * `qs.parse(str, { plainObjects: true })` instead of `{ allowPrototypes: true }`,
 * so a bracketed parameter (`?x[a]=1`) now yields an object created with
 * `Object.create(null)`. Such an object has no `Symbol.toPrimitive`, no
 * `toString` and no `valueOf`, so `String(v)`, `parseInt(v as string)` or a
 * template literal throws `TypeError: Cannot convert object to primitive value`
 * — in an async handler that rejection never reaches `app.use(errorHandler)` on
 * express 4, the request hangs and Node reports an unhandledRejection.
 *
 * Every `req.query` read that coerces or forwards the value therefore goes
 * through `queryString`, which narrows to the string cases and answers `null`
 * for everything else (the health route, the deployment controller, the three
 * auth middlewares' key extraction, file-search pagination). A read that only
 * type-narrows, like nulByteGuard, needs no helper. `req.body` is not affected
 * (body-parser's urlencoded parser still passes `allowPrototypes`).
 */

/** First element of an array-valued parameter, or the value itself. */
export function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The query parameter as a non-empty string: the value itself if it is a
 * string, the first element of a string array, `null` for anything else
 * (absent, empty, a nested object from a bracketed parameter). Never throws.
 */
export function queryString(value: unknown): string | null {
  const v = firstValue(value);
  return typeof v === 'string' && v.length > 0 ? v : null;
}
