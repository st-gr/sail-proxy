#!/bin/bash
# Live, paid experiment: does the orphan `web_search_call` item that Codex CLI
# replays into turn N+1's history (with no accompanying output/result item)
# cause the model to refuse a web_search call on that turn?
#
# Background lives in websearch-replay-result.md. In short: turn 2 and turn 3
# of a real Codex conversation both carried a completed `web_search_call`
# item in `input` with no matching output, and both turns refused to search;
# turn 1 (no such item) searched. This script tests three arms, built from
# the SAME captured turn-2 client request so every other field — model,
# instructions, tools, tool_choice, reasoning, stream, include, and so on —
# stays byte-identical:
#
#   Arm A (control)  — the turn-2 payload verbatim (9 input items, the
#                       orphan `web_search_call` present at index 6).
#   Arm B (removal)  — the same payload with the orphan item deleted
#                       (8 items).
#   Arm C (fix shape)— the same payload with the orphan item replaced by the
#                       function_call / function_call_output pair the
#                       deployment's tool set actually expects (10 items).
#                       Shapes mirrored from hostedTool/engine.ts's
#                       registry lookups (registry.ts's descriptorForCall:
#                       type === 'function_call' && name === 'web_search')
#                       and webSearch/continuation.ts's
#                       buildFunctionCallOutput. The output is an honest
#                       placeholder noting prior results were not retained
#                       (store: false, no real result to hand back) — not a
#                       fabricated result set.
#
# Arm C's 2/2 result confounded two changes at once: a well-formed
# function_call/function_call_output EXEMPLAR for web_search, and an output
# whose text ("a new search is required...") reads as an instruction. Two
# follow-up arms deconfound that, built from Arm C's shape:
#
#   Arm D (deconfound) — byte-identical to Arm C's function_call, but the
#                       function_call_output's content is strictly neutral:
#                       no imperative, no "required", no "should". States
#                       only that results were not retained.
#   Arm E (exemplar shape vs. content) — Arm D's payload with ONLY the
#                       function_call's tool renamed to `get_goal` (an
#                       unrelated, already-listed function tool with no
#                       required parameters) instead of `web_search`, with
#                       its own neutral output. Run only if Arm D comes back
#                       2/2 or 0/2 (skip if D is mixed — see interpretation
#                       rules in the result file). Arm D came back 1/2
#                       (mixed), so E was never run.
#
# Arm D's no-call read `{"results": [], "state": "not_retained..."}` as "the
# search ran and found nothing" — a different confound (empty results as a
# search OUTCOME) than the imperative-language one, and not one a neutral
# placeholder can dodge. Arm F replaces the placeholder with the real thing:
#
#   Arm F (faithful, non-empty) — Arm C/D's function_call, byte-identical,
#                       paired with a function_call_output carrying a
#                       FAITHFUL, NON-EMPTY result set in
#                       buildFunctionCallOutput's exact shape, populated
#                       with the REAL entries turn 1's own search actually
#                       returned (recovered from searchExecutor.ts's own
#                       `savePayload('websearch-direct',
#                       '10_perplexity_direct_response', ...)` capture,
#                       identified by timestamp falling inside turn 1's
#                       request window — see the arm-builder comment below).
#                       This is what a correct fix would emit if the gateway
#                       retained and replayed prior hosted-tool results, so
#                       whatever the model does with it is the fix's real
#                       real-world behavior, not a placeholder-wording
#                       artifact.
#
# Run against the LIVE gateway at localhost:3000 (nodemon; this script never
# restarts it) so the real hosted-tool rewrite path is exercised — never
# call the deployment directly.
#
# Usage: ARM=A bash websearch-replay-probe.sh   (2 calls)
#        ARM=B bash websearch-replay-probe.sh   (2 calls)
#        ARM=C bash websearch-replay-probe.sh   (2 calls)
#        ARM=D bash websearch-replay-probe.sh   (2 calls)
#        ARM=E bash websearch-replay-probe.sh   (2 calls; gated, see above)
#        ARM=F bash websearch-replay-probe.sh   (6 calls; CALLS=6 required —
#          the default CALLS=2 undercounts this arm's properly-powered run)
#        CALLS=1 ARM=C bash websearch-replay-probe.sh   (1 call, e.g. a retry)
#        CALLS=0 ARM=A bash websearch-replay-probe.sh   (dry run: builds the
#          arm bodies and prints their item counts, fires nothing — the
#          C-style loop below fixes an earlier bug where BSD/macOS `seq 1 0`
#          fired two real calls on what was meant to be a dry run)
#
# Paid. Budget: 6 calls (2 per arm, arms A-C) + 2 retries for a call that
# errors outright, + 4 more (arms D-E) to deconfound Arm C, + 6 more (arm F,
# properly powered) to test the faithful non-empty-result shape. Do not loop
# beyond what's authorized; re-run only when a question is genuinely back in
# doubt.
#
# Auth: reads the gateway API key out of ~/.zshrc itself (grep -o into a
# shell variable) exactly like test/fixtures/orchestration/cache-probe.sh —
# it is never printed, logged, or written to a file. This script never
# contains a key value; if you edit it, keep it that way.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
G=http://127.0.0.1:3000/openai/v1
K=$(grep -o 'sk-ant-api03-[A-Za-z0-9_-]*' ~/.zshrc | head -1)
[ -n "$K" ] || { echo "no gateway key found"; exit 1; }

