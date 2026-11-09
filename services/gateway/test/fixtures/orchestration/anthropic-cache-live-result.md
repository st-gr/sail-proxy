# Live probe: prompt caching for /anthropic on the orchestration path

Captured 2026-10-23 with `test/anthropic-cache-live.test.ts` (`ANTHROPIC_CACHE_LIVE_PROBE=1`),
model `anthropic--claude-4.5-haiku` (`liveModels.claude`), straight to orchestration through
`sapAIService.completeChat`. Two identical calls per arm; each arm has its own run-unique prefix.

## Arm A — marked system prompt through the real builder

The payload is the output of `transformRequestToSAPFormat` with
`system: [{type:'text', text:<prefix>, cache_control:{type:'ephemeral'}}]`.

Call 1, HTTP 200:
```json
{"completion_tokens":4,"prompt_tokens":13,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":0,"cache_creation_tokens":7221,"cache_creation_token_details":{"ephemeral_5m_input_tokens":7221,"ephemeral_1h_input_tokens":0}}}
```
Call 2, HTTP 200:
```json
{"completion_tokens":4,"prompt_tokens":13,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":7221,"cache_creation_tokens":0,"cache_creation_token_details":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}
```
Usage is EXCLUSIVE (`prompt_tokens` stays 13), as recorded for Claude in `cacheBreakpoints.ts`.

## Arm B — `tool` message content as text blocks

Template: system, user, assistant with `tool_calls`, `tool` message, user. Only the `tool` message's
content changes between the sub-arms.

| sub-arm | `tool` content | call 1 | call 2 |
|---|---|---|---|
| B0 (control) | plain string, ~8.2k tokens | 200, no cache fields set (no breakpoint) | 200, same |
| B | `[{type:'text', text, cache_control:{type:'ephemeral'}}]` | **400** | **400** |
| B2 | `[{type:'text', text}]` (unmarked) | **400** | **400** |

B2 shows that the array content is the cause, not the breakpoint. (`completeChat` rethrows without
the response body, so only the status is recorded.)

## Arm C — `ttl: '1h'` on the system breakpoint

Arm A's payload with `cache_control: {type:'ephemeral', ttl:'1h'}`.

Call 1, HTTP 200:
```json
{"completion_tokens":4,"prompt_tokens":13,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":0,"cache_creation_tokens":7221,"cache_creation_token_details":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":7221}}}
```
Call 2, HTTP 200:
```json
{"completion_tokens":4,"prompt_tokens":13,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":7221,"cache_creation_tokens":0,"cache_creation_token_details":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}
```

## Arms D and E — assistant turns as marked text blocks

D: the real builder with an assistant turn `[{type:'text', text:<prefix>, cache_control}]`
between two user turns. E: arm B0's template with the assistant `tool_calls` message's content
replaced by `[{type:'text', text:<prefix>, cache_control}]`.

| arm | call 1 | call 2 |
|---|---|---|
| D | 200, `cache_creation_tokens` 7234 (5m) | 200, `cached_tokens` 7234 |
| E | 200, `cache_creation_tokens` 7777 (5m) | 200, `cached_tokens` 7777 |

## Verdicts

- `TOOL_MESSAGE_ARRAY: refused` — a `tool` message must keep plain string content; a breakpoint the
  client puts on a `tool_result` has to move to a message that can hold one.
- `ASSISTANT_BLOCKS: accepted+cached` — assistant turns, with or without `tool_calls`, take marked
  text blocks; they are valid targets for a moved breakpoint.
- `TTL_1H: honoured` — the write is booked as `ephemeral_1h_input_tokens`; `ttl` is passed through.
