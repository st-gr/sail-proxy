/**
 * The admin's client-IP derivation. Mirrors services/gateway/src/utils/clientIp.ts — the two
 * services share only test-utils, and a runtime lib for these lines is not worth the packaging —
 * so keep the two in step: forwarded headers are trusted only when
 * platform.security.trust_forwarded_for says so; X-Real-IP (overwritten by nginx) wins, else the
 * LAST X-Forwarded-For hop (the entry the nearest trusted proxy appended), else the peer.
 * Untrusted: the socket peer, never req.ip (Express derives it from X-Forwarded-For whenever
 * `trust proxy` is on). IPv4-mapped IPv6 peers (::ffff:a.b.c.d) are stored as IPv4.
 */
import fs from 'fs';
import path from 'path';

let _trust: boolean | null = null;

/** platform.security.trust_forwarded_for from api_config.json, read once; anything but true is false. */
export function trustForwardedFor(): boolean {
  if (_trust === null) {
    try {
      const p = path.resolve(__dirname, '../../api_config.json');
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8')).api_config ?? {};
      _trust = cfg?.platform?.security?.trust_forwarded_for === true;
    } catch {
      _trust = false;
    }
  }
  return _trust;
}

/** ::ffff:203.0.113.7 -> 203.0.113.7; every other address as received. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(String(ip).trim());
  return m ? m[1] : String(ip).trim();
}

export function getClientIp(req: any, trust: boolean = trustForwardedFor()): string {
  if (!trust) {
    const peer = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
    return peer ? normalizeIp(peer) : 'unknown';
  }
  const realIp = (req?.headers?.['x-real-ip'] as string | undefined)?.trim();
  if (realIp) return normalizeIp(realIp);
  const forwarded = req?.headers?.['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (chain) {
    const parts = String(chain).split(',').map((p: string) => p.trim()).filter(Boolean);
    if (parts.length > 0) return normalizeIp(parts[parts.length - 1]);
  }
  const peer = req?.ip || req?.connection?.remoteAddress || req?.socket?.remoteAddress || '';
  return peer ? normalizeIp(peer) : 'unknown';
}

/** Client IP and user agent of a CAP request (req.http.req is the Express request behind it). */
export function clientContext(req: any): { clientIP: string; userAgent: string } {
  const http = req?.http?.req;
  return {
    clientIP: http ? getClientIp(http) : 'unknown',
    userAgent: http?.headers?.['user-agent'] || 'unknown'
  };
}
