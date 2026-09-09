namespace sap.llm.gateway.admin;

using { cuid, managed } from '@sap/cds/common';

/**
 * Snapshot of the gateway's /v1/models list (one row per model id, including the
 * `<model>--deployed` entries). Refreshed by modelCostService.upsertLibrarySnapshot on the
 * Valkey model-list event, the daily pull, and the refreshModelLibrary action. Rows are never
 * deleted: a model missing from a refresh is marked absent and returns when SAP lists it again.
 */
entity LibraryModels : managed {
  key modelId        : String(120);
  baseModel          : String(100);
  displayName        : String(100);
  description        : String(500);
  provider           : String(50);
  executableId       : String(50);
  provisioning       : String(12);   // hosted | managed | remote
  accessType         : String(12);   // foundation | deployment
  llmAccess          : Boolean default false;
  orchestration      : Boolean default false;
  latestVersion      : String(50);
  versionCount       : Integer default 0;
  contextLength      : Integer;
  streamingSupported : Boolean default false;
  deprecated         : Boolean default false;
  retirementDate     : Date;
  capabilities       : String(200);  // JSON array as published
  inputTypes         : String(100);  // JSON array as published
  capText            : Boolean default false;
  capImageRecognition : Boolean default false;
  capImageGeneration  : Boolean default false;
  capReasoning       : Boolean default false;
  capEmbedding       : Boolean default false;
  capSpeechToText    : Boolean default false;
  inText             : Boolean default false;
  inImage            : Boolean default false;
  inAudio            : Boolean default false;
  inVideo            : Boolean default false;
  benchmarks         : LargeString;  // JSON: latest version's metadata array
  versions           : LargeString;  // JSON: full versions array
  deployment         : LargeString;  // JSON: { configurationId, configurationName, deploymentUrl, scenarioId }
  sapInputCost         : Decimal(10,6);
  sapOutputCost        : Decimal(10,6);
  sapCacheReadCost     : Decimal(10,6);
  sapCacheCreationCost : Decimal(10,6);
  lastSeenAt         : Timestamp;
  absent             : Boolean default false;
}

/**
 * Entitlement catalogs. Exactly one row has isDefault = true (seeded at startup, never deleted).
 * Admin catalogs have parent = null and ownerEmail = null. A user catalog has ownerEmail = the
 * user and parent = the catalog assigned to that user (or the default); its members must be a
 * subset of the parent's effective set. Effective set: default = all non-absent LibraryModels
 * minus exclusions; any other catalog = its members.
 */
@cds.persistence.index: [
  { name: 'idx_modelcatalogs_owner', columns: ['ownerEmail'] },
  { name: 'idx_modelcatalogs_parent', columns: ['parent_ID'] }
]
entity ModelCatalogs : cuid, managed {
  name          : String(100) not null;
  description   : String(500);
  isDefault     : Boolean default false;
  ownerEmail    : String(255);
  parent        : Association to ModelCatalogs;
  members       : Composition of many ModelCatalogMembers on members.catalog = $self;
  exclusions    : Composition of many ModelCatalogExclusions on exclusions.catalog = $self;
}

@assert.unique: { member: [catalog, modelId] }
entity ModelCatalogMembers : cuid {
  catalog     : Association to ModelCatalogs not null;
  modelId     : String(120) not null;
  displayName : String(100);
}

@assert.unique: { exclusion: [catalog, modelId] }
entity ModelCatalogExclusions : cuid {
  catalog : Association to ModelCatalogs not null;
  modelId : String(120) not null;
  reason  : String(255);
}

/**
 * Legacy: drained into Users.entitlementCatalog by the startup migration
 * (usersService.migrateCatalogAssignments); stays declared, empty, for one release.
 */
entity ModelCatalogAssignments : managed {
  key email : String(255);
  catalog   : Association to ModelCatalogs not null;
}
