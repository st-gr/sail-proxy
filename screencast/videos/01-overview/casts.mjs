// The one cast of the overview: a chat completion through nginx with the seeded admin's laptop key (shown as
// the demo key by the key rule).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState } from '../../lib/state.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = process.env.SAIL_DOCS_SCRATCH || join(root, 'screencast', 'out', 'scratch');
const callKey = () => loadState(readFileSync(join(root, 'screencast', 'out', 'seed-keys.json'), 'utf8')).keys['mara.lindqvist@example.com'].key;

export const casts = {
  call: { cols: 100, rows: 28, cwd: root, env: { HOME: scratch }, commands: [
    { cmd: [
      'curl -s http://localhost:8080/gateway/openai/v1/chat/completions \\',
      `  -H "Authorization: Bearer ${callKey()}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "gpt-5-mini",`,
      `   "messages": [{"role": "user", "content": "Name three things an LLM gateway does, in one line each."}]}'`
    ].join('\n'), holdMs: 5000, timeoutMs: 90000 }
  ] }
};
