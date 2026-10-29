import morgan from 'morgan';
import { redactUrl } from './redactUrl';

// morgan's `combined` format with the request URL and the referrer passed through redactUrl,
// so a key sent as ?key= / ?api_key= is not written to the access log.
morgan.token('safe-url', (req: any) => redactUrl(req.originalUrl || req.url));
morgan.token('safe-referrer', (req: any) => {
  const referrer = req.headers?.referer || req.headers?.referrer;
  return typeof referrer === 'string' ? redactUrl(referrer) : undefined;
});

const COMBINED_REDACTED =
  ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":safe-referrer" ":user-agent"';

export function accessLogMiddleware(write: (message: string) => void) {
  return morgan(COMBINED_REDACTED, { stream: { write: (message: string) => write(message.trim()) } });
}