LOGS_DIR="$REPO_ROOT/services/gateway/logs/payloads"
SOURCE_CAPTURE="${SOURCE_CAPTURE:-$LOGS_DIR/2026-08-08T06-45-35-476Z_gateway-1786171535462-d1nfkg7km_00_original_responses_request.json}"
[ -f "$SOURCE_CAPTURE" ] || { echo "source capture not found: $SOURCE_CAPTURE"; exit 1; }

ARM="${ARM:-A}"
CALLS="${CALLS:-2}"
SCRATCH="${TMPDIR:-/tmp}/websearch-replay"
mkdir -p "$SCRATCH"

curl -s --noproxy '*' -o /dev/null -w '' "http://127.0.0.1:3000/health" || { echo "gateway not reachable on :3000"; exit 1; }

# ---------------------------------------------------------------- build arms
SEARCH_RESULTS_CAPTURE="${SEARCH_RESULTS_CAPTURE:-$LOGS_DIR/2026-08-08T06-44-08-949Z_websearch-direct_10_perplexity_direct_response.json}"

python3 - "$SOURCE_CAPTURE" "$SCRATCH" "$SEARCH_RESULTS_CAPTURE" <<'PY'
import json, sys

source_path, out_dir, search_results_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(source_path) as f:
    captured = json.load(f)
payload = captured['payload']

items = payload['input']
idx = next((i for i, it in enumerate(items) if isinstance(it, dict) and it.get('type') == 'web_search_call'), None)
if idx is None:
    print('no web_search_call item found in source capture input', file=sys.stderr)
    sys.exit(1)
orphan = items[idx]
query = orphan.get('action', {}).get('query', '')
print(f'orphan web_search_call at input[{idx}], query={query!r}', file=sys.stderr)

# Arm A: verbatim.
with open(f'{out_dir}/arm-A.json', 'w') as f:
    json.dump(payload, f)

# Arm B: orphan item deleted, nothing else touched.
arm_b = json.loads(json.dumps(payload))
del arm_b['input'][idx]
with open(f'{out_dir}/arm-B.json', 'w') as f:
    json.dump(arm_b, f)

# Arm C: orphan item replaced by a function_call + function_call_output pair
# in the shape the engine's own registry lookup and the deployment's
# rewritten tool set (type: function, name: web_search) actually expect.
#   - function_call fields (id/type/status/arguments/call_id/name) mirror a
#     real deployment-emitted one, captured turn-1's 03 stream:
#     {"id":"fc_...","type":"function_call","status":"completed",
#      "arguments":"{\"query\":\"...\"}","call_id":"call_...","name":"web_search"}
#   - function_call_output mirrors webSearch/continuation.ts's
#     buildFunctionCallOutput: {type, call_id, output: JSON string}. There is
#     no real prior result to hand back, so the output is a short, honest
#     placeholder saying so rather than a fabricated result set.
call_id = 'call_replay0001XXXXXXXXXXXX'
function_call = {
    'id': 'fc_replay0001',
    'type': 'function_call',
    'status': 'completed',
    'arguments': json.dumps({'query': query}),
    'call_id': call_id,
    'name': 'web_search',
}
function_call_output = {
    'type': 'function_call_output',
    'call_id': call_id,
    'output': json.dumps({
        'results': [],
        'note': 'Prior web_search results were not retained across turns (store: false); a new search is required to see results for this query.',
    }),
}
arm_c = json.loads(json.dumps(payload))
arm_c['input'][idx:idx + 1] = [function_call, function_call_output]
with open(f'{out_dir}/arm-C.json', 'w') as f:
    json.dump(arm_c, f)

