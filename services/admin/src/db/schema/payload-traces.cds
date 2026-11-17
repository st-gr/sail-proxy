namespace sap.llm.gateway.admin;

/**
 * Light payload traces, one per inference request while payload capture is on, shipped through the
 * `payload-traces` Valkey stream and stored here by services/payloadTraceIngest.ts. The key is the
 * stream entry's id, so an entry delivered twice is written to the same row. `prompt` and `answer`
 * hold masked text only; the prompt of a request that was not masked is kept sealed in `sealedPrompt`
 * (@libs/trace-seal) and is opened only by openPayloadTrace or the download, which audit it.
 * `keyName` and `userEmail` are resolved from the credential at ingest. `raw` says that the request
 * also has a raw trace. Rows age out by retention (services/gatewayLogRetention.ts); the indexes on
 * capturedAt and requestId are created at start (db/data/gateway-log-indexes.ts).
 */
entity PayloadTraces {
  key ID        : String(40);
  requestId     : String(60);
  capturedAt    : Timestamp;
  endpoint      : String(500);
  model         : String(200);
  authType      : String(40);
  credentialId  : String(100);
  keyName       : String(100);
  userEmail     : String(255);
  statusCode    : Integer;
  durationMs    : Integer;
  inputTokens   : Integer;
  outputTokens  : Integer;
  masked        : Boolean;
  truncated     : Boolean;
  omitted       : String(30);
  prompt        : LargeString;
  answer        : LargeString;
  sealedPrompt  : LargeString;
  raw           : Boolean;
}

/**
 * Raw traces: the stage-by-stage payloads of one request of a raw capture session, shipped through
 * the `raw-traces` stream. `stageIndex` is the JSON array of the stages' names, sizes and cut marks
 * (not content); `stages` is one sealed envelope of all stages and is opened only by openRawStage or
 * the download, which audit it. Keyed by the stream entry's id. Rows age out after
 * `payload_capture.raw.retention_hours`.
 */
entity RawTraces {
  key ID        : String(40);
  requestId     : String(60);
  sessionId     : String(60);
  credentialId  : String(100);
  capturedAt    : Timestamp;
  stageIndex    : LargeString;
  cutStages     : Boolean;
  stages        : LargeString;
}
