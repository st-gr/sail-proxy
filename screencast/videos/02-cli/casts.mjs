// Casts of the CLI video, all in the scratch home (screencast/stack/scratch-home.sh). The setup's editor
// prompt opens $EDITOR on a temporary file; a two-line editor script copies the service key from the
// environment into it, so the key is neither typed nor shown. Port 3100 keeps clear of the dev stack.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const home = process.env.SAIL_DOCS_SCRATCH_HOME || join(root, 'screencast', 'out', 'scratch-home');
const env = { HOME: home, PATH: `${home}/.npm-global/bin:${process.env.PATH}`, npm_config_prefix: `${home}/.npm-global`, SAIL_PROXY_CONFIG_DIR: `${home}/.config/sail-proxy`, EDITOR: `${home}/secure/paste-key.sh`, npm_config_update_notifier: 'false', npm_config_fund: 'false' };
const common = { cols: 100, rows: 28, cwd: `${home}/project`, env };
const prompt = 'In one sentence, what does an LLM gateway do?';
// sail-proxy 0.10.0 (the published package the install cast installs) sends Claude Code to the gateway root (404);
// until 0.10.1 a hidden setup step patches the installed launcher (stack/patch-claude-launcher.sh, fails closed).
const patchClaude = `"${root}/screencast/stack/patch-claude-launcher.sh" || exit 1`;


const serviceKey = () => {
  if (!process.env.SAP_AI_CORE_SERVICE_KEY) throw new Error('SAP_AI_CORE_SERVICE_KEY is not set: run through stack/with-service-key.mjs');
  return process.env.SAP_AI_CORE_SERVICE_KEY;
};

// A getter, so a cast that needs no key can be recorded (and the module imported) without one.
export const casts = {
  // npm first: the verifier's unwrapped copy of "v20.x.y" followed by "10.x.y" would read as an IPv4 address.
  install: { ...common, commands: ['npm --version && node --version', { cmd: 'npm install -g @st-gr/sail-proxy', timeoutMs: 300000, holdMs: 2500 }, 'sail-proxy --version'] },
  get configure() { return { ...common, env: { ...env, SAP_AI_CORE_SERVICE_KEY: serviceKey() },
    setup: [
      'printf \'#!/bin/sh\\nprintf "%%s" "$SAP_AI_CORE_SERVICE_KEY" > "$1"\\n\' > "$HOME/secure/paste-key.sh" && chmod 700 "$HOME/secure/paste-key.sh"',
      'rm -rf "$SAIL_PROXY_CONFIG_DIR" && mkdir -p "$SAIL_PROXY_CONFIG_DIR"'
    ],
    commands: [{ cmd: 'sail-proxy', timeoutMs: 180000, holdMs: 3000, input: [
      { waitFor: 'service key JSON', send: '<enter>' },
      { waitFor: 'Resource Group', send: '<enter>' },
      { waitFor: 'Server Port', send: '3100<enter>' },
      { waitFor: 'Ollama Auto-start', send: 'n<enter>' },
      { waitFor: 'Save configuration', send: 'y<enter>' }
    ] }, 'ls -A "$SAIL_PROXY_CONFIG_DIR"'] }; },
  run: { ...common, commands: [{ cmd: 'sail-proxy run', holdMs: 4000 }, { cmd: 'sail-proxy status', holdMs: 3000 }, { cmd: 'curl -s http://localhost:3100/health', holdMs: 2500 }] },
  apikey: { ...common, commands: [{ cmd: 'sail-proxy apikey create laptop', holdMs: 5000 }, { cmd: 'sail-proxy apikey list', holdMs: 3000 }] },
  // The model is named: Claude Code's default is not among the gateway's model substitutions; one option per line (no wrap).
  claude: { ...common, setup: [patchClaude], commands: [{ cmd: [
    'sail-proxy claude --model claude-sonnet-4-5-20250929 \\',
    `  -p "${prompt}"`
  ].join('\n'), timeoutMs: 180000, holdMs: 5000 }] },
  status: { ...common, commands: [{ cmd: 'sail-proxy status', holdMs: 3000 }, { cmd: 'sail-proxy logs gateway --tail 8', holdMs: 5000 }, { cmd: 'sail-proxy stop', holdMs: 2000 }] }
};
