/**
 * The one normalized payload every SIEM sink consumes.
 *
 * Narrower than LiteLLM's StandardLoggingPayload, which carries `messages` and `response`
 * unconditionally — shipping prompts to a SIEM by default is the failure mode documented in
 * docs/competitive/improvements/08-error-envelope-leak.md. Here conversation content is
 * carried only by a `usage`-category event, only in its masked form, and only when an
 * operator has opted a sink into it: `include_content` for content at all, and
 * `allow_unmasked_content` for content the pseudonymization pipeline never masked. Both
 * default false, both are per sink, and both are enforced twice — at emission (the gateway
 * attaches nothing no enabled sink asked for, so unwanted content never sits at rest in the
 * outbox) and at send (siem/dispatcher.ts strips per sink copy).
 *
 * `schema_version` is mandatory: SIEM parsers are built against a shape and break when it
 * changes silently.
 */
export const SIEM_SCHEMA_VERSION = '1.0';

export interface SiemEvent {
  schema_version: string;
  event_id: string;
  timestamp: string;                       // ISO 8601
  category: 'security' | 'audit' | 'usage';
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  outcome: 'success' | 'failure' | 'unknown';
  actor: {
    credential_id?: string;
    // First 8 characters of the presented value, set only when credential_id is a hash of
    // an unresolved credential (see gateway's utils/credentialIdentity.ts) — format
    // identification (sk-proj-, ghp_, AKIA, xoxb-) without the secret.
    credential_hint?: string;
    // The full presented value for an unresolved credential. Carried through the durable
    // outbox but stripped before every sink send (siem/dispatcher.ts) unless that sink's
    // own `include_credential_material` config opts in — default false.
    credential_material?: string;
    auth_type?: string;
    client_ip?: string;
    user_agent?: string;
  };
  resource: {
    resource_type?: string;
    resource_id?: string;
    model?: string;
    endpoint?: string;
  };
  request: {
    request_id?: string;
    status?: number;
  };
  description?: string;
  /**
   * The request's prompt and response, for a `usage`-category event only. Absent unless at
   * least one enabled sink had `include_content: true` when the event was emitted — see the
   * ruling in the module doc above. Never present on a security or audit event.
   */
  content?: {
    prompt?: string;
    response?: string;
    /** True when prompt or response was cut at `siem.content_max_bytes`. */
    truncated?: boolean;
    /**
     * Whether the pseudonymization pipeline actually masked this request. False means raw
     * conversation text, which only ever reaches a sink whose `allow_unmasked_content` is
     * true; every other sink gets `omitted: 'not-masked'` instead (siem/dispatcher.ts).
     * Carried explicitly rather than inferred, because "no placeholder in the text" is not
     * the same as "masking did not run" — a request with no PII produces neither.
     */
    masked?: boolean;
    /**
     * Set when content was omitted rather than shipped, with the reason. `'not-masked'` is
     * what a sink without `allow_unmasked_content` sees in place of unmasked content.
     * `'stream-incomplete'` is a streamed request whose stream errored or was abandoned by
     * the client: the prompt is present and the response is not, because a partial answer
     * must not be shipped as though it were the whole one.
     * `'not-requested'` is reserved and unset by any producer today: a sink that did not
     * ask for content has the whole `content` field removed rather than replaced, so there
     * is nothing left to carry a reason on.
     */
    omitted?: 'not-masked' | 'not-requested' | 'stream-incomplete';
  };
  /**
   * What the pseudonymization pipeline did to this request, in COUNTS, for a
   * `usage`-category event only. Absent when the plugin did not run.
   *
   * Deliberately a sibling of `content` rather than a member of it, and deliberately not
   * subject to either content gate: it carries no conversation text, so an operator who has
   * opted no sink into content still receives it. `categories` is distinct masked values per
   * category and `masked_values` the distinct total; `saturated` says whether the request
   * passed `pseudonymization.saturation_warn` (default 40). Nothing here can identify a
   * masked value — see the gateway's plugins/pseudonymization/saturationReport.ts.
   *
   * Additive at `schema_version` 1.0: an existing parser reads the fields it knows and is
   * unaffected by a new optional one, so this is not a breaking change and the version is
   * not bumped. A REMOVED or RESHAPED field would be.
   */
  pseudonymization?: {
    masked_values: number;
    categories: Record<string, number>;
    saturated: boolean;
  };
}

