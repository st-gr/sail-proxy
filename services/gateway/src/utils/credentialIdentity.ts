/**
 * Turns a credential value presented by a client that did NOT resolve to a stored row
 * (an unrecognized API key, an AWS access key ID that failed validation) into the fields
 * the SIEM export pipeline is allowed to carry. The raw value must never reach
 * SiemEvent.actor.credential_id (services/admin/src/siem/siemEvent.ts) — a third-party SIEM
 * sink is not this process, and once a secret leaves this process it cannot be revoked back.
 *
 * - `credentialId`: a SHA-256 hex digest, computed here so the same unrecognized credential
 *   always produces the same id — preserving "this credential was tried 500 times" (the
 *   brute-force signal an auditor wants) without the secret itself.
 * - `credentialHint`: the first 8 characters of the presented value. Carries the forensic
 *   signal that matters for triage — format identification (`sk-proj-`, `ghp_`, `AKIA`,
 *   `xoxb-`) — without the secret. Included in the default SIEM payload.
 * - `credentialMaterial`: the full presented value. Carried through the internal pipeline
 *   (Valkey stream, the durable Postgres outbox) but stripped before every sink send unless
 *   that specific sink's `include_credential_material` config opts in
 *   (services/admin/src/siem/dispatcher.ts) — default false, so it does not appear in any
 *   sink payload unless an operator explicitly asks for it.
 *
 * When the credential DOES resolve to a stored row (ApiKeys/AwsCredentials — both cuid, so
 * `ID` is already an opaque, indexed, rotation-stable identifier), skip this helper entirely
 * and ship the row's `ID` directly as credentialId — it is safe as-is and better for
 * correlation than a hash, since rotateApiKey updates the key in place. See
 * services/admin/src/srv/admin-service.ts rotateApiKey / rotateAwsCredentials.
 */
import { createHash } from 'crypto';

// 'missing' / 'unknown' mark "no credential was presented" rather than an actual value.
// Hashing those would be pointless and would make an already-informative sentinel
// unreadable in the SIEM UI, so they pass through unchanged.
const SENTINELS = new Set(['missing', 'unknown']);
const HINT_LENGTH = 8;

export interface CredentialIdentity {
  credentialId: string;
  credentialHint?: string;
  credentialMaterial?: string;
}

export const credentialIdentity = (presented: string): CredentialIdentity => {
  if (SENTINELS.has(presented)) {
    return { credentialId: presented };
  }
  return {
    credentialId: createHash('sha256').update(presented).digest('hex'),
    credentialHint: presented.slice(0, HINT_LENGTH),
    credentialMaterial: presented,
  };
};
