// Casts of the Docker Compose video. The `setup` cast runs the setup script in a scratch copy of the tree
// (`git archive`), so the worktree's rendered env files and the running stack are untouched; `up` and
// `call` run against the demo stack through the compose override, with the project settings in the
// environment so the typed commands read like the documentation.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState } from '../../lib/state.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = process.env.SAIL_DOCS_SCRATCH || join(root, 'screencast', 'out', 'scratch');
// HOME points at the scratch folder (no real home path on screen), so the Docker CLI is pointed back at the
// user's config (context and compose plugin) explicitly.
const docker = { DOCKER_CONFIG: join(homedir(), '.docker') };
const stack = { ...docker, COMPOSE_PROJECT_NAME: 'sail-docs', DOCKER_TAG: 'docs-demo', COMPOSE_FILE: `${root}/docker/docker-compose.yml:${root}/screencast/stack/compose.docs.yml` };
// The seeded admin's laptop key: typed into the curl command and shown as the demo key by the key rule.
const callKey = () => loadState(readFileSync(join(root, 'screencast', 'out', 'seed-keys.json'), 'utf8')).keys['mara.lindqvist@example.com'].key;

const serviceKey = () => {
  if (!process.env.SAP_AI_CORE_SERVICE_KEY) throw new Error('SAP_AI_CORE_SERVICE_KEY is not set: run through stack/with-service-key.mjs');
  return process.env.SAP_AI_CORE_SERVICE_KEY;
};

// A getter, so a cast that needs no key can be recorded (and the module imported) without one.
export const casts = {
  get setup() { return {
    cols: 100, rows: 28, cwd: scratch, env: { ...docker, HOME: scratch, SAP_AI_CORE_SERVICE_KEY: serviceKey() },
    setup: [
      'rm -rf sail-proxy && mkdir -p sail-proxy secure && chmod 700 secure',
      `git -C "${root}" archive HEAD | tar -x -C sail-proxy`,
      // The scratch copy has no node_modules: the setup finds inquirer where the npm build installs it.
      `mkdir -p sail-proxy/npm-dist/sail-proxy && ln -s "${root}/npm-dist/sail-proxy/node_modules" sail-proxy/npm-dist/sail-proxy/node_modules`,
      'printf "%s" "$SAP_AI_CORE_SERVICE_KEY" > secure/service-key.json && chmod 600 secure/service-key.json && unset SAP_AI_CORE_SERVICE_KEY'
    ],
    commands: [
      'node --version && docker compose version',
      'cd sail-proxy',
      'export SAP_AI_CORE_SERVICE_KEY="$(cat ~/secure/service-key.json)"',
      { cmd: 'node docker/setup-docker.js --ci --force', holdMs: 3000, timeoutMs: 120000 },
      'ls docker/.env*'
    ]
  }; },
  up: {
    cols: 100, rows: 28, cwd: root, env: { ...stack, HOME: scratch },
    setup: ['docker compose stop >/dev/null 2>&1'],
    commands: [
      { cmd: 'docker compose up -d', holdMs: 25000, timeoutMs: 180000 },
      "docker compose ps --format 'table {{.Service}}\\t{{.Status}}'",
      { cmd: 'curl -s http://localhost:8080/gateway/health', holdMs: 2500 }
    ]
  },
  call: {
    cols: 100, rows: 28, cwd: root, env: { HOME: scratch },
    commands: [
      // One option per line: a command longer than the terminal wraps, and readline's wrap breaks the typed key
      // apart, so the key rule would not see it whole in the echo.
      { cmd: [
        'curl -s http://localhost:8080/gateway/openai/v1/chat/completions \\',
        `  -H "Authorization: Bearer ${callKey()}" \\`,
        '  -H "Content-Type: application/json" \\',
        `  -d '{"model": "gpt-5-mini",`,
        `   "messages": [{"role": "user", "content": "In one sentence: what does an LLM gateway do?"}]}'`
      ].join('\n'), holdMs: 4000, timeoutMs: 90000 }
    ]
  }
};
