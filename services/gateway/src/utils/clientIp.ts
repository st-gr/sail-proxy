/**
 * The single source-IP derivation for the gateway.
 *
 * Two derivations existed before this file and both were wrong. One took
 * `x-forwarded-for.split(',')[0]`, which is attacker-controlled: nginx sets the header
 * with `$proxy_add_x_forwarded_for` (nginx.conf.tmpl:472), which APPENDS the real peer to
 * whatever the client sent, so element [0] is whatever the client claimed. The other used
 * `req.ip` with no `trust proxy` setting, which returns nginx's pod IP for every request.
 *
 * Forwarded headers are trusted only when the caller says so — mirroring LiteLLM's
 * `general_settings.use_x_forwarded_for`. An unconditionally trusted forwarding header lets
 * any client dictate the IP recorded against its own security events.
 */
import { Request } from 'express';

/** ::ffff:203.0.113.7 -> 203.0.113.7; every other address as received (columns are String(45)). */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(String(ip).trim());
  return m ? m[1] : String(ip).trim();
}

export function getClientIp(req: Request, trustForwardedFor: boolean): string {
  if (!trustForwardedFor) {
    // req.ip is derived from X-Forwarded-For whenever Express's `trust proxy` is
    // enabled (see src/index.ts's TRUST_PROXY_HOPS), so it can still carry a
    // client-supplied value here. Go straight to the socket peer instead.
    const socketPeer =
      (req as any)?.socket?.remoteAddress ||
      (req as any)?.connection?.remoteAddress ||
      '';
    return normalizeIp(socketPeer) || 'unknown';
  }

  const peer =
    (req as any)?.ip ||
    (req as any)?.connection?.remoteAddress ||
    (req as any)?.socket?.remoteAddress ||
    '';

  // nginx sets X-Real-IP with proxy_set_header, which overwrites rather than appends,
  // so it cannot carry a client-supplied value through a correctly configured proxy.
  const realIp = (req.headers?.['x-real-ip'] as string | undefined)?.trim();
  if (realIp) return normalizeIp(realIp);

  // X-Forwarded-For is append-only, so the entry added by the nearest trusted proxy is
  // the LAST one. Never take [0] — that is the client's own claim.
  const forwarded = req.headers?.['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded as string | undefined);
  if (chain) {
    const parts = chain.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length > 0) return normalizeIp(parts[parts.length - 1]);
  }

  return normalizeIp(peer) || 'unknown';
}
