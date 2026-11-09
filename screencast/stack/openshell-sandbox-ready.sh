#!/usr/bin/env bash
# stack/openshell-sandbox-ready.sh <sandbox>: prepares an OpenShell sandbox (ghcr.io/st-gr/sandbox-claude, created with
# --provider) for the clients video's openshell cast: puts the demo file back in /sandbox/demo and answers Claude Code's
# first-run questions in /tmp/.claude.json, as stack/scratch-home.sh does locally (the image's claude wrapper runs
# Claude Code with HOME=/tmp and copies /etc/openshell/skel/claude.json there when the file is missing). Its menus take arrow keys
# through the kitty keyboard protocol, which a recorded pty cannot send. The key approval holds the last 20 characters
# of the sandbox's ANTHROPIC_API_KEY, which is OpenShell's placeholder, not a key. Prints nothing; fails closed.
set -euo pipefail
sandbox=${1:?usage: openshell-sandbox-ready.sh <sandbox>}
js='const fs = require("fs"); const home = process.env.HOME; const k = process.env.ANTHROPIC_API_KEY || "";
fs.mkdirSync(home + "/demo", { recursive: true });
fs.writeFileSync(home + "/demo/index.js", "console.log(\"hello from the demo project\");\n");
const f = "/tmp/.claude.json"; if (!fs.existsSync(f)) fs.copyFileSync("/etc/openshell/skel/claude.json", f);
const c = JSON.parse(fs.readFileSync(f, "utf8"));
c.hasCompletedOnboarding = true;
c.customApiKeyResponses = { approved: [k.slice(-20)], rejected: [] };
c.projects = { ...c.projects, [home + "/demo"]: { ...(c.projects || {})[home + "/demo"], hasTrustDialogAccepted: true } };
fs.writeFileSync(f, JSON.stringify(c, null, 2));'
openshell sandbox exec --name "$sandbox" --no-tty -- node -e "$js" >/dev/null
