namespace sap.llm.gateway.admin;

/**
 * The gateway's own log, shipped through the `gateway-log` Valkey stream and stored here by
 * services/gatewayLogIngest.ts. The key is the stream entry's id plus the entry's index in its
 * batch (e.g. `1731312000000-0-17`), so an entry delivered twice is written to the same row.
 * Rows age out by retention (services/gatewayLogRetention.ts). `storedAt` is the admin's time of the
 * write (one value per stored batch); the Logs page's live view polls by it. NULL (a row stored before
 * the column existed) counts as stored long ago. The indexes on loggedAt and storedAt are created at
 * start (db/data/gateway-log-indexes.ts).
 */
@cds.search: { message, component, requestId }
entity GatewayLogEntries {
  key ID        : String(40);
  loggedAt      : Timestamp;
  seq           : Integer64;
  level         : String(5);
  component     : String(80);
  requestId     : String(60);
  message       : String(2000);
  error         : String(500);
  storedAt      : Timestamp;
}
