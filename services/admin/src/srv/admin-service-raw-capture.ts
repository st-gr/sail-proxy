/**
 * Raw capture sessions on AdminService (services/rawCaptureSessions.ts): the actions startRawCapture
 * and stopRawCapture and the function activeRawCapture, all admin only (admin-service.cds). A refused
 * start or stop answers with its status (400, 404, 409, or 503 without Valkey) and a translated message.
 * A start with a missing, short or publicly known METADATA_ENCRYPTION_KEY succeeds and returns
 * keyWarning, a translated text the start dialog shows (D1).
 */
import { clientContext } from '../utils/clientIp';
import {
  RawCaptureError, RawCaptureActor, startRawCaptureSession, stopRawCaptureSession, activeRawCaptureSessions
} from '../services/rawCaptureSessions';

const cds = require('@sap/cds');

const KEY_WARNINGS: Record<string, string> = {
  missing: 'RAW_CAPTURE_KEY_MISSING',
  'too-short': 'RAW_CAPTURE_KEY_TOO_SHORT',
  'publicly-known': 'RAW_CAPTURE_KEY_PUBLICLY_KNOWN'
};

const actorOf = (req: any): RawCaptureActor => ({ id: req.user?.id || 'anonymous', ...clientContext(req) });

/** Runs `work`; a RawCaptureError becomes the request's refusal. */
async function refusing<T>(req: any, work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RawCaptureError) return req.reject({ status: error.status, code: error.key, message: error.key, args: error.args });
    throw error;
  }
}

async function startRawCapture(req: any): Promise<any> {
  return refusing(req, async () => {
    const started = await startRawCaptureSession(req.data ?? {}, actorOf(req), new Date());
    const warning = KEY_WARNINGS[started.keyStatus];
    return { ID: started.ID, endsAt: started.endsAt, credentialCount: started.credentialCount,
      keyWarning: warning ? cds.i18n.messages.at(warning, req.locale) ?? warning : null };
  });
}

async function stopRawCapture(req: any): Promise<void> {
  await refusing(req, () => stopRawCaptureSession(req.data?.ID, actorOf(req), new Date()));
}

export function registerRawCaptureHandlers(service: any): void {
  service.on('startRawCapture', startRawCapture);
  service.on('stopRawCapture', stopRawCapture);
  service.on('activeRawCapture', () => activeRawCaptureSessions(new Date()));
}
