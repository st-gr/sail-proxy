#!/usr/bin/env bash
# sail-proxy 0.10.0 sets ANTHROPIC_BASE_URL to the gateway root, so Claude Code posts to /v1/messages and gets a
# 404 (fixed in 823b2502, published with 0.10.1). Patches the launcher installed in the scratch prefix ($HOME is
# the scratch home in a cast's setup); nothing to do once the installed launcher already names /anthropic. Fails
# unless the old line is there exactly once.
# Usage (a cast's hidden setup step): screencast/stack/patch-claude-launcher.sh || exit 1
set -euo pipefail
f="$HOME/.npm-global/lib/node_modules/@st-gr/sail-proxy/dist/launcher/adapters/claude.js"
grep -q 'ANTHROPIC_BASE_URL:.*/anthropic' "$f" && exit 0
n="$(grep -c 'ANTHROPIC_BASE_URL: ctx.rootUrl,' "$f" || true)"
[ "$n" = 1 ] || { echo "patch-claude-launcher: expected the 0.10.0 line once, found it $n times" >&2; exit 1; }
sed -i.orig 's#ANTHROPIC_BASE_URL: ctx.rootUrl,#ANTHROPIC_BASE_URL: ctx.rootUrl + "/anthropic",#' "$f" && rm -f "$f.orig"
grep -q 'ANTHROPIC_BASE_URL: ctx.rootUrl + "/anthropic",' "$f"
