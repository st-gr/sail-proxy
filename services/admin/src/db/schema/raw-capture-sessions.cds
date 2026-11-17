namespace sap.llm.gateway.admin;

/**
 * Raw capture sessions (services/rawCaptureSessions.ts): an administrator names API keys and/or
 * e-mail addresses, a duration and a reason; the addresses are resolved to the credentials they own
 * when the session starts. The running sessions (endedAt null, endsAt in the future) are written to
 * the Valkey key `sap-llm-gateway:raw-capture`, from which the gateway captures those credentials'
 * requests raw. `apiKeyIds`, `emails` and `credentialIds` are JSON arrays of strings; `credentialIds`
 * holds ApiKeys.ID for an API key and both AwsCredentials.ID and accessKeyId for an AWS credential.
 * `endedBy` is the administrator who stopped the session, or `system` when it ended by itself.
 */
entity RawCaptureSessions {
  key ID        : UUID;
  startedAt     : Timestamp;
  endsAt        : Timestamp;
  endedAt       : Timestamp;
  startedBy     : String(255);
  reason        : String(500);
  apiKeyIds     : LargeString;
  emails        : LargeString;
  credentialIds : LargeString;
  endedBy       : String(255);
}