# Arm D: byte-identical function_call to Arm C's; the function_call_output's
# content is the ONLY thing that changes, to strictly neutral — no
# imperative, no "required", no "should", no suggestion to search again.
# States a fact (not retained) and nothing else.
function_call_output_neutral = {
    'type': 'function_call_output',
    'call_id': call_id,
    'output': json.dumps({'results': [], 'state': 'not_retained_in_conversation_history'}),
}
arm_d = json.loads(json.dumps(payload))
arm_d['input'][idx:idx + 1] = [function_call, function_call_output_neutral]
with open(f'{out_dir}/arm-D.json', 'w') as f:
    json.dump(arm_d, f)

# Arm E: Arm D's payload with ONLY the function_call's tool changed to an
# unrelated, already-listed function tool (`get_goal`, no required
# parameters per this request's own `tools` array) instead of `web_search`,
# with its own neutral output in the same spirit as Arm D's. Isolates
# "there is SOME prior tool-call exemplar in history" from "there is
# specifically a web_search exemplar."
function_call_other_tool = dict(function_call)
function_call_other_tool['name'] = 'get_goal'
function_call_other_tool['arguments'] = json.dumps({})
function_call_output_other_tool = {
    'type': 'function_call_output',
    'call_id': call_id,
    'output': json.dumps({'goal': None, 'state': 'not_retained_in_conversation_history'}),
}
arm_e = json.loads(json.dumps(payload))
arm_e['input'][idx:idx + 1] = [function_call_other_tool, function_call_output_other_tool]
with open(f'{out_dir}/arm-E.json', 'w') as f:
    json.dump(arm_e, f)

# Arm F: Arm C/D's function_call, byte-identical, paired with a
# function_call_output carrying a FAITHFUL, NON-EMPTY result payload in the
# exact shape webSearch/continuation.ts's buildFunctionCallOutput produces
# ({type, call_id, output: JSON.stringify({results: [{title,url,snippet,
# content,date}, ...]})}) — populated with the REAL entries turn 1's own
# search returned. searchExecutor.ts's savePayload('websearch-direct',
# '10_perplexity_direct_response', ...) call logs the raw Perplexity
# response under a debugRequestId that isn't tied to the gateway request,
# so it isn't named after turn 1's requestId — it's identified here by
# timestamp: 2026-08-08T06:44:08.949Z falls inside turn 1's own request
# window (00 capture 06:44:00.219Z, 03 capture 06:44:13.319Z ends), i.e.
# it fired mid-turn, right where the engine's execute() call for that
# turn's web_search would land. Its query field ("latest AI news today")
# matches the orphan item's recorded query exactly.
with open(search_results_path) as f:
    search_capture = json.load(f)
raw_content = search_capture['payload']['rawResponse']['choices'][0]['message']['content']
real_results = json.loads(raw_content)['results']
print(f'arm F: using {len(real_results)} real result entries from {search_results_path}', file=sys.stderr)

function_call_output_real = {
    'type': 'function_call_output',
    'call_id': call_id,
    'output': json.dumps({
        'results': [
            {'title': r.get('title'), 'url': r.get('url'), 'snippet': r.get('snippet'),
             'content': r.get('content'), 'date': r.get('date')}
            for r in real_results
        ],
    }),
}
arm_f = json.loads(json.dumps(payload))
arm_f['input'][idx:idx + 1] = [function_call, function_call_output_real]
with open(f'{out_dir}/arm-F.json', 'w') as f:
    json.dump(arm_f, f)

for arm in ('A', 'B', 'C', 'D', 'E', 'F'):
    with open(f'{out_dir}/arm-{arm}.json') as f:
        d = json.load(f)
    print(f'arm {arm}: {len(d["input"])} input items', file=sys.stderr)
