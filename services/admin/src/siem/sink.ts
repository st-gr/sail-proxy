import { SiemEvent } from './siemEvent';
import type { SecretResolver } from './secretResolver';

/**
 * Every sink implements this and knows nothing about the queue, the outbox or retry
 * policy. Adding a sink means adding one file and one config block.
 */
export interface SiemSink {
  readonly name: string;
  /**
   * Per-sink opt-in for SiemEvent.actor.credential_material — the full raw value of an
   * unresolved credential (see gateway's utils/credentialIdentity.ts). Default false. The
   * dispatcher (siem/dispatcher.ts) strips credential_material from every batch before
   * send() unless this is true, since one outbox row can be delivered to multiple sinks
   * with different settings.
   */
  readonly includeCredentialMaterial: boolean;
  /**
   * Per-sink opt-in for SiemEvent.content — the request's prompt and response. Default
   * false. The dispatcher removes `content` from every batch before send() unless this is
   * true. Even with it true the content is the MASKED form unless allowUnmaskedContent is
   * also set; see contentForSink in siemEvent.ts.
   */
  readonly includeContent: boolean;
  /**
   * Per-sink opt-in to receive content the pseudonymization pipeline never masked — raw
   * conversation text. Default false, and meaningless on its own: it is only consulted for
   * a sink that also has includeContent. This is the only flag combination under which an
   * unmasked prompt leaves this process, and it exists so that path is an explicit operator
   * decision rather than something discovered later.
   */
  readonly allowUnmaskedContent: boolean;
  /** Returns a list of problems; empty means the config is usable. Never throws. */
  validateConfig(): string[];
  /** Cheap reachability probe for the admin UI's health display. */
  healthCheck(): Promise<boolean>;
  /** Throws on failure. Attach `retryable: false` for errors retrying cannot fix. */
  send(batch: SiemEvent[]): Promise<void>;
}

export class SinkError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
    this.name = 'SinkError';
  }
}

const UNSERIALIZABLE_MARKER = '[unserializable]';
const CIRCULAR_MARKER = '[circular]';

/**
 * Replaces a value JSON.stringify cannot represent (a BigInt, a function, a symbol) or
 * cannot safely walk into (a throwing getter, on access) with a fixed, content-blind marker,
 * and breaks a circular reference the same way. Recurses into plain objects and arrays;
 * every other primitive (string, number, boolean, null, undefined) passes through unchanged.
 *
 * `seen` tracks only the current ancestor chain, not every object visited: it is removed
 * again once a branch finishes, so the same object appearing twice as SIBLINGS (a DAG, not a
 * cycle) still serializes twice, matching JSON.stringify's own cycle detection.
 */
function toSafeValue(value: unknown, seen: WeakSet<object>): unknown {
  const t = typeof value;
  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    return UNSERIALIZABLE_MARKER;
  }
  if (value === null || t !== 'object') {
    return value;
  }
  if (seen.has(value as object)) {
    return CIRCULAR_MARKER;
  }
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map(item => {
        try {
          return toSafeValue(item, seen);
        } catch {
          return UNSERIALIZABLE_MARKER;
        }
      });
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as object)) {
      try {
        // Reading the property is itself the risky step for a throwing getter -- the
        // access happens here, inside this try, not inside the recursive call.
        result[key] = toSafeValue((value as Record<string, unknown>)[key], seen);
      } catch {
        result[key] = UNSERIALIZABLE_MARKER;
      }
    }
    return result;
  } finally {
    seen.delete(value as object);
  }
}

/**
 * `JSON.stringify` that cannot throw. Used at both ingest (outbox.ts, writing
 * SiemOutbox.payload) and at send time by every sink that builds its own request body from a
 * batch — see siem-serialization-safety.test.ts for what an unguarded `JSON.stringify` costs
 * today without this: a single BigInt, circular reference, or throwing getter anywhere in an
 * event makes the whole call throw. At ingest that throw happens before the SiemOutbox row is
 * even written, which — worse than a failed delivery attempt — leaves the source stream entry
 * permanently unacked for redelivery (securityEventSubscriber.ts).
 *
 * The common case (a plain, JSON-safe SiemEvent — everything that legitimately reaches this
 * codebase's typed construction path in `toSiemEvent`) costs nothing extra: the direct
 * `JSON.stringify` below succeeds and returns immediately. Only a value that would otherwise
 * throw pays for the recursive fallback walk.
 *
 * The fallback never calls `String()`/`.toString()` on the value it cannot represent —
 * unlike LiteLLM's own `safe_dumps` (litellm/litellm_core_utils/safe_json_dumps.py), which
 * falls back to a value's string form. That is a deliberate divergence, not an oversight: a
 * value's own `toString()` can echo arbitrary content (an `Error`'s message, a class's custom
 * `toString()`), including a credential that happens to be the very thing that failed to
 * serialize. Every value the fallback cannot represent becomes a fixed marker instead, never
 * the value itself.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    try {
      return JSON.stringify(toSafeValue(value, new WeakSet())) ?? 'null';
    } catch {
      return `"${UNSERIALIZABLE_MARKER}"`;
    }
  }
}

/**
 * Resolves a sink credential by the slot name recorded in api_config.json. Returns undefined
 * when no credential is stored - there is no environment fallback. A caller that injects no
 * resolver therefore resolves nothing, which is deliberate: a sink with no credential source
 * must fail validateConfig() rather than silently reach for process.env.
 */
export function resolveSecret(
  cfg: { getSecret?: SecretResolver },
  name: string | undefined,
): string | undefined {
  if (!name) return undefined;
  return cfg.getSecret?.(name);
}
