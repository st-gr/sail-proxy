// Client casts in the scratch home, pointed at the demo stack through nginx with a seeded user's key: the
// launchers read the endpoint from the scratch configuration and the key from the environment variable the
// endpoint names (SAILPROXY_KEY); `endpoint set --key-env` stores only the variable's name, so the key is never
// typed or shown.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState } from '../../lib/state.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const home = process.env.SAIL_DOCS_SCRATCH_HOME || join(root, 'screencast', 'out', 'scratch-home');
// Read when a cast is picked, not at import, so the module loads without the seed state; the error says what to do.
const key = () => {
  try { return loadState(readFileSync(join(root, 'screencast', 'out', 'seed-keys.json'), 'utf8')).keys['mara.lindqvist@example.com'].key; }
  catch (e) { throw new Error(`the seeded user's key is unavailable (${e.message}): seed the stack first (out/seed-keys.json)`); }
};
const env = { HOME: home, PATH: `${home}/.npm-global/bin:${process.env.PATH}`, npm_config_prefix: `${home}/.npm-global`, SAIL_PROXY_CONFIG_DIR: `${home}/.config/sail-proxy` };
const common = { cols: 110, rows: 30, cwd: `${home}/project`, env, setup: ['sail-proxy endpoint set http://localhost:8080/gateway --key-env SAILPROXY_KEY >/dev/null'] };
// Every client gets the same task in its own interactive interface (TUI): an edit it shows as a diff, then a run.
// They quit with Ctrl+C twice: a typed /exit opens a command menu whose descriptions, drawn with cursor moves for
// spaces, read as one long token to the redaction check.
// The demo file is put back first, so each cast starts from the same project.
const resetFile = `printf 'console.log("hello from the demo project");\\n' > ${home}/project/index.js`;
const task = 'Add a greet(name) function to index.js, call it with "SAP" and run it.';
const TURN_DONE = /for[^❯]{0,40}?done\b/;
const SEARCH = 'Search the web: which Node.js version is the current LTS? One sentence.';
// sail-proxy 0.10.0 (the published package the install cast installs) sends Claude Code to the gateway root (404);
// until 0.10.1 a hidden setup step patches the installed launcher (stack/patch-claude-launcher.sh, fails closed).
const patchClaude = `"${root}/screencast/stack/patch-claude-launcher.sh" || exit 1`;
// The cast ends on the model's own answer, not mid-run: after the run's output a reply that reports the work.
const REPLY = /\b(added|done|updated|implemented|created)\b/i;
const answered = (pauseMs, send) => [{ waitFor: /hello,? SAP/i, send: '' }, { waitFor: REPLY, pauseMs, send }];
const tui = (cmd, input) => ({ ...common, setup: [...common.setup, resetFile], commands: [{ cmd, input, timeoutMs: 240000, holdMs: 2500 }] });

