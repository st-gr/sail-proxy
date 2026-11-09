#!/usr/bin/env bash
# A home directory for the CLI and client casts: the CLI from npm under its own prefix, its configuration under
# its own directory on port 3100, the clients' first-run questions answered, nothing of the real home read.
# Usage: [SAIL_DOCS_SCRATCH_HOME=<dir>] screencast/stack/scratch-home.sh [reset]   (prints the exports the casts need)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# SAIL_DOCS_SCRATCH_HOME moves it (video 06 uses /tmp/sail-demo: opencode shows the absolute working directory).
home="${SAIL_DOCS_SCRATCH_HOME:-$here/out/scratch-home}"
[ "${1:-}" = reset ] && rm -rf "$home"
mkdir -p "$home/.npm-global" "$home/.config/sail-proxy" "$home/secure" "$home/project"
# The real path: the clients key their trust by it, and macOS's /tmp is a link to /private/tmp.
home="$(cd "$home" && pwd -P)"
chmod 700 "$home/secure"
# The demo project is a git repository of its own, so the coding agents treat it as the project root instead of
# the checkout that contains out/ (whose .claude settings Claude Code would otherwise pick up).
[ -d "$home/project/.git" ] || git -C "$home/project" init -q
# First-run questions answered and update checks off for the interactive casts; none of these files holds a secret.
# Claude Code: no onboarding, the project trusted.
[ -f "$home/.claude.json" ] || printf '{"hasCompletedOnboarding": true, "theme": "dark", "projects": {"%s": {"hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true}}}\n' "$home/project" > "$home/.claude.json"
# Codex: the project trusted, no update check (the launcher passes the gateway as command-line overrides).
mkdir -p "$home/.codex"
[ -f "$home/.codex/config.toml" ] || printf 'check_for_update_on_startup = false\n\n[projects."%s"]\ntrust_level = "trusted"\n' "$home/project" > "$home/.codex/config.toml"
# Gemini CLI: trust the folder, no auto-update.
mkdir -p "$home/.gemini"
[ -f "$home/.gemini/settings.json" ] || printf '{"security": {"folderTrust": {"enabled": false}}, "general": {"disableAutoUpdate": true, "disableUpdateNag": true}}\n' > "$home/.gemini/settings.json"
# pi: its agent directory exists after pi's first start; the launcher writes its provider file into it.
mkdir -p "$home/.pi/agent"
[ -f "$home/.pi/agent/settings.json" ] || printf '{"quietStartup": true}\n' > "$home/.pi/agent/settings.json"
# opencode: its config folder (sail-proxy 0.10.0 does not create it), no auto-update.
mkdir -p "$home/.config/opencode"
[ -f "$home/.config/opencode/opencode.json" ] || printf '{"autoupdate": false}\n' > "$home/.config/opencode/opencode.json"
printf 'console.log("hello from the demo project");\n' > "$home/project/index.js"
echo "export SAIL_DOCS_SCRATCH_HOME=\"$home\""
echo "export npm_config_prefix=\"$home/.npm-global\""
echo "export SAIL_PROXY_CONFIG_DIR=\"$home/.config/sail-proxy\""
