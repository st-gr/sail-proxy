namespace sap.llm.gateway.admin;

using { cuid, managed } from '@sap/cds/common';

/**
 * Operator and system actions, in the actor / action / resource / outcome shape auditors
 * expect. Distinct from *SecurityEvents, which describe what happened to a caller; this
 * records what an operator did, and its subject is often configuration rather than a credential.
 */
entity AuditEvents : cuid, managed {
  actorId       : String(200);   // operator identity, or 'system'
  actorType     : String(40);    // admin_user | user | system | api_key
  action        : String(80);    // api_key.create | api_key.rotate | config.update | ...
  resourceType  : String(60);    // ApiKey | AwsCredential | ApiConfiguration
  resourceId    : String(200);
  outcome       : String(20);    // success | failure
  severity      : String(20);    // low | medium | high | critical
  clientIP      : String(45);    // sized for IPv6, matching ApiKeySecurityEvents
  userAgent     : String(500);
  details       : String(1000);
}
