namespace sap.llm.gateway.admin;

using { cuid, managed } from '@sap/cds/common';
using { sap.llm.gateway.admin.ApiConfigurations } from './simplified-api-config';

/**
 * The normalized SiemEvent, written once per event. This is the export queue; the domain
 * tables (*SecurityEvents, AuditEvents) remain the record of what happened.
 */
entity SiemOutbox : cuid, managed {
  eventId       : String(100);      // SiemEvent.event_id, for dedup and correlation
  category      : String(20);
  eventType     : String(80);
  severity      : String(20);
  occurredAt    : Timestamp;
  payload       : LargeString;      // the serialized SiemEvent
  deliveries    : Composition of many SiemDelivery on deliveries.event = $self;
}

/**
 * Per-sink delivery state. One row per event per enabled sink, so a sink that is down
 * cannot block the others and its backlog is a COUNT over this table.
 */
entity SiemDelivery : cuid, managed {
  event         : Association to SiemOutbox;
  sinkName      : String(40);
  status        : String(20) default 'pending';   // pending | delivered | expired
  attempts      : Integer default 0;
  lastError     : String(1000);
  lastAttemptAt : Timestamp;
  deliveredAt   : Timestamp;
}

/**
 * Encrypted credential values for SIEM sinks, keyed by the environment-variable NAME that
 * api_config.json already uses for the sink (e.g. 'SIEM_DATADOG_API_KEY'). Storing under
 * that name means api_config.json needs no change. The encrypted credential store is the
 * only source - there is no environment fallback.
 *
 * Deliberately NOT exposed as a projection on AdminService. Ciphertext must never be
 * readable over OData - see AdminService.AwsCredentials, which does expose its encrypted
 * secretAccessKey and is the mistake this avoids.
 */
entity SiemCredentials : cuid, managed {
  // Credentials belong to the configuration they were maintained in. Editing an inactive
  // configuration's credential must not affect the running system, so the slot name alone
  // is NOT unique - the pair is.
  configuration : Association to ApiConfigurations;
  name       : String(100);      // the env var name - unique per configuration, see the annotate below
  // LargeString, not String(n): cds caps String at 5000, so String(8000) compiles under the
  // in-memory sqlite the tests use but fails `cds compile --dialect postgres` outright, and
  // the admin service then refuses to start in the container. Hex ciphertext of a long
  // credential (a GCP service-account JSON runs to several KB) can exceed 5000 either way.
  ciphertext : LargeString;
  iv         : String(32);       // hex, 16 bytes, unique per write
  salt       : String(64);       // hex, 32 bytes, unique per write - never a constant
  authTag    : String(32);       // hex, 16 bytes, GCM integrity tag
  algorithm  : String(20) default 'aes-256-gcm';
  maskedHint : String(20);       // e.g. 'abcd…wxyz', for display only
}

// `name` is the lookup key for the resolver but NOT a primary key: `cuid` already
// contributes `key ID : UUID`, and adding a second `key` would make a compound key.
// A unique constraint is what's actually wanted here - scoped to the owning configuration,
// not global, so the same slot name can exist independently in two configurations.
annotate SiemCredentials with @assert.unique: { configurationName: [ configuration, name ] } {
  name @mandatory;
}

// Placed here, not in simplified-api-config.cds, purely to keep the composition beside the
// entity it targets (SiemCredentials, declared in this file) rather than splitting one
// relationship's declaration across two files. A cross-file `using` in each direction
// (this file importing ApiConfigurations above, simplified-api-config.cds importing
// SiemCredentials) compiles fine either way - this is a style choice, not a compiler
// limitation.
// Deleting a configuration therefore deletes its credentials rather than leaving them orphaned.
extend entity ApiConfigurations with {
  siemCredentials : Composition of many SiemCredentials on siemCredentials.configuration = $self;
}
