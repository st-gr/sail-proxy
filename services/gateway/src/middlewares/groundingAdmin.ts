/**
 * The gate in front of /api/admin/grounding/admin/* (spec 2026-10-01 §5.1, §5.2 admin level; plan
 * decision 7).
 *
 * groundingActingUser has already proved the caller is the admin service key and named the acting
 * user. An admin route additionally needs BOTH the acting role `admin` AND the registry entry of
 * that key granting `grounding:admin` — the role is what the admin service vouches for, the
 * registry entry is what this gateway grants the admin service. Either missing → 403, before any
 * handler runs. The decision is re-made here rather than trusted from groundingActingUser, so the
 * guard stays closed if it is ever mounted without it.
 */
import { Request, Response, NextFunction } from 'express';
import { findServiceKeyByEmail, SERVICE_KEYS } from '@libs/service-auth';
import type { GroundingActor } from './groundingActingUser';

export const GROUNDING_ADMIN_PERMISSION = 'grounding:admin';

export function groundingAdmin(req: Request, res: Response, next: NextFunction): void {
  const keyEmail = (req as any).serviceAuth?.serviceKey?.email;
  const actor: GroundingActor | undefined = (req as any).groundingActor;
  const allowed = (req as any).serviceAuth?.authType === 'service-key'
    && typeof keyEmail === 'string'
    && findServiceKeyByEmail(keyEmail) === 'ADMIN_TO_GATEWAY'
    && (SERVICE_KEYS.ADMIN_TO_GATEWAY.PERMISSIONS as readonly string[]).includes(GROUNDING_ADMIN_PERMISSION)
    && actor?.role === 'admin';
  if (!allowed) {
    res.status(403).json({
      error: {
        message: 'This operation requires a grounding administrator.',
        type: 'permission_error',
        code: 'grounding_admin_required',
      },
    });
    return;
  }
  next();
}
