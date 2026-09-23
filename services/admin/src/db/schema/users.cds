namespace sap.llm.gateway.admin;

using { cuid, managed } from '@sap/cds/common';
using { sap.llm.gateway.admin.ModelCatalogs as ModelCatalogs } from './model-library';
using { sap.llm.gateway.admin.ToolPolicies as ToolPolicies, sap.llm.gateway.admin.ToolUsageDaily as ToolUsageDaily } from './tool-governance';

/**
 * One row per person the platform knows (spec §1). Created lazily by usersService.touch (whoami,
 * preferences, credential creation, usage batches) and by the startup backfill; never deleted.
 * Constraint columns: null = inherit platform.quotas; a platform null = unlimited.
 */
entity Users : managed {
  key email             : String(255);
  displayName           : String(255);
  rolesSnapshot         : String(500);        // JSON array, refreshed on contact
  firstSeenAt           : Timestamp;
  lastSeenAt            : Timestamp;
  @assert.range
  status                : String(12) enum { active; deactivated } default 'active';
  statusChangedAt       : Timestamp;
  statusChangedBy       : String(255);
  statusReason          : String(500);
  requestsPerMinute     : Integer;
  spendPerDay           : Decimal(12,4);      // SAP cost, currency of SapCapacityUnitPrice
  spendPerWeek          : Decimal(12,4);
  spendPerMonth         : Decimal(12,4);
  tokensPerDay          : Integer64;
  tokensPerWeek         : Integer64;
  tokensPerMonth        : Integer64;
  quotaResetAt          : Timestamp;          // watermark: usage before it does not count
  entitlementCatalog    : Association to ModelCatalogs;   // null = the default catalog (spec §7.2 item 1)
  quotaProfile          : Association to QuotaProfiles;   // null = no profile: platform.quotas applies (spec §2)
  toolPolicy            : Association to ToolPolicies;    // null = the default tool policy (tool governance spec §4)
  toolUsageDaily        : Association to many ToolUsageDaily on toolUsageDaily.email = $self.email;
}

/** A named set of the seven quota limits an administrator assigns per user (spec 2026-09-08). A null limit says nothing: the platform default applies. */
@assert.unique: { name: [name] }
entity QuotaProfiles : cuid, managed {
  name              : String(100) not null;
  description       : String(500);
  requestsPerMinute : Integer;
  spendPerDay       : Decimal(12,4);
  spendPerWeek      : Decimal(12,4);
  spendPerMonth     : Decimal(12,4);
  tokensPerDay      : Integer64;
  tokensPerWeek     : Integer64;
  tokensPerMonth    : Integer64;
  // How many users carry this profile, counted in the service's after-READ
  // (admin-service-quota-profiles.ts). Declared virtual HERE and not as a computed column of the
  // service projection: a projection that adds one deploys as a view SQLite will not insert into,
  // and QuotaProfiles is admin CRUD (same reason as ApiKeys' virtual field-control elements).
  @Core.Computed virtual assignedUsers : Integer;
}

/**
 * Both credential kinds of a user in one read-only shape for API consumers (spec §4). Not
 * persisted: served by an `on READ` handler in admin-service-users.ts.
 */
@cds.persistence.skip
entity UserCredentials {
  key credentialId          : UUID;
  type                      : String(16);     // api_key | aws_credential
  email                     : String(255);
  name                      : String(100);
  isActive                  : Boolean;
  lockedByUserDeactivation  : Boolean;
  expiresAt                 : Timestamp;
  neverExpires              : Boolean;
  lastUsed                  : Timestamp;
}

/**
 * One row per user, UTC calendar day and cost currency: the running usage counters the quota
 * windows are derived from (spec 2026-09-07-user-usage-counters-design §3.1). Maintained by the
 * usage processor in the transaction that persists the rows; rebuilt from the rows by
 * usageCounters.rebuild(). Not exposed through OData.
 */
entity UserUsageDaily {
  key email    : String(255);
  key day      : Date;            // UTC calendar date of the usage row's validFrom
  key currency : String(3);       // sapCostCurrency of the rows, '' when they carry none
  requests     : Integer64 default 0;
  tokens       : Integer64 default 0;   // input + output + cacheCreationInput (fresh tokens; cache reads are priced, not counted)
  sapCost      : Decimal(12,6) default 0;
  updatedAt    : Timestamp;
}
