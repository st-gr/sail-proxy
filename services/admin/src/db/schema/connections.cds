namespace sap.llm.gateway.admin;

using { cuid, managed } from '@sap/cds/common';

/**
 * Connections (spec 2026-10-23 §4): an external provider account the gateway can send inference to
 * when the SAP AI Core budget runs out. Each one publishes chosen upstream models under the id
 * `<upstreamModel>--<name>`. Connections stand apart from api_config versioning: activating or
 * rolling back a configuration never changes them.
 */
entity ProviderConnections : cuid, managed {
  name             : String(31) not null;   // the id suffix: ^[a-z][a-z0-9-]{1,30}$, no '--', not 'deployed'; immutable
  title            : String(100);
  providerType     : String(16) not null;   // azure-openai | bedrock | openai | anthropic | sap-ai-core; immutable
  isActive         : Boolean default true;  // sap-ai-core: the installation's SAP target, set by activate/deactivate only
  // azure-openai; sap-ai-core: the AI API URL (set from the service key)
  endpoint         : String(500);
  apiMode          : String(12);            // v1 | deployments
  apiVersion       : String(20);            // deployments mode only
  authMode         : String(24);            // azure: api-key | entra-client-secret; bedrock: access-key | bearer
  tenantId         : String(100);           // Azure tenant id, or for sap-ai-core the SAP AI Core tenant key (`<subdomain>.<landscape>` from the auth URL)
  clientId         : String(255);           // sap-ai-core: the service key's client id (not a secret; SAP ids run to ~60+ characters)
  // bedrock; sap-ai-core: the region parsed from the AI API URL
  region           : String(32);
  runtimeEndpoint  : String(500);
  accessKeyId      : String(128);           // not a secret; the secret access key is in ConnectionCredentials
  // openai, anthropic
  baseUrl          : String(500);
  organization     : String(100);
  project          : String(100);
  anthropicVersion : String(20);
  // sap-ai-core
  resourceGroup    : String(64) default 'default';
  productive       : Boolean;               // required at creation; the tenant's billing follows it
  priceRegion      : String(50);            // capacity-unit price region; null = the parsed region
  // Read-only status, set by the credential store and the connection test
  credentialHint      : String(20);         // e.g. 'abcd…wxyz'
  credentialUpdatedAt : Timestamp;
  lastTestAt          : Timestamp;
  lastTestResult      : String(500);
  models           : Composition of many ConnectionModels on models.connection = $self;
}

annotate ProviderConnections with @assert.unique: { name: [ name ] };

/** A model a connection offers. Published models reach the gateway's model list; publishing needs a list price. */
entity ConnectionModels : cuid, managed {
  connection    : Association to ProviderConnections;
  upstreamModel : String(64) not null;      // what the provider calls it: Azure deployment, Bedrock model id, OpenAI/Anthropic model
  modelId       : String(100) not null;     // `<upstreamModel>--<connection name>`, computed on create
  displayName   : String(100);
  family        : String(8) not null;       // openai | claude: decides the routes that serve it
  capabilities  : String(200);              // JSON array: chat, responses, embeddings, streaming, tools, vision
  isPublished   : Boolean default false;
}

annotate ConnectionModels with @assert.unique: { modelId: [ modelId ] };

/**
 * The encrypted credential of a connection (connectionCredentialStore.ts), one row per connection.
 * Deliberately no composition or backlink from ProviderConnections and no projection on any
 * service: ciphertext must never be readable or expandable over OData (see SiemCredentials).
 */
entity ConnectionCredentials : cuid, managed {
  connection : Association to ProviderConnections;
  ciphertext : LargeString;                 // hex; LargeString because cds caps String at 5000 on Postgres
  iv         : String(32);                  // hex, 16 bytes, unique per write
  salt       : String(64);                  // hex, 32 bytes, unique per write
  authTag    : String(32);                  // hex, 16 bytes, GCM integrity tag
  algorithm  : String(20) default 'aes-256-gcm';
}

annotate ConnectionCredentials with @assert.unique: { connection: [ connection ] };

/**
 * An SAP AI Core tenant (spec 2026-10-25 §6): the subaccount a service key belongs to, keyed by the
 * `<subdomain>.<landscape>` of its auth URL host - the name the gateway derives for the same key
 * (tenantFromAuthUrl), and stable across key rotation. Created or updated when a service key is stored on an sap-ai-core
 * connection; its billing settings (productive, price region) come from that connection.
 */
entity SapTenants : managed {
  key zone        : String(100);            // <subdomain>.<landscape> of the auth URL host, lower-cased
  zoneId          : String(64);             // identityzoneid
  region          : String(50);             // as parsed from the AI API URL, e.g. prod.eu-central-1
  displayName     : String(100);
  productive      : Boolean;
  priceRegion     : String(50);
}

/**
 * The once-only SAP tenant backfill of usage rows older than the tenant column (sap-tenant-backfill.ts):
 * its single row says the backfill ran, for which zone, up to which moment, and how many rows it changed.
 */
entity SapTenantBackfill {
  key ID          : String(20);
  zone            : String(100);
  bound           : Timestamp;              // rows before this moment were backfilled
  rowsUpdated     : Integer;
  ranAt           : Timestamp;
}
