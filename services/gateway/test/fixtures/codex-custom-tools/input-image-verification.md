# Images through the orchestration route — live verification

Verifies `input_image` support and, more importantly, the shape codex ACTUALLY sends.
Run 2026-08-12 against the running gateway with codex CLI 0.147.0, model `gpt-5.5`.

## What was broken

| | `input_image` part in a message |
|---|---|
| deployed `gpt-5.3-codex` | accepted, `status=completed` |
| orchestration `gpt-5.5` | **rejected** — `Unsupported Responses input item type: input_image` |

Since codex replays its whole history, a rejected image item stays in the conversation and kills
every subsequent turn — the same permanent-brick shape as the compaction gap.

## The premise that was wrong

The plan assumed codex's `view_image` tool sends an `input_image` content part, so fixing that part
type would fix codex. **It does not.** Measured from a real codex turn:

```
data:image at /input[4]/output[0]/image_url
input[3] type=function_call        name=view_image  keys=[arguments, call_id, id, name, type]
input[4] type=function_call_output name=None       keys=[call_id, id, output, type]
```

`view_image` returns the image inside a `function_call_output` whose `output` is an ARRAY carrying
an `image_url`. The bridge turns a `function_call_output` into a `role:'tool'` message and
JSON-stringifies a non-string `output`, so the image reached the model as **base64 text inside a
string**, not as an image.

The behavioural tell: asked to describe a blue square with a white middle band, the model answered
*"a white square with a solid blue horizontal band"* — colour-inverted, i.e. reasoning from
filename and context rather than pixels. Delivered-looking, not perceived.

## The constraint, and the shape that satisfies it

A `role:'tool'` message's `content` **must be a plain string** on this route — block content 400s
with *"Tool message content must be a string for Anthropic harmonization. Received: list."* So the
image cannot live in the tool message.

Proven live BEFORE building: keep the tool message as a string, and emit the image as a FOLLOWING
user message.

```
roles: [developer, user, user, assistant, assistant, tool, user]
  tool  → "Returned an image; see the next message."          (string, as required)
  user  → "Image content from the previous tool call:"
        → { "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } }
```

## Perceived, not merely delivered

Delivery and perception are different claims, and the first does not imply the second. Three runs
of the same pipeline, with the image content varied:

| image | what the model said | verdict |
|---|---|---|
| 96×96 blue, white middle band — BEFORE the fix (base64 as text) | "white square with a blue horizontal band" | inverted — inferred, not seen |
| same image, direct chat probe with a real image block | "blue bands top and bottom, white band across the middle" | correct |
| same image, via codex `view_image` after the fix | "solid medium blue throughout, no other colours" | dominant colour right, band missed |
| **512×512 four quadrants + centre circle, via codex `view_image`** | **"Top-left: red, Top-right: green, Bottom-left: blue, Bottom-right: yellow… a black circle"** | **all five details correct** |

The last row is the one that settles it: five independent facts, none guessable from a filename.
The 96×96 miss was the source image being too small to resolve, not the pipeline degrading it —
the identical image round-tripped accurately through the direct probe.

Wire for that run: one `image_url` block, `data:image/png;base64,…`, 3362 chars, in a `user`
message immediately after the tool message. Total payload 51 KB.

## Scope and known gaps

- Only `data:image/…` URLs are handled in the translator, which is pure and cannot download. A
  separate plugin inlines remote URLs before the bridge sees them; a remote URL reaching the
  translator still throws, deliberately.
- The image is billed as input tokens on every replayed turn, and nothing bounds its size. The
  existing `resizeOversizedImages.ts` operates on Anthropic-shaped `{type:'image'}` blocks and does
  NOT see `image_url` blocks. Recorded, not fixed.
- `cacheBreakpoints.ts`'s `markLastBlock` can still stamp `cache_control` onto an image block —
  pinned by a characterization test, unverified against SAP, unresolved.
- The multi-image caption is fixed singular phrasing ("Image content from the previous tool call:")
  though the code handles several images; only single-image traffic has been observed.