/** A gateway security event as persisted by securityEventService. */
export interface SecurityEventLike {
  eventId: string; eventType: string; severity: string; description?: string;
  timestamp?: string; credentialId?: string; credentialHint?: string; credentialMaterial?: string;
  authType?: string; clientIP?: string;
  userAgent?: string; endpoint?: string; requestId?: string; statusCode?: number;
}

/**
 * A gateway request-completion event, published to the same `siem-events` stream as a
 * security event but carrying `category: 'usage'` — see the gateway's
 * services/siemUsageEvent.ts. It is NOT persisted to the domain security-event tables
 * (securityEventSubscriber.ts skips that step for it); the outbox is its only home.
 */
export interface UsageEventLike {
  /** The discriminator. Only this exact value takes the usage branch. */
  category: 'usage';
  eventId: string;
  eventType?: string;
  severity?: string;
  timestamp?: string;
  credentialId?: string;
  authType?: string;
  clientIP?: string;
  userAgent?: string;
  endpoint?: string;
  requestId?: string;
  statusCode?: number;
  model?: string;
  description?: string;
  content?: {
    prompt?: string;
    response?: string;
    truncated?: boolean;
    masked?: boolean;
    omitted?: string;
  };
  /** Counts only — see SiemEvent.pseudonymization. */
  pseudonymization?: {
    masked_values?: number;
    categories?: Record<string, number>;
    saturated?: boolean;
  };
}

/** An admin audit event as persisted by auditEventService (Plan 1 Task 3). */
export interface AuditEventLike {
  ID: string; createdAt?: string; actorId?: string; actorType?: string; action: string;
  resourceType?: string; resourceId?: string; outcome?: string; severity?: string;
  clientIP?: string; userAgent?: string; details?: string;
}

// Caps for fields that are forwarded verbatim from attacker- or upstream-influenced input:
// `description` interpolates upstream error text (securityEventEmitter.ts), `user_agent` is
// the client-supplied header, and `endpoint` is `req.originalUrl` — unbounded and carrying
// the full, attacker-controlled query string. None of these should be able to smuggle
// conversation-length content into a SIEM payload just because the field they land in
// happens to be a string.
const MAX_USER_AGENT_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 500;

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/** Keeps the path, drops the query string — which is attacker-controlled and unbounded. */
function stripQueryString(endpoint: string | undefined): string | undefined {
  if (!endpoint) return endpoint;
  const i = endpoint.indexOf('?');
  return i === -1 ? endpoint : endpoint.slice(0, i);
}

// The spec is explicit that actor carries "never the key material". Truncating a raw key
// to a fixed-length prefix (this normalizer's previous approach) is NOT sufficient — a
// prefix of a secret is still secret material. The source is now responsible for never
// handing this normalizer anything unsafe: a resolved credential arrives as the stored
// row's ID (ApiKeys/AwsCredentials are cuid — already opaque; see rotateApiKey /
// rotateAwsCredentials in admin-service.ts), an unresolved one arrives pre-hashed with a
// separate credential_hint (see gateway's utils/credentialIdentity.ts), and a sentinel
// ('missing', 'unknown') arrives as-is. credential_id is therefore passed through
// unmodified here; masking it further would only destroy correlation value for the
// already-safe row-ID case.

// Both markers — not `action` alone — are required to take the audit branch. `action`
// by itself is too weak a discriminator: a security event could carry a same-named field
// and get routed to the audit branch, where `event_id` reads `.ID` (absent on a security
// event) and the real event id is silently dropped. Requiring `ID` too keeps a spurious
// `action` on a security-shaped input from hijacking the branch.
function isAudit(e: Partial<SecurityEventLike & AuditEventLike>): e is AuditEventLike {
  return typeof e.action === 'string' && typeof e.ID === 'string';
}

// Same two-marker discipline as isAudit: the literal category AND an event id. `category`
// is a field no security or audit event carries, so nothing already flowing through this
// normalizer can be rerouted into the usage branch — which is the branch that may carry
// conversation content, and therefore the one that must be hardest to reach by accident.
function isUsage(e: Partial<SecurityEventLike & AuditEventLike & UsageEventLike>): e is UsageEventLike {
  return e.category === 'usage' && typeof e.eventId === 'string';
}

