#!/bin/bash
# Does SAP orchestration forward cache_control to Anthropic, and what does it
# report back? Two identical calls: the second should read the cache if the
# first wrote it. Paid: 2 small calls per run. Run with no args, or with
# PREFIX_STYLE=neutral to use a content-filter-safe prefix (see below).
#
# Background: the original run (PREFIX_STYLE=narrative, the default) used a
# fictional-institution sentence as filler and both calls came back with
# finish_reason "content_filter" and empty assistant content. usage was still
# fully populated on both 200 responses, so the cache measurement stood, but
# as a control, PREFIX_STYLE=neutral swaps in inert Lorem-ipsum filler that
# reliably returns finish_reason "stop" with real content ("OK"), while
# reporting the identical prompt_tokens_details field names. Use
# PREFIX_STYLE=neutral for any re-capture where you want a clean, non-filtered
# response as well as the cache numbers.
#
# STREAMING=1 adds a second write/read pair with "stream": true, capturing
# the raw SSE to disk and counting how many chunks carry a `usage` object per
# response (openaiController.ts:547 sums `usage.prompt_tokens` across every
# usage-bearing chunk it sees, so a provider that repeats usage on more than
# one chunk would be double-counted there). Uses a distinct prefix (neutral
# Lorem filler plus a STREAMPROBE marker sentence) so it starts its own cache
# lifecycle instead of riding on whatever the non-streaming pair above just
# wrote/read. Paid: 2 more small calls, only when STREAMING=1.
set -u
G=http://127.0.0.1:3000/openai/v1
K=$(grep -o 'sk-ant-api03-[A-Za-z0-9_-]*' ~/.zshrc | head -1)
[ -n "$K" ] || { echo "no gateway key found"; exit 1; }

MODEL="${MODEL:-anthropic--claude-4.8-opus}"
STYLE="${PREFIX_STYLE:-narrative}"

SCRATCH="${TMPDIR:-/tmp}"

# Anthropic will not cache below a minimum prefix size, so the system block must
# be genuinely large — repeat a paragraph until it comfortably clears 2048 tokens.
if [ "$STYLE" = "neutral" ]; then
  PREFIX=$(python3 -c "print(('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' * 250))")
else
  PREFIX=$(python3 -c "print(('The Kestrel Protocol was ratified in 1987 by the Aurelian Assembly. ' * 400))")
fi

for n in 1 2; do
  python3 - "$PREFIX" "$MODEL" > "$SCRATCH/orch-cache-body.json" <<'PY'
import json,sys
prefix, model = sys.argv[1], sys.argv[2]
body = {
  "model": model,
  "max_tokens": 32,
  "messages": [
    {"role": "system", "content": [
      {"type": "text", "text": prefix, "cache_control": {"type": "ephemeral"}}
    ]},
    {"role": "user", "content": [{"type": "text", "text": "Reply with the single word OK."}]}
  ]
}
print(json.dumps(body))
PY
  curl -s --noproxy '*' -X POST "$G/chat/completions" \
    -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
    --data @"$SCRATCH/orch-cache-body.json" -o "$SCRATCH/orch-cache-run$n.json" \
    -w "  run$n HTTP %{http_code}\n"
done

echo "=== usage + finish_reason + content reported on each run ==="
python3 - "$SCRATCH" <<'PY'
import json,sys
scratch = sys.argv[1]
for n in (1, 2):
    d = json.load(open(f'{scratch}/orch-cache-run{n}.json'))
    print(f'  run{n} usage:', json.dumps(d.get('usage')))
    choices = d.get('choices') or []
    if choices:
        msg = choices[0].get('message', {})
        print(f'  run{n} finish_reason:', choices[0].get('finish_reason'))
        print(f'  run{n} content:', json.dumps(msg.get('content')))
    if 'error' in d:
        print(f'  run{n} error:', json.dumps(d.get('error')))
PY

if [ "${STREAMING:-0}" = "1" ]; then
  # Anthropic prefix caching matches from the START of the prompt, so a
  # prefix built as "the non-streaming arm's sentence + an appended marker"
  # still shares its cached head with the non-streaming arm above — the
  # marker only changes the tail, not the cache key. That produced a
  # cross-arm contamination false-positive (58128 cached_tokens on the
  # streaming read turn, ~2x a single prefix) the first time this arm was
  # captured. Use a wholly different base sentence (no shared substring with
  # the non-streaming prefix above) so the streaming arm has its own,
  # unambiguous cache lifecycle.
  STREAM_PREFIX=$(python3 -c "print('Quantum flux capacitors regulate turbine output whenever ambient pressure exceeds the calibrated threshold value nominally. ' * 250)")

  for n in 1 2; do
    python3 - "$STREAM_PREFIX" "$MODEL" > "$SCRATCH/orch-cache-stream-body.json" <<'PY'
import json,sys
prefix, model = sys.argv[1], sys.argv[2]
body = {
  "model": model,
  "max_tokens": 32,
  "stream": True,
  "messages": [
    {"role": "system", "content": [
      {"type": "text", "text": prefix, "cache_control": {"type": "ephemeral"}}
    ]},
    {"role": "user", "content": [{"type": "text", "text": "Reply with the single word OK."}]}
  ]
}
print(json.dumps(body))
PY
    curl -sN --noproxy '*' -X POST "$G/chat/completions" \
      -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
      --data @"$SCRATCH/orch-cache-stream-body.json" -o "$SCRATCH/orch-cache-stream-run$n.sse" \
      -w "  stream-run$n HTTP %{http_code}\n"
  done

  echo "=== streaming: usage-bearing chunks per response (raw SSE) ==="
  python3 - "$SCRATCH" <<'PY'
import json, sys
scratch = sys.argv[1]
for n in (1, 2):
    path = f'{scratch}/orch-cache-stream-run{n}.sse'
    chunks = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line.startswith('data: '):
                continue
            raw = line[len('data: '):]
            if raw == '[DONE]':
                continue
            chunks.append(json.loads(raw))
    usage_bearing = [(i, c.get('usage')) for i, c in enumerate(chunks) if c.get('usage')]
    print(f'  run{n}: {len(chunks)} data chunk(s) total, {len(usage_bearing)} carrying a non-null usage object')
    for i, usage in usage_bearing:
        print(f'    chunk[{i}] usage:', json.dumps(usage))
PY
fi
