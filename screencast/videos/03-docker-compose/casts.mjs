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

// A service key of the right shape with fake values only: the setup writes it into the scratch copy, which nothing
// runs, so the take needs no real key.
const DEMO_SERVICE_KEY = JSON.stringify({
  clientid: 'sb-demo-0000-aicore|aicore!b000',
  clientsecret: 'example-client-secret',
  url: 'https://demo.authentication.example.com',
  identityzone: 'demo',
  serviceurls: { AI_API_URL: 'https://api.ai.demo.example.com' }
});

// A getter, so a cast that needs no key can be recorded (and the module imported) without one.
export const casts = {
  // The interactive setup of a first try on one machine: local test accounts, localhost, the published images, pulled
  // for real (remove the local ones first, README). There is deliberately no answer for "Delete volumes…": should
  // that question ever come, nothing is sent and the cast fails on its next prompt.
  get setup() { return {
    // The docs require Node 24 or later: put a current Node first (SAIL_DOCS_NODE_BIN, else Homebrew's), not the repo's dev Node 20.
    cols: 100, rows: 28, cwd: scratch, env: { ...docker, HOME: scratch, DEMO_SERVICE_KEY, PATH: `${process.env.SAIL_DOCS_NODE_BIN || '/opt/homebrew/bin'}:${process.env.PATH}` },
    setup: [
      'rm -rf sail-proxy && mkdir -p sail-proxy secure && chmod 700 secure',
      `git -C "${root}" archive HEAD | tar -x -C sail-proxy`,
      // The scratch copy has no node_modules: the setup finds inquirer where the npm build installs it.
      `mkdir -p sail-proxy/npm-dist/sail-proxy && ln -s "${root}/npm-dist/sail-proxy/node_modules" sail-proxy/npm-dist/sail-proxy/node_modules`,
      'printf "%s" "$DEMO_SERVICE_KEY" > secure/service-key.json && chmod 600 secure/service-key.json && unset DEMO_SERVICE_KEY'
    ],
    commands: [
      'node --version && docker compose version',
      'cd sail-proxy',
      'export SAP_AI_CORE_SERVICE_KEY="$(cat ~/secure/service-key.json)"',
      { cmd: 'node docker/setup-docker.js', holdMs: 3000, timeoutMs: 900000,
        // The pull takes minutes: played eight times faster (the narration says so).
        fastForward: { from: 'Pulling Docker images from registry', to: 'Docker images pulled successfully', factor: 8 },
        // Each answer waits a moment, so the question can be read before it is answered.
        input: [
          { waitFor: 'Database username', pauseMs: 1200, send: '<enter>' },
          { waitFor: 'Database password', pauseMs: 1200, send: '<enter>' }, // empty: a generated password
          { waitFor: 'Select authentication provider', pauseMs: 1200, send: '<enter>' }, // Local Development (test accounts)
          { waitFor: 'Logout redirect URL', pauseMs: 1200, send: '<enter>' },
          { waitFor: 'Use localhost for development', pauseMs: 1200, send: '<enter>' },
          { waitFor: 'Select image mode', pauseMs: 1200, send: '<down><enter>' }, // Pull from container registry
          { waitFor: 'Container registry', pauseMs: 1200, send: '<enter>' }, // ghcr.io
          { waitFor: 'Registry organization/username', pauseMs: 1200, send: '<enter>' }, // st-gr
          { waitFor: 'SAP billing currency', pauseMs: 1200, send: '<enter>' }, // USD
          { waitFor: 'Allow admins to install plugins', pauseMs: 1200, send: '<enter>' },
          { waitFor: 'Pull Docker images now?', pauseMs: 1200, send: '<enter>' }, // Yes
          { waitFor: 'Review your answers', pauseMs: 1200, send: '<enter>' } // Write configuration
        ] },
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