const OMISSION_REASONS: readonly string[] = ['not-masked', 'not-requested', 'stream-incomplete'];

/**
 * Rebuilds the content block field by field. Explicit-literal like the rest of this
 * normalizer, never a spread: an unknown key on the wire must not become part of a
 * SiemEvent, and this is the one field on the event whose payload is conversation text.
 *
 * Truncation itself happens at the gateway, before the event is ever published (it holds
 * `siem.content_max_bytes` and the text); this only carries the flag through.
 */
function contentOf(content: UsageEventLike['content']): SiemEvent['content'] {
  if (!content || typeof content !== 'object') return undefined;
  return {
    prompt: typeof content.prompt === 'string' ? content.prompt : undefined,
    response: typeof content.response === 'string' ? content.response : undefined,
    truncated: content.truncated === true,
    masked: content.masked === true,
    omitted: OMISSION_REASONS.includes(content.omitted as string)
      ? (content.omitted as 'not-masked' | 'not-requested' | 'stream-incomplete')
      : undefined,
  };
}

/**
 * Bounds on the ONE open-keyed map this normalizer carries. Everything else here is an
 * explicit literal precisely so an unknown key on the wire cannot become part of a
 * SiemEvent; a per-category histogram cannot be enumerated that way, so it is bounded
 * instead. The gateway produces at most 27 categories and a category name is a
 * `profile-*` token, so both caps are far above anything a real event carries and exist
 * only to stop a malformed or hostile publisher writing conversation-sized data into the
 * outbox through a field that is supposed to hold counts.
 */
const MAX_PSEUDONYMIZATION_CATEGORIES = 64;
const MAX_CATEGORY_KEY_LENGTH = 64;

/**
 * Rebuilds the pseudonymization block field by field, like `contentOf`. Counts only: a value
 * that is not a finite, non-negative number is dropped rather than coerced, so the block
 * either reports a real count or does not report that category at all.
 */
function pseudonymizationOf(
  block: UsageEventLike['pseudonymization']
): SiemEvent['pseudonymization'] {
  if (!block || typeof block !== 'object') return undefined;
  if (typeof block.masked_values !== 'number' || !Number.isFinite(block.masked_values)) return undefined;

  const categories: Record<string, number> = {};
  const source = block.categories;
  if (source && typeof source === 'object') {
    for (const [type, count] of Object.entries(source)) {
      if (Object.keys(categories).length >= MAX_PSEUDONYMIZATION_CATEGORIES) break;
      if (type.length > MAX_CATEGORY_KEY_LENGTH) continue;
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) continue;
      categories[type] = count;
    }
  }

  return {
    masked_values: block.masked_values,
    categories,
    saturated: block.saturated === true,
  };
}

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
function severityOf(v: unknown): SiemEvent['severity'] {
  return (SEVERITIES as readonly string[]).includes(v as string)
    ? (v as SiemEvent['severity'])
    : 'low';
}

