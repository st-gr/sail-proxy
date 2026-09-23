# Tool governance — internals

Spec: `docs/superpowers/specs/2026-09-16-tool-governance-design.md`, extended by
`docs/superpowers/specs/2026-09-22-tool-governance-parity-design.md` §2 (scoped allow lists). Stage
one (pass-through): the gateway never hosts or executes a tool itself, only decides whether a
request may declare one and whether an invocation gets recorded.

## Identity and evaluation

`services/gateway/src/toolGovernance/`:

| File | Responsibility |
|---|---|
| `identity.ts` | `ToolIdentity` (a plain `namespace:name` string), the five constructors (`functionTool`, `hostedTool`, `hostedNamedTool`, `mcpServer`, `mcpTool`), `toolName`/`resolveInvoked` (reconciling an invoked function call with the tool that was declared) `PATTERN_SYNTAX` (`^(function\|hosted\|mcp):([^*\s]+\*?\|\*)$` — the corrected regex that also accepts a bare namespace wildcard such as `function:*`, matched by the admin's own copy in `toolPolicyService.ts`), `matches`/`matchesAny` (exact match, or prefix match when the pattern ends in one `*`) |
| `stripNotice.ts` | the line strip mode adds to the request naming the removed tools; the text is invariant for a given set of tools so a client that is stripped on every turn keeps its prompt cache, and the `[tool policy]` marker keeps a replayed body from accumulating notes |
| `evaluate.ts` | Pure evaluation: `deniedBy(block, identity)` (deny always wins; an empty allow list allows everything not denied); `evaluate(declared, user, key, forced)` merges a user policy and an optional key policy — most restrictive mode wins (`MODE_RANK`: monitor 0 < strip 1 < reject 2), an identity is denied if either block denies it, and under `strip` a `forced` tool (from `tool_choice`) that lands in the denied set flips the whole result to `reject` instead of silently forcing a tool that was just stripped |
| `adapters/{anthropic,openaiChat,responses,gemini}.ts` | One per API family, each a pure `ToolAdapter` (`adapters/types.ts`): `declaredTools`, `forcedTool`, `stripTools` (returns a new body, never mutates), `invokedTools` (non-streaming), `invokedToolsFromChunk`/`invokedToolsFromStream` (SSE), `rejectionBody`. The Responses adapter's `stripTools` narrows an MCP tool's `allowed_tools` rather than dropping the whole `mcp` entry when only some of its tools are denied |
| `middleware.ts` | `toolGovernance(adapter)`, mounted per route; `policyBlocksFromRequest` (NO admin exemption: a tool policy is a security control and binds the holder of the account or key, unlike the model entitlement check) |
| `record.ts` | `req.toolGovernance` state, `recordInvokedTools`, `toolsForEvent` (declared entries first, then invoked, each carrying the identity's decision) |
| `index.ts` | re-exports |

**Scoped allow lists and narrowing a bare server declaration** (2026-09-22 §2). An allow pattern is
*scoped* when it has the form `mcp:<server>/<tool-or-prefix*>` with a literal server; every other
allow pattern is *global* (`function:…`, `hosted:…`, `mcp:<server>` alone, `mcp:git*`, `mcp:*`).
`deniedBy(block, identity)` runs three steps in order: (1) a deny pattern matches → denied; (2) the
identity is `mcp:S/T` and the block has scoped allows for server S → denied unless one of them
matches; (3) otherwise the global allow list applies as before (empty allows everything, non-empty
requires a match). `mcp:S/*` among a block's scoped allows means "all of S's tools" and counts as no
limit. `serverLimit(block, server)` reduces a block's scoped allows for one server to what an
adapter can write into a request: `null` when the block does not limit the server, the tool names
when every scoped allow is a literal name, and the string `'prefix'` when one of them ends in `*`
(unrenderable as a name list).

`evaluate()` uses `serverLimit` to decide what happens to a BARE `mcp:S` declaration — one that
names no tools, so the model could otherwise call any of them, under a block that limits S:

| Mode | Every scoped allow is a literal name | One scoped allow has a trailing `*` |
|---|---|---|
| monitor | `mcp:S` decision `monitored`, `narrow` untouched | same |
| strip | `narrow.set(S, names)` — the intersection of every block's names — decision `stripped` | decision `monitored`, no `narrow` entry (a prefix cannot be rendered as names) |
| reject | `mcp:S` pushed onto `denied`, the whole request refused | same |

`EvaluationResult.narrow: Map<server, string[]>` carries the names strip mode computed. Only the
Responses and Anthropic adapters render it — the two families whose MCP declaration shape can name
tools up front. Responses' `stripTools` writes the names into the bare `{type:'mcp'}` entry's
`allowed_tools`. Anthropic's `stripTools` writes them into the server's PAIRED `mcp_toolset` entry
(`tools[]`, `{type:'mcp_toolset', mcp_server_name}`) as `default_config.enabled: false` plus
`configs.<name>.enabled: true` for each allowed name — MCP connector beta
`mcp-client-2025-11-20`; there is no `tool_configuration.allowed_tools` field on `mcp_servers[]` in
that shape — intersected with whatever the client already enabled (a client-narrowed toolset can
only lose tools to the policy, never gain any); a server without a paired toolset (the deprecated
beta shape) is left unnarrowed. The Gemini and OpenAI-chat adapters declare no MCP shape at all, so
`narrow` never reaches them. The middleware reports every narrowed server on the strip event as a
plain `mcp:<server>` identity, alongside the blocked ones (`middleware.ts`).

Every tool an adapter finds reduces to one string, `namespace:name`: `function:<name>` for a
function tool, `hosted:<type>` for a provider's own built-in tool with any date suffix
stripped (`web_search_20250305` → `hosted:web_search`), `mcp:<server>` for an MCP server as a
whole and `mcp:<server>/<tool>` for one tool on it. Denying `mcp:github` denies every
`mcp:github/*` identity by construction — a denied server denies the request's whole MCP entry
before any of its individual tools are considered.

**A client that hosts its own MCP servers** sends no `{type:'mcp'}` entry. Measured on the payload
log and with a throwaway MCP server (2026-09-18): Claude Code declares each of those tools as an
ordinary tool named `mcp__server__tool` (40 distinct among 57 declared); codex declares none of them
and reaches them inside its own `exec` tool as `tools.mcp__server__tool`; opencode declares them as
`<server>_<tool>` (`probe_ping_probe`) with nothing marking them as MCP, so its entry needs the
server names; pi has no MCP support at all. `mcpNaming.ts` normalises the name
into the `mcp:server/tool` identity, so one pattern (`mcp:abap2ui5/*`) covers a locally hosted
server and a remotely declared one - and because Claude Code's are IN the request, strip mode
removes them before the model can call them. The middleware keeps the original spelling so the
adapter, which only sees the body, can still find the tool it must remove. The conventions live in
`platform.toolGovernance.mcpNaming` (presets for claude-code, codex, pi and opencode), so a new
client is a configuration change; `mcpNamingConfig.ts` reads them and falls back to the presets.

**The call gate** (`callGate.ts`) is what governs a tool no request declares. A container call's
nested MCP tools are read from the call the model sends back - identifiers only, never the arguments
- and recorded with the `detected` verdict when the policy denies them: used, and not prevented.
When a policy block applies, the call itself is refused: the non-streaming body has the call
replaced by a refusal message, and on the streaming path a container call's frames are HELD until
its arguments complete, then either flushed untouched or dropped in favour of refusal frames, with
`response.completed` rewritten so the client's own state stays consistent. The granularity is the
whole call, because a denied identifier sits in a program that may also do legitimate work, and a
call whose arguments never complete is forwarded rather than swallowed. `captured` keeps the
original bytes, so usage and the recorded tools still describe what the model actually did.

Whether "a policy block applies" is entirely a function of mode: `gateContext(req)` (`record.ts`)
hands the gate `blocks: []` whenever the request's evaluated mode is `monitor`, whatever the policy
or the trust chain would otherwise deny - so under Monitor the gate never refuses a container call,
whatever it reaches; only Strip and Reject stop it. `recordNestedTools` is unconditional, though: it
judges every nested identity against `effectiveBlocks(s)` regardless of what the gate was given, so a
call that Monitor let straight through still comes back `detected` rather than `unlisted`. This is
also why fix commit `cd24b285` was a bug fix and not a behaviour change: the gate used to refuse under
Monitor too, which meant a monitoring policy could still alter what the client received - Monitor's
whole contract is "record only, never change what the client sees".

A Responses tool that is typed AND named — `{type:'custom',name:'exec'}`,
`{type:'namespace',name:'collaboration'}` — yields both `hosted:<type>` and
`hosted:<type>/<name>`, the same shape as an MCP server beside its tools, so a policy can block one
custom tool or every one of them. Recording only the type had hidden which tool it was: codex's
whole shell surfaced as `hosted:custom`.

**Invoked identities are reconciled against the declaration** (`resolveInvoked`). The gateway
rewrites a Responses request's hosted and custom tools into plain function tools before calling SAP
AI Core, so the model's invocations always return as function calls: a custom tool declared as
`exec` is invoked as `function:exec`, a hosted `web_search` as `function:web_search`. Taken
literally, each was a tool nobody had declared — a second inventory row marked `unlisted`, with no
policy decision attached, while the declared row showed no invocations at all. An invoked
`function:<name>` that was not declared is therefore recorded under the one declared identity with
that name; an exact declaration wins, ambiguity is left alone, and `mcp:`/`hosted:` invocations
(which carry their own namespace) are never reconciled.

## Trust chain (2026-09-22 §3)

**`resultSources(body): ResultSource[]`** is this phase's addition to `ToolAdapter`
(`adapters/types.ts`): the tools whose OUTPUT is already in the request, one entry per result, found
by pairing each result
block with the call that produced it (a `Map<callId, ResultSource>` built while walking the body, so
a result is only ever paired with a call the adapter has already seen):

| Family | Result | Paired with |
|---|---|---|
| OpenAI chat (`openaiChat.ts`) | `role:"tool"` message, `tool_call_id`; a legacy `role:"function"` message names its own tool | assistant `tool_calls[].function.name` |
| Responses (`responses.ts`) | `function_call_output` / `custom_tool_call_output`, `call_id`; `mcp_call` items that carry `output` and any other `<type>_call` item count directly, mapped through `HOSTED_CALL_TYPES` (`computer_call` → `hosted:computer_use_preview`) the same table `outputItemIdentity` uses for invocations | the matching `function_call` / `custom_tool_call` input item |
| Anthropic (`anthropic.ts`) | `tool_result` / `mcp_tool_result` block, `tool_use_id`; any other `*_tool_result` block (`web_search_tool_result`) counts directly as its hosted tool with the suffix stripped | the `tool_use` / `mcp_tool_use` block's `name` (and `server_name` for the MCP case) |
| Gemini (`gemini.ts`) | `functionResponse` part | its own `name` (Gemini declares no hosted or MCP tool shape, so this is the adapter's whole `resultSources`) |

A result whose call was never in the request (a client-truncated history) falls back to
`UNKNOWN_SOURCE` (`function:<unknown>`), which only a catch-all `function:*` untrusted pattern
matches. `resultSources` returns raw identities in the family's own spelling; the middleware applies
the caller's MCP naming convention to each one exactly as it does for declarations, and - because a
container tool's result carries whatever its program reached, not just the container call itself -
expands a container result through `nestedCallsIn` the same way a container INVOCATION is expanded
for the call gate: `isContainerTool(toolName(identity), convention) ? [normalised, ...nestedCallsIn(args, convention)] : [normalised]`
in `middleware.ts`. `sources` (plural, with duplicates kept) rides `req.toolGovernance.sources` for
the rest of the request's lifetime.

**The trust step in `evaluate()`** runs after the existing allow/deny/narrow logic, as one more pass
over the already-`unique`d declared identities. `labels(blocks, 'sensitive' | 'untrusted')` unions
both policy blocks' lists (the same union rule `deny` already uses - broader wins). `taintedBy` is
the sorted, deduplicated subset of `sources` matching any untrusted pattern; when it is non-empty,
every declared identity that matches a sensitive pattern and is not already denied is pushed onto
`denied` with `reasons.set(id, 'trust_chain')` - under the SAME merged mode as everything else, never
a mode of its own. `EvaluationResult` gained `reasons: Map<identity, DecisionReason>` (`'policy' |
'trust_chain'`) and `taintedBy: ToolIdentity[]`. The reject and forced-tool-choice wording both read
`reasons`/`taintedBy` to build the trust-chain sentence (`evaluate.ts`: `tools not permitted while the
conversation contains content from <sources>: <tools>`; a mixed rejection joins the policy and
trust-chain clauses with `; `). A `tool_choice` naming a tool the trust chain just denied turns strip
mode into a rejection exactly the way a policy-denied forced tool already did, with its own wording
(`tool_choice names <id>, which is withheld while the conversation contains content from <sources>`).

**`effectiveBlocks(s)`** (`record.ts`) is what lets the call gate and nested recording enforce the
trust chain without knowing it exists: when the request's own evaluation left `taintedBy` non-empty,
it appends ONE synthetic block (`policyName: 'trust chain'`, `deny: <the sensitive patterns>`, no
allow) to the real policy blocks, under the request's mode. `deniedBy` then denies a sensitive
identity for exactly the reason `evaluate()` already computed. See "The call gate" above for how
`gateContext` only ever hands this to the gate under Strip/Reject, never Monitor.

**`emitToolPolicyEvent`** (`middleware.ts`) computes the event's `reason` from the identities it is
about to report: `'policy'` if every one of them was denied for that reason, `'trust_chain'` if every
one was, `'mixed'` otherwise (`kinds.size > 1`), read off `result.reasons`. `sources: result.taintedBy`
rides along whenever it is non-empty. `securityEventEmitter.emitToolNotEntitled` (`services/`) builds
the event `description` from `reason`: the trust-chain sentence names the sources
("...because the conversation contains content from `<sources>` (tool policy "<name>")"), the mixed
sentence keeps the policy clause and appends the trust-chain one, and metadata carries `reason` and
`sources` verbatim for `recordRejectedTools` to read back on a reject. The wording lives in ONE place
(`emitToolNotEntitled`), so both `securityEventService`'s notification-title maps and
`notificationPopulationService` pick it up through the event's own `description` rather than each
carrying their own copy - notification TITLES are unchanged; the trust-chain wording only ever
reaches the notification BODY, through this description.

**`ToolUsageEntry.reason`** (`types/usage.ts`) and the **`source` facet** are how the trust chain
rides the ordinary usage event instead of a side channel. `toolsForEvent` (`record.ts`) attaches
`reason: s.result.reasons.get(identity)` to a declared or invoked entry whenever the decision is
neither `allowed` nor `unlisted` and a reason was recorded (so an ordinary policy denial keeps
carrying `'policy'` exactly as before - the trust chain only ever adds a second value, never changes
the shape). Every identity in `s.sources` becomes its own entry with `facet: 'source'` and
`decision: 'allowed'` - a source is never itself blocked, denied or narrowed, it only ever taints; its
row exists so the inventory can be filtered to "which of the caller's tools produced output that was
carried forward", and only its request count (how many results named it) is meaningful, not an
allowed/monitored/stripped/rejected split. `toolUsageService.recordToolUsage` persists `reason` on
`ToolUsage` (`'policy' | 'trust_chain'` or `null`) and rolls a `trust_chain` reason's `count` into
`ToolUsageDaily.trustChained`, a subset of whichever decision counter (`monitored` / `stripped` /
`rejected`) the row already bumped - so `trustChained` is read alongside that counter, never in place
of it.

## Middleware mount points

`toolGovernance(adapter)` is mounted after authentication and before `quotaEnforcement` and the
controller, on all four REST families: `services/gateway/src/routes/anthropicRoutes.ts` (messages,
complete, messages-beta), `chatRoutes.ts` (`/openai/api/v1/chat/completions` and
`/openai/v1/chat/completions`), `responsesRoutes.ts` (`/openai/api/v1/responses` and
`/openai/v1/responses` — there is no bare `/responses` mount), `googleRoutes.ts` (`generateContent`
and `streamGenerateContent`), and on the OpenRouter router (`openRouterRoutes.ts`, mounted at
`/openrouter/api/v1`) per path: `/chat/completions` and `/completions` with the OpenAI chat adapter,
`/responses` with the Responses adapter. That router applies its auth chain once through a
`router.use`, so the three mounts sit between `openRouterServiceAuth` and a `router.use`d
`quotaEnforcement` — the same order the per-route families use. All of it is pinned by
`test/tool-governance-wiring.test.ts`.

On `reject` the middleware sends the family's own 403 body directly and never calls `next()`; on
`strip` it replaces `req.body` with the adapter's stripped copy and calls `next()`. The try/catch
around evaluation is deliberately narrower than the 403 send itself, so a failure sending the 403 can
never fall through to the real handler and risk a second, conflicting response. Every strip or
reject also emits one `tool_not_entitled` security event
(`securityEventEmitter.emitToolNotEntitled`).

**AWS Bedrock** (spec 2026-09-22 §4) is governed by a fifth adapter, `bedrockAdapter`
(`adapters/bedrock.ts`), mounted in `awsBedrockRoutes.ts` the same way the four REST families are:
`router.use(conditionalUnifiedAuth, bedrockServiceAuth, toolGovernance(bedrockAdapter),
quotaEnforcement)` — governance sits between service authentication and quota enforcement, the same
position as everywhere else. Authentication runs before this middleware. The signature check on
this route covers the payload hash the client declares in `x-amz-content-sha256`
(`tokenBasedAwsAuth.ts`'s `createAwsSignatureData`, the module `createUnifiedTokenAuth` actually
mounts here); the gateway neither recomputes that hash from the body nor reads the raw body again
afterwards, so a strip that replaces `req.body` cannot break a later check.

The adapter detects the body's shape rather than trusting the subpath: `anthropic_version` present
means an Anthropic Messages body, and `declaredTools`/`forcedTool`/`stripTools`/`noteStrippedTools`/
`invokedTools`/`resultSources` all delegate straight to the Anthropic adapter's own pure functions;
`toolConfig`/`toolChoice` or a `messages[].content[]` tool block means Converse
(`toolConfig.tools[].toolSpec.name` → `function:<name>`, `toolChoice.tool.name` forced, a
`toolUseId`↔`toolUse.name` pairing for `resultSources`); anything else — a Nova or Llama invoke body —
declares no tools and passes through unchanged.

`stripRefusal(body, blocked)`, new on `ToolAdapter` and so far implemented only here, refuses the
request instead of stripping when doing so would leave a Converse conversation that already used a
tool (`usedTools`: any `toolUse`/`toolResult` block present) with an empty `toolConfig` — Bedrock
itself refuses a `converse` call shaped that way, so stripping to empty would only trade one refusal
for a worse one. `rejectionHeaders()`, also new, returns `{'x-amzn-ErrorType':
'AccessDeniedException'}`; the middleware sets it on the 403 alongside `rejectionBody`, so a refusal
reads as Bedrock's own `AccessDeniedException` (403, that header, `{message}` body) and the AWS SDKs
raise their normal exception instead of an unrecognised shape.

The controller (`awsBedrockController.ts`) records invoked tools on both paths:
`recordInvokedTools(req, bedrockAdapter.invokedTools(result))` for a complete response, and
`tapStreamedTools(req, res, bedrockAdapter)` (`toolGovernance/streamTap.ts`) for a streamed one. This
controller writes its own stream straight to `res` rather than going through the SSE accumulation the
four REST families share, so `tapStreamedTools` wraps `res.write` itself: every chunk is scanned for
tool-start frames before being forwarded, unaltered and undelayed, and the text after the chunk's
last newline (up to 64 KiB) is held over and prefixed onto the next chunk before scanning — so a
tool-start frame split across two network writes (the direct-passthrough branch forwards raw upstream
chunks with no regard for SSE frame boundaries) is still recorded once the rest of it arrives.

The OpenAI Realtime WebSocket route (`services/gateway/src/realtime/realtimeUpgrade.ts`) never mounts
the middleware — a WebSocket upgrade never reaches Express — so session state plays the middleware's
role instead (spec 2026-09-22 §5).

`relay.ts`'s `onClientFrame` hook (`RelayHooks`) runs BEFORE a client frame is forwarded upstream and
returns a `ClientFrameVerdict`: `void` forwards the frame unchanged, `{forward, thenUpstream?}` sends
a replacement and, right after it, a second gateway-originated frame upstream, and `{drop, reply?}`
swallows the frame and optionally answers the client directly instead — a throw out of the hook is
treated as `void` and forwards the original, the relay's own fail-open rule. `onUpstreamFrame` is
unchanged: it still runs AFTER an upstream frame is forwarded, purely to observe.

`createRealtimeToolGate(user, key)` (`realtime/realtimeToolGate.ts`) is the pure decision function
behind that hook. `onClientFrame` judges a `session.update`/`response.create` carrying `tools` (and
any `tool_choice`) with the same `evaluate()` the REST middleware calls: **reject** drops the frame
and returns a Realtime `error` event (`type: 'invalid_request_error'`, `code: 'tool_not_entitled'`,
the client's own `event_id`), leaving the session's tool list exactly as it was — the client learns
its declaration was refused but keeps working with whatever tools it already had; **strip** forwards
the frame with the denied tools removed and the notice appended to `instructions` — only ever
instructions the client itself sent, in this frame or remembered from an earlier `session.update`,
since `instructions` is replaced wholesale by the frame and a session the gateway never saw
instructions for gets no notice rather than lost ones. A `session.update`'s outcome becomes the
session's new baseline (`tools` as forwarded, and `instructions`) for every later judgement, including
the trust chain below; a bare `response.create` is judged the same way but never becomes the baseline.

Sources accumulate in the gate's own state across the session's lifetime, since a Realtime session
receives its history incrementally rather than replaying it on every turn: `onResponseDone` reads
each `response.done`'s `function_call` items into a `callId → name` map, and every
`conversation.item.create` frame carrying a `function_call_output` looks its call up there and pushes
the resolved identity (or `UNKNOWN_SOURCE`) onto the session's sources. When that taints an untrusted
source and the session's current tools still hold a sensitive one, `onClientFrame` re-evaluates the
session's own tools against the grown sources: **monitor** records only; **reject** drops the result
frame and answers the same `tool_not_entitled` error; **strip** forwards the result frame untouched
and then sends upstream a SEPARATE, gateway-originated `session.update` (`thenUpstream`) carrying the
session's current tools minus the sensitive ones and the notice in `instructions` — a corrective
update the client never asked for, needed because the result frame itself carries no tool list to
strip from. That `session.update` becomes the new baseline in turn, so a second untrusted result only
has to strip whatever is left.

`realtimeUpgrade.ts`'s `startSession` wires the gate in: `createRealtimeToolGate` is built once from
`policyBlocksFromRequest(ureq)` at session start; the relay's `onClientFrame` hook calls
`gate.onClientFrame`, publishes the gate's state onto `ureq.toolGovernance` (so `toolsForEvent` still
folds it into whichever response's usage event follows), and — whenever the outcome carries `refused`
— calls `emitToolPolicyEvent(ureq, outcome.refused.result, outcome.refused.identities,
outcome.refused.mode)` directly, the same function the REST middleware calls, since there is no
Express `res` here to reach it any other way. `onUpstreamFrame`'s existing `response.done` handling
still feeds `gate.onResponseDone`, republishes state, and folds `invokedToolsFromResponseDone` into
that response's usage event, unchanged from before this phase.

## Usage event

`UsageMetrics`/`UsageEvent` (`services/gateway/src/types/usage.ts`) carry an optional
`tools?: ToolUsageEntry[]`, each `{ identity, facet: 'declared'|'invoked'|'source', count, decision,
reason? }`. `toolsForEvent(req)` (`record.ts`) builds it from `req.toolGovernance`: one entry per
unique declared identity with its evaluated decision, then one entry per invoked identity a
controller actually recorded (`decideInvoked` — declared and allowed stays `allowed`, declared and
denied follows the request's mode decision, never declared comes back `unlisted`), then one `source`
entry per identity in `s.sources` (see "Trust chain" above for `reason` and the `source` facet).
`emitUsageEvent` (`services/gateway/src/utils/usageTracker.ts`) calls it while building the event;
nothing here is awaited on the request path. The admin's `usageEventProcessor.ts` hands any event
carrying `tools` to `recordToolUsage` inside the same transaction as the ordinary usage row (both
the immediate and the batched processing path).

## Admin tables and retention

`services/admin/src/db/schema/tool-governance.cds`: `ToolPolicies` (`cuid, managed`; `name`,
`description`, `isDefault`, `mode`), `ToolPolicyAllows`/`ToolPolicyDenies` (a `policy` association,
`pattern`, `note`, unique on `(policy, pattern)`), `ToolUsage` (one row per tool per request:
`identity`, `facet`, `decision`, `count`, plus the request's `email`, `credentialId`, `authType`,
`provider`, `model`, `endpoint`, `validFrom`), `ToolUsageDaily` (keyed on `email, day, identity,
facet`, the six decision counters plus `requests` and `lastSeen`). `Users.toolPolicy` and
`ApiKeys.toolPolicy` are nullable associations added to the existing entities: null means "the
default policy" for a user, "no narrowing" for a key.

**Trust chain additions (2026-09-22 §3, §6):** `ToolPolicySensitive`/`ToolPolicyUntrusted` are two
more `policy`-associated pattern tables, same shape as `ToolPolicyAllows`/`ToolPolicyDenies`
(`pattern`, `note`, unique on `(policy, pattern)`), composed onto `ToolPolicies` as `sensitive` and
`untrusted`. `ToolUsage.reason: String(12)` (`'policy' | 'trust_chain'`, nullable - null on every row
from before this phase and on an ordinary allow) carries why a denied identity was denied through to
the raw row, and `ToolUsageDaily.trustChained: Integer default 0` is the same information rolled up
per day, identity and facet; `facet` on both tables gained a third value, `source` (a tool whose
output was in the request, never itself allowed/denied - see "Trust chain" above). All four are
additive: an older admin's `ToolPolicyBlock` simply has no `sensitive`/`untrusted` arrays, which
`middleware.ts`'s `withLabels` reads as empty lists.

`toolPolicyService.ts`: `ensureDefaultPolicy` seeds "Default" (monitor, no entries) once, on first
use; `policyBlockFor(email)` resolves the user's own policy or falls back to it;
`keyPolicyBlockFor(keyId)` resolves a key's own policy or returns null; `validatePolicyWrite`
enforces the pattern syntax, a fixed `isDefault`, and a non-empty `name`; `affectedEmails` /
`releaseAssignments` drive cache invalidation and reassignment to the default on delete.
`admin-service-tool-policies.ts` maps this to OData: draft `CREATE`/`UPDATE` on `ToolPolicies`
redirect to the base table and replace the `allows`/`denies` children wholesale
(`replaceEntries`) — the same view-write workaround `ApiKeys`/`AwsCredentials`/`QuotaProfiles`
already use, because `@cap-js/sqlite` refuses a plain write against a projection that compiles to a
view. `ToolInventory` (`@cds.persistence.skip`) is served entirely by an on-READ handler that
aggregates `ToolUsageDaily` over the range of its `day` filter (default: the last 30 days), with
`$filter`/`$orderby`/`$top`/`$skip` applied in memory afterwards since the result set (distinct
tool identities) is small. `ToolPolicyModes`, `ToolFacets` and `ToolAgents` (also `@cds.persistence.skip`) are the
value-help entities behind the `mode` field, the inventory's facet filter and its Requested By
filter. `services/toolInventoryQuery.ts` parses the page's filters out of the CQN where clause
(`day` as a range, `identity`, `facet` and `agent` with eq/contains/startswith/endswith, plus
`$search` over the tool and the client programs) and matches them against the folded rows; a
filter it cannot honour makes the READ answer 400. Before it existed only exact matches on
`identity` and `facet` were applied and everything else was dropped in silence, so a filtered
table answered with every row. The two value helps reuse the same parser but ignore what they
cannot apply: an extra suggestion is harmless, a 400 would break the dropdown being typed into. `day` carries
`Capabilities.FilterRestrictions.AllowedExpressions: 'SingleRange'`, which is what makes Fiori
Elements render a date range picker with the semantic operators instead of the generic conditions
dialog; the handler reads the range's ends and refuses any other operator.

Every validation response (`validateApiKey`, `validateAwsCredentials`, and the batch/token
variants) carries `toolPolicy` (the user's block) and, for an API key, `keyToolPolicy` — the same
cached-and-invalidated transport the model entitlement block already rides, so a policy edit,
assignment or unassignment invalidates exactly the affected credentials
(`invalidateForEmails(..., 'tool-policy')`), the way a catalog change does. `myQuotaStatus` adds
`toolPolicy: { name, mode }` (`QuotaStatus.toolPolicy` in `admin-service.cds`) for the shell
popover.

The caller's client program is recorded too: the gateway sends the request's `User-Agent` on the
usage event, `ToolUsage` keeps it verbatim, and `ToolUsageAgentDaily` (`email, day, identity, facet,
agent`) counts it per normalised agent - the header's first token, lower-cased, so
`claude-cli/2.0.1 (external)` becomes `claude-cli` and a missing header becomes `unknown`. It is a
SEPARATE table rather than an `agent` key on `ToolUsageDaily` because adding a column to an existing
primary key is not an additive change: PostgreSQL's schema evolution refuses it and the admin
container would refuse to start, while a new table is picked up by both deploy paths (and by the
SQLite self-heal below). The inventory reads it for its "Requested By" column, and the daily
retention purges it with the other aggregates.

A REJECTED request emits no usage event - it never reached a model - so its refused identities ride
the `tool_not_entitled` security event instead (`metadata.tools`, reject mode only) and
`securityEventSubscriber.recordRefusedTools` -> `toolUsageService.recordRejectedTools` records them
with decision `rejected`, resolving the owner from the credential. Nothing is written to usage or
billing. A strip needs no such path: that request continues and its own usage event records the
stripped tools. Because the daily row is keyed by identity, facet and day, a second rejection of a
known tool raises its counter instead of creating another entry, while a tool nobody has used yet
appears for the first time - which is the point: without this, a preemptive deny would be invisible
in the inventory. Recording is best effort and never blocks the stream ack.

`ToolIdentities` (`@cds.persistence.skip`, admin READ) lists every recorded identity with its user
and request counts: it is the value help behind a policy's allow and deny `pattern` fields, declared
as a non-fixed `Common.ValueList` so an admin can still type a wildcard such as `function:jira_*`.

In `ToolUsageDaily`, `requests` counts EVENTS (one per usage event that carried the identity in
that facet), while the six decision columns count tool OCCURRENCES (a `count` per entry, and a
model can invoke the same tool several times in one request) — so `allowed` can legitimately exceed
`requests`, and the two columns must never be compared as if they were the same unit.

`recordToolUsage`'s daily upsert is a SELECT followed by an UPDATE or INSERT, which assumes a
single writer — true today: SQLite, one admin process. On PostgreSQL with several admin replicas
two processes can pass the SELECT for the same `(email, day, identity, facet)` key and the loser's
INSERT hits the primary key. Move it to an `ON CONFLICT ... DO UPDATE` upsert before scaling the
admin out.

Retention (`toolUsageService.ts`): `retentionSettings` reads
`platform.toolGovernance.retention.{rawDays, dailyDays}` from the active `ApiConfigurations` row,
falling back to `api_config.json` and then to the defaults (30 / 400 days), cached 60 s — the same
pattern `quotaLimits.ts` uses for `platform.quotas`. `applyRetention` deletes `ToolUsage` rows
older than `rawDays` and `ToolUsageDaily` rows older than `dailyDays`; it runs from
`costRecalculationService.ts`'s existing daily maintenance pass, never per request.

Indexes (`src/db/data/tool-usage-indexes.ts`): CAP's schema evolution creates and alters tables,
columns, views and constraints, but it generates no secondary indexes on SQLite or PostgreSQL, and
`@sql.append` can only extend the `CREATE TABLE` statement itself (an annotation such as
`@cds.persistence.index` is not a CAP annotation and produces no DDL). The admin therefore runs
`CREATE INDEX IF NOT EXISTS` at every boot, beside the other idempotent startup steps (the
`neverExpires` backfill), for `ToolUsage (validFrom)` — the retention DELETE —, `ToolUsage (email,
identity)` and `ToolUsageDaily (day)` — the inventory range and the daily retention, which the
`email`-first primary key cannot serve. The statements use unquoted identifiers, so they run
unchanged on SQLite and on PostgreSQL (which folds them to the lower-case tables CAP created). A
fresh install, a restart and an upgrade all end with the indexes in place and no manual step; a
rejected statement is logged as a warning and retried on the next boot.

The inventory's `lastSeen` is an untyped `max()` aggregate: PostgreSQL returns it without a zone
(`2026-09-17T16:08:48`), which a browser would read as local time, so the handler normalises it to
UTC ISO (`asUtcIso`) — CAP stores timestamps in UTC.

## SQLite: self-heal at boot, and the by-hand migration behind it

The admin heals a FILE-backed SQLite database at boot (`src/db/data/sqlite-schema-heal.ts`, called
first in `admin-service.ts`'s `init`, before anything reads the database). It compares the model's
compiled SQLite DDL with the live schema and applies additive statements only: create a missing
table, add a missing column, recreate a view whose column list no longer matches the model. It never
drops a table or a column, so it cannot lose data; a `NOT NULL` column without a default (which
SQLite cannot add to an existing table) is reported and left for the DDL below. Views are compared by
COLUMN LIST, not by text: `@cap-js/sqlite` rewrites expressions such as `CURRENT_TIMESTAMP` when it
stores a view, so a text comparison would recreate those views on every boot.

This closes the gap that used to break a local dev machine after a CI run: `pnpm run ci` restores
`db/admin.db` from its pre-run backup, the dev admin never runs `cds deploy`, and the first read of a
changed entity then failed with `no such column: $U.toolPolicy_ID` — which took down `whoami` (the
shell fell back to the user persona), `myQuotaStatus` (the My quota tile disappeared) and the Fiori
apps at once. Verified: booting on a pre-feature database creates the 8 missing tables, 4 columns and
the stale views, keeps every row, and the next boots do nothing; booting on an empty file creates the
whole schema (52 tables, 53 views) — CSV seed data still comes from `pnpm run db:migrate`; booting on
PostgreSQL skips the step entirely and leaves the schema untouched. In-memory test databases are
skipped too (`cds.test` deploys them fresh).

`ensureToolUsageIndexes` runs right after the heal, so a database that just gained the tool tables
gets their indexes in the same boot.

**The trust chain's schema additions need no new by-hand step.** `ToolPolicySensitive`,
`ToolPolicyUntrusted` and their two draft tables are ordinary `CREATE TABLE` statements in the
compiled DDL, and `ToolUsage.reason`/`ToolUsageDaily.trustChained` are ordinary nullable-or-defaulted
columns on tables that already exist - none of it hits the one case the heal cannot do additively
(`NOT NULL` without a default). Verified directly against `planSqliteHeal`/`healSqliteSchema`: applied
to a database built from the schema as it stood one commit before this phase, the heal created all
four new tables (base pair plus drafts) and added both columns in the same pass, with the new table
immediately writable. The DDL below is therefore unchanged by this phase; it still exists for the one
case the heal cannot cover and for migrating with the admin stopped.

The DDL below stays documented for the cases the heal deliberately does not cover (a `NOT NULL`
column without a default, or a database you would rather migrate with the admin stopped). The
running dev admin (`cds serve`) does not deploy schema changes, so an existing `db/admin.db` can also
be prepared by hand — with the admin stopped, after `PRAGMA wal_checkpoint(TRUNCATE)`, and a
copy of the file made first (dry-run against the copy — this exact statement list was verified by
deploying the schema as it stood one commit before this feature, applying it, and diffing the
result against a fresh deploy of the current schema: identical). The DDL below — the five new base
tables, the three draft tables `ToolPolicies`' `@odata.draft.enabled` projection needs (SQLite
never creates draft tables lazily; skipping these breaks Create in the Tool Policies app), the four
new columns, and the eight affected or new views — is taken from `npx cds compile src/db src/srv
--to sql --dialect sqlite` (run from `services/admin`) and applied with `sqlite3`. `ApiKeys` gaining
a column also invalidates `ActiveApiKeys` (`db/schema/api-keys.cds`'s own filtered view over it,
both the plain database view and its `AdminService` projection): every view SQLite compiles is a
frozen, explicit column list, never `select *`, so a view left alone after its base table changes
silently keeps returning the base table's old shape:

```sql
ALTER TABLE sap_llm_gateway_admin_Users ADD COLUMN toolPolicy_ID NVARCHAR(36);
ALTER TABLE AdminService_Users_drafts ADD COLUMN toolPolicy_ID NVARCHAR(36) NULL;
ALTER TABLE sap_llm_gateway_admin_ApiKeys ADD COLUMN toolPolicy_ID NVARCHAR(36);
ALTER TABLE AdminService_ApiKeys_drafts ADD COLUMN toolPolicy_ID NVARCHAR(36) NULL;

CREATE TABLE sap_llm_gateway_admin_ToolPolicies (
  ID NVARCHAR(36) NOT NULL,
  createdAt TIMESTAMP_TEXT,
  createdBy NVARCHAR(255),
  modifiedAt TIMESTAMP_TEXT,
  modifiedBy NVARCHAR(255),
  name NVARCHAR(100) NOT NULL,
  description NVARCHAR(500),
  isDefault BOOLEAN DEFAULT FALSE,
  mode NVARCHAR(10) NOT NULL DEFAULT 'monitor',
  PRIMARY KEY(ID)
);

CREATE TABLE sap_llm_gateway_admin_ToolPolicyAllows (
  ID NVARCHAR(36) NOT NULL,
  policy_ID NVARCHAR(36) NOT NULL,
  pattern NVARCHAR(200) NOT NULL,
  note NVARCHAR(200),
  PRIMARY KEY(ID),
  CONSTRAINT sap_llm_gateway_admin_ToolPolicyAllows_pattern UNIQUE (policy_ID, pattern)
);

CREATE TABLE sap_llm_gateway_admin_ToolPolicyDenies (
  ID NVARCHAR(36) NOT NULL,
  policy_ID NVARCHAR(36) NOT NULL,
  pattern NVARCHAR(200) NOT NULL,
  note NVARCHAR(200),
  PRIMARY KEY(ID),
  CONSTRAINT sap_llm_gateway_admin_ToolPolicyDenies_pattern UNIQUE (policy_ID, pattern)
);

CREATE TABLE AdminService_ToolPolicies_drafts (
  ID NVARCHAR(36) NOT NULL,
  createdAt TIMESTAMP_TEXT NULL,
  createdBy NVARCHAR(255) NULL,
  modifiedAt TIMESTAMP_TEXT NULL,
  modifiedBy NVARCHAR(255) NULL,
  name NVARCHAR(100) NULL,
  description NVARCHAR(500) NULL,
  isDefault BOOLEAN NULL DEFAULT FALSE,
  mode NVARCHAR(10) NULL DEFAULT 'monitor',
  IsActiveEntity BOOLEAN,
  HasActiveEntity BOOLEAN,
  HasDraftEntity BOOLEAN,
  DraftAdministrativeData_DraftUUID NVARCHAR(36) NOT NULL,
  PRIMARY KEY(ID)
);

CREATE TABLE AdminService_ToolPolicyAllows_drafts (
  ID NVARCHAR(36) NOT NULL,
  policy_ID NVARCHAR(36) NULL,
  pattern NVARCHAR(200) NULL,
  note NVARCHAR(200) NULL,
  IsActiveEntity BOOLEAN,
  HasActiveEntity BOOLEAN,
  HasDraftEntity BOOLEAN,
  DraftAdministrativeData_DraftUUID NVARCHAR(36) NOT NULL,
  PRIMARY KEY(ID)
);

CREATE TABLE AdminService_ToolPolicyDenies_drafts (
  ID NVARCHAR(36) NOT NULL,
  policy_ID NVARCHAR(36) NULL,
  pattern NVARCHAR(200) NULL,
  note NVARCHAR(200) NULL,
  IsActiveEntity BOOLEAN,
  HasActiveEntity BOOLEAN,
  HasDraftEntity BOOLEAN,
  DraftAdministrativeData_DraftUUID NVARCHAR(36) NOT NULL,
  PRIMARY KEY(ID)
);

CREATE TABLE sap_llm_gateway_admin_ToolUsage (
  ID NVARCHAR(36) NOT NULL,
  requestId NVARCHAR(100),
  email NVARCHAR(255),
  credentialId NVARCHAR(36),
  authType NVARCHAR(20),
  provider NVARCHAR(50),
  model NVARCHAR(200),
  endpoint NVARCHAR(200),
  identity NVARCHAR(220),
  facet NVARCHAR(10),
  count INTEGER DEFAULT 1,
  decision NVARCHAR(10),
  policy_ID NVARCHAR(36),
  validFrom TIMESTAMP_TEXT,
  PRIMARY KEY(ID)
);

CREATE TABLE sap_llm_gateway_admin_ToolUsageDaily (
  email NVARCHAR(255) NOT NULL,
  day DATE_TEXT NOT NULL,
  identity NVARCHAR(220) NOT NULL,
  facet NVARCHAR(10) NOT NULL,
  requests INTEGER DEFAULT 0,
  allowed INTEGER DEFAULT 0,
  monitored INTEGER DEFAULT 0,
  stripped INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0,
  unlisted INTEGER DEFAULT 0,
  lastSeen TIMESTAMP_TEXT,
  PRIMARY KEY(email, day, identity, facet)
);

DROP VIEW IF EXISTS AdminService_Users;
CREATE VIEW AdminService_Users AS SELECT
  Users_0.createdAt,
  Users_0.createdBy,
  Users_0.modifiedAt,
  Users_0.modifiedBy,
  Users_0.email,
  Users_0.displayName,
  Users_0.rolesSnapshot,
  Users_0.firstSeenAt,
  Users_0.lastSeenAt,
  Users_0.status,
  Users_0.statusChangedAt,
  Users_0.statusChangedBy,
  Users_0.statusReason,
  Users_0.requestsPerMinute,
  Users_0.spendPerDay,
  Users_0.spendPerWeek,
  Users_0.spendPerMonth,
  Users_0.tokensPerDay,
  Users_0.tokensPerWeek,
  Users_0.tokensPerMonth,
  Users_0.quotaResetAt,
  Users_0.entitlementCatalog_ID,
  Users_0.quotaProfile_ID,
  Users_0.toolPolicy_ID
FROM sap_llm_gateway_admin_Users AS Users_0;

DROP VIEW IF EXISTS AdminService_ApiKeys;
CREATE VIEW AdminService_ApiKeys AS SELECT
  ApiKeys_0.ID,
  ApiKeys_0."key",
  ApiKeys_0.maskedKey,
  ApiKeys_0.name,
  ApiKeys_0.email,
  ApiKeys_0.isActive,
  ApiKeys_0.lastUsed,
  ApiKeys_0.usageCount,
  ApiKeys_0.deletedAt,
  ApiKeys_0.expiresAt,
  ApiKeys_0.neverExpires,
  ApiKeys_0.toolPolicy_ID,
  ApiKeys_0.lockedByUserDeactivation,
  ApiKeys_0.createdAt,
  ApiKeys_0.createdBy,
  ApiKeys_0.modifiedAt,
  ApiKeys_0.modifiedBy
FROM sap_llm_gateway_admin_ApiKeys AS ApiKeys_0;

DROP VIEW IF EXISTS sap_llm_gateway_admin_ActiveApiKeys;
CREATE VIEW sap_llm_gateway_admin_ActiveApiKeys AS SELECT
  ApiKeys_0.ID,
  ApiKeys_0.createdAt,
  ApiKeys_0.createdBy,
  ApiKeys_0.modifiedAt,
  ApiKeys_0.modifiedBy,
  ApiKeys_0."key",
  ApiKeys_0.maskedKey,
  ApiKeys_0.name,
  ApiKeys_0.email,
  ApiKeys_0.isActive,
  ApiKeys_0.lastUsed,
  ApiKeys_0.usageCount,
  ApiKeys_0.deletedAt,
  ApiKeys_0.expiresAt,
  ApiKeys_0.neverExpires,
  ApiKeys_0.lockedByUserDeactivation,
  ApiKeys_0.rateLimits_ID,
  ApiKeys_0.toolPolicy_ID
FROM sap_llm_gateway_admin_ApiKeys AS ApiKeys_0
WHERE ApiKeys_0.isActive = TRUE AND ApiKeys_0.deletedAt IS NULL AND (ApiKeys_0.neverExpires = TRUE OR ApiKeys_0.expiresAt > CURRENT_TIMESTAMP OR ApiKeys_0.expiresAt IS NULL);

DROP VIEW IF EXISTS AdminService_ActiveApiKeys;
CREATE VIEW AdminService_ActiveApiKeys AS SELECT
  ActiveApiKeys_0.ID,
  ActiveApiKeys_0.createdAt,
  ActiveApiKeys_0.createdBy,
  ActiveApiKeys_0.modifiedAt,
  ActiveApiKeys_0.modifiedBy,
  ActiveApiKeys_0."key",
  ActiveApiKeys_0.maskedKey,
  ActiveApiKeys_0.name,
  ActiveApiKeys_0.email,
  ActiveApiKeys_0.isActive,
  ActiveApiKeys_0.lastUsed,
  ActiveApiKeys_0.usageCount,
  ActiveApiKeys_0.deletedAt,
  ActiveApiKeys_0.expiresAt,
  ActiveApiKeys_0.neverExpires,
  ActiveApiKeys_0.lockedByUserDeactivation,
  ActiveApiKeys_0.rateLimits_ID,
  ActiveApiKeys_0.toolPolicy_ID
FROM sap_llm_gateway_admin_ActiveApiKeys AS ActiveApiKeys_0;

CREATE VIEW AdminService_ToolPolicies AS SELECT
  ToolPolicies_0.ID,
  ToolPolicies_0.createdAt,
  ToolPolicies_0.createdBy,
  ToolPolicies_0.modifiedAt,
  ToolPolicies_0.modifiedBy,
  ToolPolicies_0.name,
  ToolPolicies_0.description,
  ToolPolicies_0.isDefault,
  ToolPolicies_0.mode
FROM sap_llm_gateway_admin_ToolPolicies AS ToolPolicies_0;

CREATE VIEW AdminService_ToolPolicyAllows AS SELECT
  ToolPolicyAllows_0.ID,
  ToolPolicyAllows_0.policy_ID,
  ToolPolicyAllows_0.pattern,
  ToolPolicyAllows_0.note
FROM sap_llm_gateway_admin_ToolPolicyAllows AS ToolPolicyAllows_0;

CREATE VIEW AdminService_ToolPolicyDenies AS SELECT
  ToolPolicyDenies_0.ID,
  ToolPolicyDenies_0.policy_ID,
  ToolPolicyDenies_0.pattern,
  ToolPolicyDenies_0.note
FROM sap_llm_gateway_admin_ToolPolicyDenies AS ToolPolicyDenies_0;

CREATE VIEW AdminService_ToolUsageDaily AS SELECT
  ToolUsageDaily_0.email,
  ToolUsageDaily_0.day,
  ToolUsageDaily_0.identity,
  ToolUsageDaily_0.facet,
  ToolUsageDaily_0.requests,
  ToolUsageDaily_0.allowed,
  ToolUsageDaily_0.monitored,
  ToolUsageDaily_0.stripped,
  ToolUsageDaily_0.rejected,
  ToolUsageDaily_0.unlisted,
  ToolUsageDaily_0.lastSeen
FROM sap_llm_gateway_admin_ToolUsageDaily AS ToolUsageDaily_0;
```

`ToolUsage` is never projected on `AdminService` (no OData surface for the raw rows), so it gets no
view of its own; `ToolPolicyModes` and `ToolInventory` are `@cds.persistence.skip` and are served
entirely by on-READ handlers, so neither gets a table or a view. Postgres (Docker/Kyma) needs none
of this by hand: the admin container runs `cds-deploy --profile pg` with `schema_evolution: auto`
before it starts (and refuses to start if that fails), which adds the tables, draft tables, columns
and views above to an existing database, and the admin's boot step creates the indexes. Verified on
PostgreSQL 16 by deploying the schema as it stood one commit before this feature, adding a user and
an API key, deploying the current model over it, and booting the admin: the result matched a fresh
deploy, the existing rows kept a null `toolPolicy_ID` (the Default policy), the Default policy and
the three indexes were created at boot, and the retention DELETE and the inventory's day range use
the indexes. SQLite still needs the DDL above by hand because the dev admin never runs `cds deploy`;
the indexes are created at its next boot.
