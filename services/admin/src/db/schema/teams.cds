// services/admin/src/db/schema/teams.cds
namespace sap.llm.gateway.admin;

using { cuid, managed } from '@sap/cds/common';
using { sap.llm.gateway.admin.Users as Users, sap.llm.gateway.admin.QuotaProfiles as QuotaProfiles } from './users';
using { sap.llm.gateway.admin.ModelCatalogs as ModelCatalogs } from './model-library';
using { sap.llm.gateway.admin.ToolPolicies as ToolPolicies } from './tool-governance';
using { sap.llm.gateway.admin.ApiKeys as ApiKeys, sap.llm.gateway.admin.ApiKeyUsage as ApiKeyUsage } from './api-keys';
using { sap.llm.gateway.admin.AwsCredentials as AwsCredentials, sap.llm.gateway.admin.AwsCredentialUsage as AwsCredentialUsage } from './aws-credentials';

/**
 * A named collection of users (spec 2026-10-14 §3). The seven limits are the team's POOL: every
 * member draws from them together. quotaProfile supplies pool defaults; memberQuotaProfile is the
 * per-member default (lowest across a user's teams); the catalog intersects with the owner's; the
 * tool policy adds a third block to the merge. A null association adds nothing.
 */
@assert.unique: { name: [name] }
entity Teams : cuid, managed {
  name                : String(100) not null;
  description         : String(500);
  requestsPerMinute   : Integer;
  spendPerDay         : Decimal(12,4);
  spendPerWeek        : Decimal(12,4);
  spendPerMonth       : Decimal(12,4);
  tokensPerDay        : Integer64;
  tokensPerWeek       : Integer64;
  tokensPerMonth      : Integer64;
  quotaResetAt        : Timestamp;                        // pool watermark, like Users.quotaResetAt
  quotaProfile        : Association to QuotaProfiles;     // pool defaults
  memberQuotaProfile  : Association to QuotaProfiles;     // per-member default
  entitlementCatalog  : Association to ModelCatalogs;     // null = the default catalog
  toolPolicy          : Association to ToolPolicies;      // null = adds no block
  members             : Composition of many TeamMembers on members.team = $self;
  // Counted in the service's after-READ (admin-service-teams.ts); virtual HERE for the same reason
  // as QuotaProfiles.assignedUsers: a projection with a computed column deploys as a view SQLite
  // will not insert into.
  @Core.Computed virtual memberCount : Integer;
}

/** One row per (team, user). The first membership of a user is primary; exactly one stays primary. */
@assert.unique: { member: [team, email] }
entity TeamMembers : cuid, managed {
  team      : Association to Teams not null;
  email     : String(255) not null;                       // Users.email; touched into existence
  role      : String(8) not null default 'member';        // member | admin (validated in the handler)
  isPrimary : Boolean default false;
  user      : Association to Users on user.email = $self.email;
}

/**
 * One row per team, UTC day and cost currency: the pool's running counters, the sibling of
 * UserUsageDaily (same upsert, same 62-day retention). Not exposed through OData.
 */
entity TeamUsageDaily {
  key teamId   : UUID;
  key day      : Date;
  key currency : String(3);
  requests     : Integer64 default 0;
  tokens       : Integer64 default 0;
  sapCost      : Decimal(12,6) default 0;
  externalCost : Decimal(14,6) default 0;   // Connection list cost, kept apart from sapCost (it counts toward spend quotas)
  updatedAt    : Timestamp;
}

// Additive columns on existing tables (nullable: SQLite self-heals them, Postgres evolution adds them).
extend ApiKeys with {
  team : Association to Teams;   // null = the owner's primary team at request time
  virtual effectiveTeamName : String(100);   // the request team's name (admin-service-credential-teams.ts)
  virtual followsPrimaryTeam : Boolean;      // true when `team` is null and the owner's primary applies
}
extend AwsCredentials with {
  team : Association to Teams;
  virtual effectiveTeamName : String(100);
  virtual followsPrimaryTeam : Boolean;
}
extend ApiKeyUsage with {
  team     : Association to Teams;   // snapshot at ingestion: what was enforced is what is billed
  teamName : String(100);
}
extend AwsCredentialUsage with {
  team     : Association to Teams;
  teamName : String(100);
}
extend Users with {
  memberships : Association to many TeamMembers on memberships.email = $self.email;
}
extend QuotaProfiles with {
  @Core.Computed virtual assignedTeams : Integer;   // teams using it as pool or member profile
}
extend ToolPolicies with {
  assignedTeams : Association to many Teams on assignedTeams.toolPolicy = $self;
}