export function toSiemEvent(
  input: SecurityEventLike | AuditEventLike | UsageEventLike | null | undefined
): SiemEvent {
  // Events arrive from an outbox/DB read that can legitimately come back empty (a missing
  // row is `undefined`, not a thrown error upstream). Degrade to the same defaults an
  // empty object already gets, rather than throwing and stopping the ingest path.
  const source = (input ?? {}) as Partial<SecurityEventLike & AuditEventLike & UsageEventLike>;

  if (isUsage(source)) {
    return {
      schema_version: SIEM_SCHEMA_VERSION,
      event_id: source.eventId,
      timestamp: source.timestamp || new Date().toISOString(),
      category: 'usage',
      type: source.eventType ?? 'request_completed',
      severity: severityOf(source.severity),
      // A usage event records a request that finished, so its outcome is the request's own:
      // an upstream 500 is a failure even though nothing about the export went wrong.
      outcome: typeof source.statusCode !== 'number' ? 'unknown'
        : source.statusCode >= 400 ? 'failure' : 'success',
      actor: {
        credential_id: source.credentialId,
        auth_type: source.authType,
        client_ip: source.clientIP,
        user_agent: truncate(source.userAgent, MAX_USER_AGENT_LENGTH),
      },
      resource: { model: source.model, endpoint: stripQueryString(source.endpoint) },
      request: { request_id: source.requestId, status: source.statusCode },
      description: truncate(source.description, MAX_DESCRIPTION_LENGTH),
      content: contentOf(source.content),
      pseudonymization: pseudonymizationOf(source.pseudonymization),
    };
  }

  if (isAudit(source)) {
    return {
      schema_version: SIEM_SCHEMA_VERSION,
      event_id: source.ID,
      timestamp: source.createdAt || new Date().toISOString(),
      category: 'audit',
      type: source.action,
      severity: severityOf(source.severity),
      outcome: source.outcome === 'failure' ? 'failure' : 'success',
      actor: {
        credential_id: source.actorId,
        auth_type: source.actorType,
        client_ip: source.clientIP,
        user_agent: truncate(source.userAgent, MAX_USER_AGENT_LENGTH),
      },
      resource: { resource_type: source.resourceType, resource_id: source.resourceId },
      request: {},
      description: truncate(source.details, MAX_DESCRIPTION_LENGTH),
    };
  }

  return {
    schema_version: SIEM_SCHEMA_VERSION,
    event_id: source.eventId ?? '',
    timestamp: source.timestamp || new Date().toISOString(),
    category: 'security',
    type: source.eventType ?? 'unknown',
    severity: severityOf(source.severity),
    outcome: 'failure',              // a security event records something that went wrong
    actor: {
      credential_id: source.credentialId,
      credential_hint: source.credentialHint,
      credential_material: source.credentialMaterial,
      auth_type: source.authType,
      client_ip: source.clientIP,
      user_agent: truncate(source.userAgent, MAX_USER_AGENT_LENGTH),
    },
    resource: { endpoint: stripQueryString(source.endpoint) },
    request: { request_id: source.requestId, status: source.statusCode },
    description: truncate(source.description, MAX_DESCRIPTION_LENGTH),
  };
}

/**
 * Strips actor.credential_material from an event unless the destination sink has
 * explicitly opted in (SiemSink.includeCredentialMaterial). Called per-sink at dispatch
 * time (siem/dispatcher.ts), not once at normalization, because a single outbox row can be
 * delivered to multiple sinks with different `include_credential_material` settings — the
 * default-false sink must never see it even if another enabled sink is opted in.
 */
export function withoutCredentialMaterial(event: SiemEvent): SiemEvent {
  if (event.actor.credential_material === undefined) return event;
  const { credential_material, ...actorRest } = event.actor;
  return { ...event, actor: actorRest };
}

/** What a sink is allowed to receive. Mirrors the three per-sink flags on SiemSink. */
export interface SinkRedactionPolicy {
  includeCredentialMaterial: boolean;
  includeContent: boolean;
  allowUnmaskedContent: boolean;
}

/**
 * Removes `content` unless this sink may have it:
 *
 * - no `include_content` → the field is removed entirely, leaving a metadata-only event;
 * - content the pipeline never masked, and no `allow_unmasked_content` → the text is
 *   replaced by `{ omitted: 'not-masked' }`, so the sink can see that a conversation
 *   existed and why it is not here, without receiving a word of it.
 *
 * Masked content passes through unchanged to any sink with `include_content`.
 */
export function contentForSink(event: SiemEvent, policy: SinkRedactionPolicy): SiemEvent {
  if (event.content === undefined) return event;

  if (!policy.includeContent) {
    const { content, ...rest } = event;
    return rest;
  }
  if (event.content.masked !== true && !policy.allowUnmaskedContent) {
    return { ...event, content: { omitted: 'not-masked' } };
  }
  return event;
}

/**
 * The one redaction pass the dispatcher applies per sink. Returns a COPY whenever anything
 * is removed — never mutates the argument — because one outbox row is delivered to every
 * sink and they read the same in-memory batch: redacting in place would take the field away
 * from a sink that had opted in, or (worse, in the other order) hand it to one that had not.
 */
export function redactForSink(event: SiemEvent, policy: SinkRedactionPolicy): SiemEvent {
  const withContent = contentForSink(event, policy);
  return policy.includeCredentialMaterial
    ? withContent
    : withoutCredentialMaterial(withContent);
}
