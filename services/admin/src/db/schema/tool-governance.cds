namespace sap.llm.gateway.admin;
using { cuid, managed } from '@sap/cds/common';
using { sap.llm.gateway.admin.Users, sap.llm.gateway.admin.ApiKeys } from './index';

/**
 * Tool governance (spec 2026-09-16): a policy is an allow list plus a deny list of tool identity
 * patterns and a mode. One policy is the default (every user without an assignment); a user may
 * be assigned another; an API key may additionally narrow its owner's policy.
 */
entity ToolPolicies : cuid, managed {
  name          : String(100) not null;
  description   : String(500);
  isDefault     : Boolean default false;
  mode          : String(10) not null default 'monitor';   // monitor | strip | reject
  allows        : Composition of many ToolPolicyAllows on allows.policy = $self;
  denies        : Composition of many ToolPolicyDenies on denies.policy = $self;
  // Trust chain (spec 2026-09-22 §3): tools that act, and tools whose output may carry third-party
  // content. Once such output is in a request, the sensitive tools are withheld under the mode.
  sensitive     : Composition of many ToolPolicySensitive on sensitive.policy = $self;
  untrusted     : Composition of many ToolPolicyUntrusted on untrusted.policy = $self;
  assignedUsersList : Association to many Users on assignedUsersList.toolPolicy = $self;
  assignedKeys  : Association to many ApiKeys on assignedKeys.toolPolicy = $self;
  @Core.Computed virtual assignedUsers : Integer;
}

@assert.unique: { pattern: [policy, pattern] }
entity ToolPolicyAllows : cuid {
  policy  : Association to ToolPolicies not null;
  pattern : String(200) not null;
  note    : String(200);
}

@assert.unique: { pattern: [policy, pattern] }
entity ToolPolicyDenies : cuid {
  policy  : Association to ToolPolicies not null;
  pattern : String(200) not null;
  note    : String(200);
}

@assert.unique: { pattern: [policy, pattern] }
entity ToolPolicySensitive : cuid {
  policy  : Association to ToolPolicies not null;
  pattern : String(200) not null;
  note    : String(200);
}

@assert.unique: { pattern: [policy, pattern] }
entity ToolPolicyUntrusted : cuid {
  policy  : Association to ToolPolicies not null;
  pattern : String(200) not null;
  note    : String(200);
}

/**
 * One row per tool per request: what was declared or invoked and what the policy decided. Purged by
 * retention. Its secondary indexes (validFrom; email, identity) are created at admin boot by
 * src/db/data/tool-usage-indexes.ts, because CAP's schema evolution generates none on SQLite or PostgreSQL.
 */
entity ToolUsage : cuid {
  requestId    : String(100);
  email        : String(255);
  credentialId : UUID;
  authType     : String(20);
  provider     : String(50);
  model        : String(200);
  endpoint     : String(200);
  identity     : String(220);
  facet        : String(10);     // declared | invoked | source
  userAgent    : String(500);    // the caller's User-Agent, verbatim; normalised into ToolUsageAgentDaily.agent
  count        : Integer default 1;
  decision     : String(10);     // allowed | monitored | stripped | rejected | unlisted | detected
  reason       : String(12);     // policy | trust_chain for a denied tool; null when allowed (and on rows before 2026-09-22)
  policy       : Association to ToolPolicies;
  validFrom    : Timestamp;
}

/**
 * Per user, UTC day, identity, facet AND client program: which agent asked for a tool.
 *
 * A separate table rather than an `agent` key on ToolUsageDaily on purpose: adding a column to an
 * existing primary key is not an additive change - PostgreSQL's schema evolution refuses it and the
 * admin container would fail to start - while a new table is picked up by both deploy paths.
 */
entity ToolUsageAgentDaily {
  key email    : String(255);
  key day      : Date;
  key identity : String(220);
  key facet    : String(10);
  key agent    : String(60);     // normalised client program: claude-cli, codex, openai-python, unknown
  requests     : Integer default 0;
  lastSeen     : Timestamp;
}

/** Per user, UTC day, identity and facet: the counts the inventory and the user page read. */
entity ToolUsageDaily {
  key email    : String(255);
  key day      : Date;
  key identity : String(220);
  key facet    : String(10);
  requests     : Integer default 0;
  allowed      : Integer default 0;
  monitored    : Integer default 0;
  stripped     : Integer default 0;
  rejected     : Integer default 0;
  unlisted     : Integer default 0;
  // A tool the policy denies that was USED without being prevented: a nested MCP call inside a
  // client's own container tool, seen in the response. Never claims the call was stopped.
  detected     : Integer default 0;
  // Denials whose reason was the trust chain (a subset of monitored/stripped/rejected).
  trustChained : Integer default 0;
  lastSeen     : Timestamp;
}
