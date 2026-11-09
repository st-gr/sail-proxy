# Golden shapes for hosted-tool input item types

Captured 2026-08-11 directly from `api.openai.com/v1/responses` with an API key, model `gpt-5.5`.
**Every field name here is from the wire.** Long strings are trimmed; nothing is invented.

These cover types that appear in the API's authoritative 33-item list but that no codex client in
this repo's captures has ever sent, so they could not be learned from our own traffic. Each was
elicited by declaring the DOCUMENTED HOSTED TOOL and recording what the API produced — never by
hand-writing an item shape and seeing whether it was accepted. That distinction matters: a 400
from a guessed shape says nothing about whether a type is supported, and this repo has already
been misled once by exactly that (a `compaction` probe whose 400 was actually about a malformed
sibling `reasoning` item).

## `code_interpreter_call`

Elicited with `tools: [{"type": "code_interpreter", "container": {"type": "auto"}}]`.
Output items for the turn: `reasoning`, `code_interpreter_call`, `message`.

```json
{ "id": "ci_065e340c60f604f3006a7bc991ca28819ba777f1ba3c89de45",
  "type": "code_interpreter_call",
  "status": "completed",
  "code": "6*7",
  "container_id": "cntr_6a7bc990b4048198a01ffc81d1e9690b038ea3956007a0c6",
  "outputs": null }
```

Note `code` is a plain string and `container_id` is a separate opaque handle. `outputs` was
`null` here rather than an empty array.

## `mcp_list_tools`

Elicited with `tools: [{"type": "mcp", "server_label": "deepwiki", "server_url": "https://mcp.deepwiki.com/mcp", "require_approval": "never"}]`.
Emitted once, before any call, as the server advertises its inventory.

```json
{ "id": "mcpl_0888b1dc9ddd5e70006a7bca1b0e908199a2835cfa415f175a",
  "type": "mcp_list_tools",
  "server_label": "deepwiki",
  "tools": [ /* 3 entries */ ] }
```

## `mcp_call`

Same request. Output items: `mcp_list_tools`, `reasoning`, `mcp_call`, `message`.

```json
{ "id": "mcp_0888b1dc9ddd5e70006a7bca1ca8888199ad07f955b8588a0c",
  "type": "mcp_call",
  "status": "completed",
  "approval_request_id": null,
  "arguments": "{\"repoName\":\"openai/codex\"}",
  "error": null,
  "name": "read_wiki_structure",
  "output": "Available pages for openai/codex:\n\n- 1 Overview\n…",
  "server_label": "deepwiki" }
```

**`arguments` is a JSON STRING here**, unlike `tool_search_call` where it is an object. The two
hosted mechanisms disagree, so neither can be assumed from the other. `output` is a plain string,
not an array of content parts — again unlike `custom_tool_call_output`.

## `mcp_approval_request`

Same server with `require_approval: "always"`. Output items: `mcp_list_tools`, `reasoning`,
`mcp_approval_request` — the call itself is withheld pending approval.

```json
{ "id": "mcpr_03fb4a1c7b070f4c006a7bca6d1340819bacfb3f5cca014611",
  "type": "mcp_approval_request",
  "arguments": "{\"repoName\":\"openai/codex\"}",
  "name": "read_wiki_structure",
  "server_label": "deepwiki" }
```

The matching `mcp_approval_response` is a CLIENT-sent item and so was not observed here; sending
one would mean writing a shape rather than recording one.

## Types proven unavailable rather than merely unobserved

Both are real findings — a refusal naming the tool is evidence, unlike a refusal caused by a
guessed item shape.

| Tool declared | Response |
|---|---|
| `local_shell` | `The local_shell tool is no longer supported.` |
| `computer_use_preview` | `Tool 'computer_use_preview' is not supported with gpt-5.5.` |

So `local_shell_call` / `local_shell_call_output` are dead types on the current API, and
`computer_call` / `computer_call_output` are gated by model rather than universally available —
the refusal names the model, so a different model may accept it.

`image_generation` was accepted as a tool declaration, but the prompt gave the model no reason to
generate an image, so no `image_generation_call` item was produced. Forcing one costs real image
generation and was not done.

## Still unobserved after this pass

`additional_tools` (seen only against the ChatGPT backend), `agent_message`, `apply_patch_call`,
`apply_patch_call_output`, `file_search_call` (would require creating a vector store in the
account — deliberately not done), `image_generation_call`, `item_reference` (requires
`store: true`), `mcp_approval_response`, `multi_agent_call`, `multi_agent_call_output`, `program`,
`program_output`, `shell_call`, `shell_call_output`.

## Why none of this changes the gateway yet

The orchestration bridge throws `UnsupportedInputItemError` on every one of these, and the
deployed route forwards them all. Nothing here is wired up: these shapes exist so that if a
client ever does send one, the translation can be written against evidence instead of a guess.
