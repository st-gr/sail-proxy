#!/bin/bash
# T1: does the /openai/v1/responses orchestration bridge's arithmetic genuinely
# treat prompt_tokens as INCLUSIVE of cached tokens (as
# cacheBreakpoints.ts/responsesController.ts's recordOrchestrationUsage
# currently assumes, subtracting both cache categories), or is that an
# artifact of requestTranslator.ts's system message living in BOTH
# prompt.template and messages_history, with applyCacheBreakpoints marking
# only the messages_history copy? See bridge-cache-probe-result.md for the
# captured numbers and verdict.
#
# Four arms, ALL on the SAME model (anthropic--claude-4.8-opus), two
# sequential identical calls each (run 1 writes the cache, run 2 reads it):
#
#   A0 - today's code, caching on (baseline; expected to reproduce the
#        16303-shape numbers already documented in responsesController.ts)
#   A1 - temp edit: mark BOTH system copies with cache_control
#   A2 - temp edit: de-duplicate (system message lives ONLY in
#        prompt.template, removed from messages_history; the breakpoint
#        marks the template copy)
#   A3 - same de-dup edit as A2, PLUS caching forced OFF (the same-model
#        token-count control the original chat/completions-vs-responses
#        comparison lacked, since that used two different models)
#
# A1/A2/A3 each require a manual temp source edit before running — this
# script makes NO source edits itself, so it carries zero production diff by
# construction. Nodemon serves the gateway from services/gateway; after each
# temp edit, touch services/gateway/src/index.ts and wait until the SAME pid
# answers /health 200 three times in a row (a restarting process answers
# once and dies, so the next probe call would get HTTP 000) before invoking
# this script. Revert every temp edit — and re-confirm the same restart
# discipline — before moving on to the next arm's edit. This task ships ZERO
# production diff: `git diff --stat services/gateway/src` must be empty once
# all four arms are done.
#
# ============================== TEMP EDITS ==================================
# Verify line numbers against the real files before editing — they drift.
#
# A1 (services/gateway/src/responses/orchestrationBridge/cacheBreakpoints.ts,
#     inside applyCacheBreakpoints, right after the existing
#     `history.find(...)"system message"` block): additionally mark the
#     TEMPLATE's system copy, on top of the history copy the shipped code
#     already marks —
#
#   const templateArr = next?.config?.modules?.prompt_templating?.prompt?.template;
#   const templateSystem = Array.isArray(templateArr)
#     ? templateArr.find((m: any) => m.role === 'system') : undefined;
#   if (templateSystem) markLastBlock(templateSystem);
#
# A2 (services/gateway/src/responses/orchestrationBridge/requestTranslator.ts,
#     buildOrchestrationPayload, ~line 172-187): stop putting the system
#     message in messages_history once it is already in the template —
#     mirror openaiController.ts:1072-1073's disjoint split —
#
#   const systemMessage = messages.find((m) => m.role === 'system');
#   const template: SapV2Message[] = systemMessage
#     ? [systemMessage]
#     : [{ role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] }];
#   const historyMessages = systemMessage ? messages.filter((m) => m !== systemMessage) : messages;
#   ...
#   messages_history: historyMessages,   // was: messages
#
#   AND in cacheBreakpoints.ts, mark the TEMPLATE copy (the history array no
#   longer carries a system message at all after the edit above, so the
#   shipped `history.find(...)` block becomes a harmless no-op — leave it in
#   place, just add the template-marking block ahead of it):
#
#   const templateArr = next?.config?.modules?.prompt_templating?.prompt?.template;
#   const templateSystem = Array.isArray(templateArr)
#     ? templateArr.find((m: any) => m.role === 'system') : undefined;
#   if (templateSystem && markLastBlock(templateSystem)) used += 1;
#
# A3: the SAME requestTranslator.ts + cacheBreakpoints.ts edits as A2, PLUS
#     in services/gateway/src/controllers/responsesController.ts's
#     dispatchOrchestration (~line 228), force caching off regardless of the
#     model's supports_prompt_caching flag —
#
#   payload = applyCacheBreakpoints(payload, { enabled: false });
#
#   (the `buildContinuationPayload` closure a few lines down, ~line 267, has
#   a second call site with the same `enabled:` expression; this probe never
#   triggers a continuation, so only the first call site is load-bearing for
#   the two calls this script makes — but force it off too if being thorough)
# ==============================================================================

set -u
G=http://127.0.0.1:3000/openai/v1
K=$(grep -o 'sk-ant-api03-[A-Za-z0-9_-]*' ~/.zshrc | head -1)
[ -n "$K" ] || { echo "no gateway key found"; exit 1; }

MODEL="${MODEL:-anthropic--claude-4.8-opus}"
ARM="${ARM:-A0}"

SCRATCH="${TMPDIR:-/tmp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="$(cd "$SCRIPT_DIR/../../.." && pwd)/logs/payloads"

