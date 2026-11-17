/**
 * The "Start raw capture" dialog: what the page checks before it asks the service, and the
 * parameters of startRawCapture (AdminService, srv/admin-service-raw-capture.ts). No UI5 imports.
 * The service checks the same again and more (an unknown key, an address that owns no credential,
 * the configured longest duration) and answers with a translated message.
 */
import type { ApiResult, EntriesBody, StartedCapture, Translator } from './api';
import { countText } from './listTexts';

/** 15 minutes, 1 hour, 4 hours (spec 4.2). */
export const RAW_CAPTURE_MINUTES = [15, 60, 240];

export interface RawCaptureInput {
  /** The chosen API keys and AWS credentials (their IDs). */
  apiKeyIds: string[];
  /** The e-mail addresses as typed: separated by commas, semicolons, spaces or line breaks. */
  emails: string;
  minutes: string | number;
  reason: string;
}

export interface RawCapturePayload { apiKeyIds: string[]; emails: string[]; minutes: number; reason: string }

export type RawCaptureProblem = 'no-target' | 'no-reason' | 'duration';

/** The addresses typed, each once. */
export function splitEmails(text: string): string[] {
  return [...new Set(String(text ?? '').split(/[\s,;]+/).map((part) => part.trim()).filter((part) => part !== ''))];
}

/** At least one key or address, a reason, and one of the three durations. */
export function rawCaptureForm(input: RawCaptureInput): { ok: true; payload: RawCapturePayload } | { ok: false; reason: RawCaptureProblem } {
  const apiKeyIds = [...new Set((input.apiKeyIds ?? []).map((id) => String(id).trim()).filter((id) => id !== ''))];
  const emails = splitEmails(input.emails);
  if (!apiKeyIds.length && !emails.length) return { ok: false, reason: 'no-target' };
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, reason: 'no-reason' };
  const minutes = typeof input.minutes === 'number' ? input.minutes : /^\d+$/.test(String(input.minutes ?? '')) ? Number(input.minutes) : NaN;
  if (!RAW_CAPTURE_MINUTES.includes(minutes)) return { ok: false, reason: 'duration' };
  return { ok: true, payload: { apiKeyIds, emails, minutes, reason } };
}

export interface CredentialItem { id: string; text: string; additionalText: string }

/** The address the admin gives its own service keys (usersService.ts isServiceKeyEmail). */
const SERVICE_KEY_SUFFIX = '.service.key';

/** A key a person uses now: not a service key, not disabled, not deleted, not expired. */
function usable(row: any, now: Date): boolean {
  if (!row || !row.ID || row.isActive === false || row.deletedAt) return false;
  if (typeof row.email === 'string' && row.email.endsWith(SERVICE_KEY_SUFFIX)) return false;
  if (row.neverExpires === true || !row.expiresAt) return true;
  const ends = Date.parse(String(row.expiresAt));
  return Number.isNaN(ends) || ends > now.getTime();
}

/**
 * The keys to choose from: the API keys and the AWS credentials of the key lists, by name, each with
 * its owner's address; the admin's own gateway service key and keys that are disabled, deleted or
 * expired are left out. startRawCapture takes the IDs of both in apiKeyIds.
 */
export function credentialItems(apiKeys: any[], awsCredentials: any[], awsLabel: string, now = new Date()): CredentialItem[] {
  const item = (row: any, fallback: string, suffix: string): CredentialItem => ({
    id: String(row.ID),
    text: `${row.name ? String(row.name) : fallback}${suffix}`,
    additionalText: row.email ? String(row.email) : ''
  });
  return [
    ...apiKeys.filter((row) => usable(row, now)).map((row) => item(row, String(row.maskedKey ?? row.ID), '')),
    ...awsCredentials.filter((row) => usable(row, now)).map((row) => item(row, String(row.accessKeyId ?? row.ID), ` (${awsLabel})`))
  ].sort((a, b) => a.text.localeCompare(b.text));
}

/**
 * The dialog's key list from the two reads: a failed read is said (the service's message for the API
 * keys, a sentence for the AWS credentials), and what was read is still listed.
 */
export function keyListOutcome(keys: ApiResult<EntriesBody>, aws: ApiResult<EntriesBody>, t: Translator, now = new Date()): { items: CredentialItem[]; error: string } {
  const errors: string[] = [];
  if (!keys.ok) errors.push(keys.error?.message ?? '');
  if (!aws.ok) errors.push(t('rawCaptureAwsUnread', [aws.error?.message ?? '']));
  const items = credentialItems(keys.ok ? keys.body!.entries : [], aws.ok ? aws.body!.entries : [], t('awsCredential'), now);
  return { items, error: errors.filter((text) => text !== '').join(' ') };
}

/** After a start: a short note, or a warning that adds the service's keyWarning below it. */
export function startedNotice(started: StartedCapture, t: Translator, formatTime: (iso: string) => string): { warning: boolean; text: string } {
  const text = countText(started.credentialCount, 'rawCaptureStartedOne', 'rawCaptureStarted', t, String, [formatTime(started.endsAt)]);
  return started.keyWarning ? { warning: true, text: `${text}\n\n${started.keyWarning}` } : { warning: false, text };
}
