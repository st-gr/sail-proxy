/**
 * How a failed gateway call is answered to the client.
 *
 * shared.js marks every failure of a gateway call with `upstream = true` (and `status`/`data` when the
 * gateway answered). A gateway 4xx is the client's own error or the gateway's refusal (400, 401, 403,
 * 404, 429, ...), so it is passed through with the gateway's message; an unreachable gateway or a 5xx is
 * a bad gateway, 502. Anything else is the facade's own failure, 500.
 */

const statusFor = (error) => {
  if (!error || !error.upstream) return 500;
  const status = Number(error.status);
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : 502;
};

/** The gateway's own message from its error body (`{error:{message}}`, `{error:"..."}` or `{message}`). */
const messageFor = (error, fallback) => {
  const data = error && error.data;
  if (data && typeof data === 'object') {
    if (data.error && typeof data.error.message === 'string' && data.error.message) return data.error.message;
    if (typeof data.error === 'string' && data.error) return data.error;
    if (typeof data.message === 'string' && data.message) return data.message;
  }
  return (error && error.message) || fallback;
};

module.exports = { statusFor, messageFor };
