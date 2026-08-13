# `custom_tools.mode: strip` — live verification

Run 2026-08-11 against the running gateway with codex CLI 0.147.0, model `gpt-5.5` (orchestration
route). The mode was set in the ADMIN config and published — the gateway reads its config from the
admin service, so editing `api_config.json` alone changes nothing at runtime.

This closes the gap the operator docs left: the cost of `strip` was asserted there but had never
been observed.

## Strip does what the adapter documents

Direct probe, one `custom` tool declared and nothing else:

| | tools |
|---|---|
| client → gateway | `{custom: 1}` |
| gateway → upstream | **no `tools` key at all** |

The declaration is removed, and because that emptied the array the key is deleted rather than sent
as `[]` — the rule `translateCustomTools` shares with `flattenNamespaceTools` and
`transformResponsesWebSearchTool`, confirmed on the wire. The turn completed normally.

## The fallback works, and costs three shell calls

Task: add a type hint and a one-line docstring to **both** functions in a 14-line file.

The edit succeeded and the file on disk is correct. Tool calls made across the session:

```
exec_command × 3     (apply_patch × 0)
```

Per-turn usage on the orchestration route:

| turn | prompt | completion |
|---|---|---|
| 1 | 9,822 | 114 |
| 2 | 10,055 | 629 |
| 3 | 10,406 | 143 |
| 4 | 10,694 | 206 |

Upstream saw 13 `function` tools and no `custom` type.

**A like-for-like token comparison against `translate` was NOT made.** The earlier `translate`
runs edited a different, smaller file, so quoting their numbers beside these would compare two
different tasks and overstate what is known. Running the identical task both ways needs a second
admin publish cycle; the qualitative finding — a multi-function edit that `apply_patch` does in one
structured call took three shell round-trips — stands on its own.

## The finding worth knowing before choosing `strip`

**Codex's system instructions still describe `apply_patch` after the tool is stripped.** The string
appears 3 times inside the prompt template reaching the upstream, while the tool itself is absent
from `tools`. The gateway removes a declaration; it does not and cannot edit the client's
instructions.

So in `strip` mode the model is told about a tool it does not have. In this run it never took the
bait — zero attempted `apply_patch` calls across four turns; it went straight to `exec_command`.
But the mismatch is real, and on a less capable model it is a plausible source of a wasted turn
spent calling a tool that will not resolve. That is a cost of `strip` that the operator
documentation did not previously mention.

## The deployed route behaves identically

Same task, same strip config, model `gpt-5.3-codex`. `ledger.py` was correctly edited.

| turn | upstream tools | `custom` present | `apply_patch` in tools |
|---|---|---|---|
| curl probe (custom only) | **no `tools` key** | no | no |
| 5 codex turns | **13 `function`** | no | no |

14 tools sent, one stripped, 13 forwarded. Four `exec_command` calls (orchestration took three for
the equivalent task), zero attempted `apply_patch`. The same instructions mismatch applies: codex's
prompt still describes `apply_patch` while the tool is absent.

**A trap for anyone reading these logs.** The deployed route's stage-02 capture nests the request
one level deeper than the orchestration route's:

```
orchestration:  payload.config.modules.prompt_templating.prompt.tools
deployed:       payload.payload.tools          ← not payload.tools
```

Reading `payload.tools` on a deployed capture returns nothing, which looks exactly like "the
gateway dropped every tool". It was only obvious that reading was wrong because the result was too
dramatic to believe; a subtler wrong path would have produced a plausible number and been believed.

## After the run

`custom_tools.mode` was restored to `translate` and republished, and both routes were re-probed:
`apply_patch` translates and the `custom_tool_call` shape is restored on `gpt-5.3-codex` and
`gpt-5.5` alike. Leaving `strip` live would silently remove `apply_patch` from every session on
this gateway.

## What this does not cover

- Only `custom_tools.mode` was flipped. `tool_search.mode` and `hoist_discovered_tools` stayed at
  their defaults, so this isolates the custom-tool strip path alone.
- No like-for-like token comparison against `translate` — see above.