PY
[ $? -eq 0 ] || exit 1

BODY="$SCRATCH/arm-$ARM.json"
[ -f "$BODY" ] || { echo "no body built for ARM=$ARM"; exit 1; }

# ---------------------------------------------------------------- fire calls
# NOTE: deliberately a C-style arithmetic loop, not `seq 1 "$CALLS"` — BSD/macOS
# seq counts DOWN when first > last (`seq 1 0` prints "1", "0"), so CALLS=0
# would fire two real calls instead of the intended zero-call dry run.
for ((n = 1; n <= CALLS; n++)); do
  MARKER="$SCRATCH/.marker-$ARM-$n"
  touch "$MARKER"
  OUT="$SCRATCH/arm-${ARM}-run${n}.sse"
  HTTP=$(curl -sN --noproxy '*' -X POST "$G/responses" \
    -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
    --data @"$BODY" -o "$OUT" -w '%{http_code}')
  echo "=== arm=$ARM run=$n HTTP $HTTP ==="

  # Locate the deployment-stream capture the live gateway just wrote for
  # THIS call (payload logging is on; see services/gateway/.env). Retried a
  # few times in case the write lands a beat after curl returns.
  DEPLOY_CAPTURE=""
  for _ in 1 2 3 4 5; do
    DEPLOY_CAPTURE=$(find "$LOGS_DIR" -name '*_03_responses_stream_from_deployment.json' -newer "$MARKER" 2>/dev/null | sort | tail -1)
    [ -n "$DEPLOY_CAPTURE" ] && break
    sleep 0.5
  done

  if [ -z "$DEPLOY_CAPTURE" ]; then
    echo "  (no matching *_03_responses_stream_from_deployment.json found — HTTP was $HTTP; check $OUT directly)"
  else
    echo "  deployment capture: $(basename "$DEPLOY_CAPTURE")"
  fi

  python3 - "$OUT" "$DEPLOY_CAPTURE" <<'PY'
import json, re, sys

client_path, deploy_path = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else '')

def load_raw(path):
    try:
        with open(path) as f:
            data = f.read()
    except FileNotFoundError:
        return None
    # Either a raw SSE stream (client capture) or a payload-log JSON wrapper
    # (deployment capture, field `payload.rawResponse`).
    try:
        d = json.loads(data)
        raw = d.get('payload', {}).get('rawResponse')
        if isinstance(raw, str):
            return raw
    except json.JSONDecodeError:
        pass
    return data

def discriminate(raw, label):
    if raw is None:
        print(f'  [{label}] file not found/unreadable')
        return
    fc_arg_events = re.findall(r'response\.function_call_arguments\.\w+', raw)
    ws_call_events = re.findall(r'response\.web_search_call\.\w+', raw)
    added_names = re.findall(r'"type":"function_call","status":"[a-z_]+","arguments":"[^"]*","call_id":"[^"]+","name":"([a-zA-Z_]+)"', raw)
    has_web_search_call_item = '"type":"web_search_call"' in raw
    print(f'  [{label}] function_call_arguments events: {len(fc_arg_events)} {sorted(set(fc_arg_events))}')
    print(f'  [{label}] function_call name(s) seen: {sorted(set(added_names))}')
    print(f'  [{label}] response.web_search_call.* lifecycle events: {sorted(set(ws_call_events))}')
    print(f'  [{label}] client-visible web_search_call item present: {has_web_search_call_item}')
    # Best-effort: the model's own prose, if any (output_text.done deltas).
    texts = re.findall(r'"type":"response\.output_text\.done"[^\n]*?"text":"((?:[^"\\]|\\.)*)"', raw)
    if texts:
        try:
            preview = json.loads('"' + texts[-1][:400] + '"')
        except Exception:
            preview = texts[-1][:400]
        print(f'  [{label}] final message text (truncated): {preview[:300]!r}')

client_raw = load_raw(client_path)
discriminate(client_raw, 'client-facing capture')
if deploy_path:
    deploy_raw = load_raw(deploy_path)
    discriminate(deploy_raw, 'raw deployment capture')
else:
    print('  [raw deployment capture] no file to analyze')
PY

done