# Distinct filler sentence per arm. Anthropic's ephemeral cache lives ~5
# minutes; if two arms shared a prefix, a later arm's run 1 would silently
# land as a cache HIT against an earlier arm's write and the write/read
# split for that arm would be garbage. Repeated 300x, each sentence clears
# the ~2048-token minimum cacheable size by a wide margin (the existing
# chat/completions probe uses 250-400x for the same reason).
case "$ARM" in
  A0) SENTENCE="Arm A0 baseline probe filler sentence built to exceed the minimum cacheable prefix size for the bridge cache measurement." ;;
  A1) SENTENCE="Arm A1 both-copies-marked probe filler sentence built to exceed the minimum cacheable prefix size for the bridge cache measurement." ;;
  A2) SENTENCE="Arm A2 deduplicated-system-message probe filler sentence built to exceed the minimum cacheable prefix size for the bridge cache measurement." ;;
  A3) SENTENCE="Arm A3 deduplicated-caching-off probe filler sentence built to exceed the minimum cacheable prefix size for the bridge cache measurement." ;;
  # B4 (task B4, default-tier probe): pruned admin config, no supports_prompt_caching
  # flag anywhere for the Anthropic models under test. See
  # bridge-cache-probe-result.md's B4 section for the prediction and results.
  B4) SENTENCE="Arm B4 default-tier probe filler sentence built to exceed the minimum cacheable prefix size for the unflagged-anthropic-model default-caching measurement." ;;
  B4NEG) SENTENCE="Arm B4 negative-control probe filler sentence for the explicit false supports_prompt_caching haiku model, built to exceed the minimum cacheable prefix size." ;;
  *) echo "unknown ARM: $ARM (expected one of A0 A1 A2 A3 B4 B4NEG)"; exit 1 ;;
esac

# REPEAT: how many times the filler sentence is repeated to build PREFIX.
# REPEAT=300 (the historical default) lands the A0-A3 sentences around
# 34.5k-40.5k chars. B4/B4NEG use a smaller REPEAT (set by the caller) to hit
# the ~10-15k char range that task B4's hand-computed prediction commits to
# before any call is made.
REPEAT="${REPEAT:-300}"
PREFIX=$(python3 -c "print(('$SENTENCE ' * $REPEAT))")

# CALLS: how many sequential identical calls to make (2 = write then read,
# the historical default; 1 = single call, used for a cheap negative control
# that only needs to confirm the wire marker is absent, not the cache economics).
CALLS="${CALLS:-2}"

echo "=== ARM=$ARM MODEL=$MODEL prefix chars=${#PREFIX} calls=$CALLS ==="

for n in $(seq 1 "$CALLS"); do
  BEFORE=$(ls "$LOGDIR" 2>/dev/null | sort)

  python3 - "$PREFIX" "$MODEL" > "$SCRATCH/bridge-cache-body.json" <<'PY'
import json, sys
prefix, model = sys.argv[1], sys.argv[2]
body = {
  "model": model,
  "max_output_tokens": 32,
  "instructions": prefix,
  "input": "Reply with the single word OK.",
}
print(json.dumps(body))
PY

  curl -s --noproxy '*' -X POST "$G/responses" \
    -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
    --data @"$SCRATCH/bridge-cache-body.json" -o "$SCRATCH/bridge-cache-${ARM}-run$n.json" \
    -w "  run$n HTTP %{http_code}\n"

  # savePayload writes synchronously (fs.writeFileSync) before the HTTP
  # response is sent, so no extra wait is needed before diffing the
  # directory — but a brief pause costs nothing and guards against any
  # filesystem-visibility lag.
  sleep 0.5
  AFTER=$(ls "$LOGDIR" 2>/dev/null | sort)
  NEW=$(comm -13 <(echo "$BEFORE") <(echo "$AFTER"))
  REQ=$(echo "$NEW" | grep '_02_responses_request_to_orchestration\.json$' | head -1)
  RESP=$(echo "$NEW" | grep '_03_responses_response_from_orchestration\.json$' | head -1)
  echo "  run$n payload files: req=${REQ:-<none>} resp=${RESP:-<none>}"
  [ -n "$REQ" ] && cp "$LOGDIR/$REQ" "$SCRATCH/bridge-cache-${ARM}-run${n}-req.json"
  [ -n "$RESP" ] && cp "$LOGDIR/$RESP" "$SCRATCH/bridge-cache-${ARM}-run${n}-resp.json"
done

echo "=== per-run wire attribution + usage (ARM=$ARM) ==="
python3 - "$SCRATCH" "$ARM" "$CALLS" <<'PY'
import json, sys
scratch, arm, calls = sys.argv[1], sys.argv[2], int(sys.argv[3])
for n in range(1, calls + 1):
    print(f'--- run{n} ---')
    try:
        req = json.load(open(f'{scratch}/bridge-cache-{arm}-run{n}-req.json'))['payload']
        tmpl = req['config']['modules']['prompt_templating']['prompt']['template']
        hist = req.get('messages_history', [])
        tmpl_sys = [m for m in tmpl if m.get('role') == 'system']
        hist_sys = [m for m in hist if m.get('role') == 'system']

        def marked(m):
            return [bool(b.get('cache_control')) for b in m.get('content', []) if isinstance(b, dict)]

        print('  template system copies:', len(tmpl_sys), 'marked:', [marked(m) for m in tmpl_sys])
        print('  history  system copies:', len(hist_sys), 'marked:', [marked(m) for m in hist_sys])
    except Exception as e:
        print('  (could not read request payload capture:', e, ')')

    try:
        resp = json.load(open(f'{scratch}/bridge-cache-{arm}-run{n}-resp.json'))['payload']
        usage = resp['final_result']['usage']
        print('  raw orchestration usage:', json.dumps(usage))
    except Exception as e:
        print('  (could not read response payload capture:', e, ')')

    try:
        client = json.load(open(f'{scratch}/bridge-cache-{arm}-run{n}.json'))
        print('  client-visible usage:', json.dumps(client.get('usage')))
    except Exception as e:
        print('  (could not read client response:', e, ')')
PY