const defs = {
  // Claude Code asks before the edit and before the command; its turn ends with the "… for 23s · done" line (its
  // spaces arrive as cursor moves, sometimes not at all).
  claude: { ...tui('sail-proxy claude --model claude-sonnet-4-5-20250929', [
    { waitFor: 'manual mode on', pauseMs: 1500, send: [task, '<enter>'] },
    { waitFor: 'Do you want to make this edit', pauseMs: 2000, send: '<enter>' },
    { waitFor: 'Do you want to proceed', pauseMs: 1500, send: '<enter>' },
    // Then a question only the web can answer: Claude Code's Web Search tool runs through the gateway's web search
    // plugin (Perplexity sonar-pro on SAP AI Core).
    // The turn ends on the status line "… for 23s · done"; its duration sometimes does not arrive ("Crunched for done").
    { waitFor: TURN_DONE, pauseMs: 2500, send: [SEARCH, '<enter>'] },
    // Claude Code asks before it searches; the gateway's plugin then runs the search.
    { waitFor: 'Claude wants to search the web', pauseMs: 2000, send: '<enter>' },
    // A web search answer ends with its "Sources:" list. Neither the old "done" line (redrawn with the new prompt) nor
    // a version number (the search query may hold one) marks the end of this turn reliably.
    { waitFor: 'Sources:', timeoutMs: 180000, pauseMs: 5000, send: '<ctrl-c><ctrl-c>' },
  ]), setup: [...common.setup, patchClaude, resetFile] },
  // Codex works in the trusted folder without asking; its result shows the run's output.
  codex: tui('sail-proxy codex --no-web-search', [
    { waitFor: 'Ask Codex to do anything', pauseMs: 1500, send: [task, '<enter>'] },
    ...answered(4000, ['<ctrl-c>', '<ctrl-c>']),
  ]),
  // Gemini CLI asks before the edit and before the shell command.
  gemini: { ...tui('sail-proxy gemini', [
    { waitFor: 'Type your message', pauseMs: 1500, send: [task, '<enter>'] },
    { waitFor: 'Apply this change?', pauseMs: 2000, send: '<enter>' },
    { waitFor: 'Allow execution', pauseMs: 1500, send: '<enter>' },
    ...answered(4000, '<ctrl-c><ctrl-c>'),
  ]), env: { ...env, COLORTERM: 'truecolor' } },
  // pi's default model fails its second turn on SAP AI Core (invalid_encrypted_content); a model is picked instead.
  pi: { ...tui('sail-proxy pi --model sail-proxy/gpt-5-mini', [
    { waitFor: 'gpt-5-mini • medium', pauseMs: 1500, send: [task, '<enter>'] },
    ...answered(4000, '<ctrl-d>'),
  ]), env: { ...env, PI_SKIP_VERSION_CHECK: '1' } },
  // opencode needs the model named: the launcher's provider is sail-proxy with gpt-5.6-sol on the Responses API.
  opencode: tui('sail-proxy opencode -m sail-proxy/gpt-5.6-sol', [
    { waitFor: 'Ask anything', pauseMs: 1500, send: [task, '<enter>'] },
    ...answered(4000, '<ctrl-c><ctrl-c>'),
  ]),
  // Claude Code inside an NVIDIA OpenShell sandbox on Kyma (sandbox sail-demo, created with --provider ods-anthropic
  // beforehand): the driver sets ANTHROPIC_BASE_URL to the gateway's in-cluster address, the agent holds only a
  // placeholder key that the sandbox boundary swaps for the real one, and nothing but the claude binary gets a route
  // (the curl to Anthropic is refused). Recreate the sandbox before each take: connect reattaches to its one shell,
  // screen included. The openshell CLI signs in with its own OIDC login (~/.config/openshell in the
  // scratch home links to the user's). Detaching with Ctrl+P Ctrl+Q keeps the sandbox; `exit` would end it.
  // Production's gateway (0.10.0) still answers Claude Code's first stream with a premature end, which Claude Code
  // retries without streaming; the fix is on the way. Its warning (drawn in colour 220, like the footer, so anchored on
  // its own words; redraws jump the cursor mid-word) is blanked so the take shows the working path.
  openshell: { ...common, blank: [/\x1b\[38;5;220m●(?=\x1b\[3GStreaming|\x1b\[39m \x1b\[38;5;220m {20})/, /\x1b\[38;5;220m(?:[● ]\x1b\[3G)?Streaming response[\s\S]*?\x1b\[39m/, /\x1b\[38;5;220mkeeps happening[\s\S]*?\x1b\[39m/], setup: [`"${root}/screencast/stack/openshell-sandbox-ready.sh" sail-demo || exit 1`], commands: [{ cmd: 'openshell sandbox connect sail-demo', timeoutMs: 300000, holdMs: 2500, input: [
    { waitFor: 'sail-demo:~$', pauseMs: 1500, send: ['echo $ANTHROPIC_BASE_URL', '<enter>'] },
    { waitFor: '/anthropic', pauseMs: 2500, send: ['curl -sS -m 5 https://api.anthropic.com', '<enter>'] },
    { waitFor: "Couldn't connect", pauseMs: 2500, send: ['cd demo && claude', '<enter>'] },
    { waitFor: 'auto mode on', pauseMs: 1500, send: [task, '<enter>'] },
    // "Sautéed for 1m 17s · done": letters of the duration sometimes do not arrive.
    { waitFor: /for \d[\dms ]*·\s*done/, pauseMs: 4000, send: '<ctrl-c><ctrl-c>' },
    { waitFor: 'sail-demo:~/demo$', pauseMs: 1000, send: '<ctrl-p><ctrl-q>' },
  ] }] },
};
// The key goes into the picked cast's environment at lookup time.
export const casts = new Proxy(defs, { get: (t, name) => (name in t ? { ...t[name], env: { ...t[name].env, SAILPROXY_KEY: key() } } : undefined) });
