/**
 * Pseudonymization Plugin - Integration Test
 *
 * Cross-platform Node.js test script that exercises the pseudonymization plugin
 * against a running gateway instance.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/plugins/test-pseudonymization.ts [--port 3000] [--api-key KEY]
 *
 * Or via npm script:
 *   pnpm test:pseudonymization:integration
 *
 * Prerequisites:
 *   - Gateway running: DEBUG=true PAYLOAD_LOGGING_ENABLED=true pnpm run dev
 *   - Valid API key (or test mode enabled)
 *
 * After running, check ./logs/payloads/ for proof that masked content was sent upstream.
 */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const keyIdx = args.indexOf('--api-key');

const PORT = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3000;
const API_KEY = keyIdx !== -1 ? args[keyIdx + 1] : 'test';
const BASE_URL = `http://localhost:${PORT}`;
const MODEL = 'claude-sonnet-4-20250514';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function check(testName: string, condition: boolean): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${testName}`);
    passCount++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${testName}`);
    failCount++;
  }
}

function post(endpoint: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(endpoint, BASE_URL);

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 30000,
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch {
          resolve({ _raw: responseData });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

async function isGatewayRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${BASE_URL}/anthropic/v1/messages`, () => resolve(true));
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function test1_basicPseudonymization(): Promise<void> {
  console.log('\x1b[33mTest 1: Basic Pseudonymization\x1b[0m');

  const response = await post('/anthropic/v1/messages', {
    model: MODEL,
    messages: [{ role: 'user', content: 'Summarize the case for John Smith at 123 Main St. His SSN is 123-45-6789 and email is john.smith@example.com.' }],
    max_tokens: 100,
    masking: {
      method: 'pseudonymization',
      entities: [
        { type: 'profile-person' },
        { type: 'profile-email' },
        { type: 'profile-ssn' },
        { type: 'profile-address' },
      ],
    },
  });

  const maskingInfo = response?.masking_info;
  check('masking_info present in response', !!maskingInfo);

  const entitiesCount = maskingInfo?.entities_detected?.length || 0;
  check('entities detected (>= 2)', entitiesCount >= 2);

  const maskedInput = maskingInfo?.masked_input || '';
  check('masked_input contains MASKED_ tokens', maskedInput.includes('MASKED_'));

  check('masked_input does not contain original PII', !maskedInput.includes('John Smith') && !maskedInput.includes('123-45-6789'));
}

async function test2_allowList(): Promise<void> {
  console.log('\x1b[33mTest 2: Allow-list (San Diego should not be masked)\x1b[0m');

  const response = await post('/anthropic/v1/messages', {
    model: MODEL,
    messages: [{ role: 'user', content: 'John Smith works for City of San Diego in San Diego, California.' }],
    max_tokens: 50,
    masking: {
      method: 'pseudonymization',
      entities: [{ type: 'profile-person' }, { type: 'profile-location' }],
      allow_list: ['San Diego', 'City of San Diego', 'California'],
    },
  });

  const maskedInput = response?.masking_info?.masked_input || '';
  check('San Diego preserved (allow-list)', maskedInput.includes('San Diego'));
  check('John Smith masked', maskedInput.includes('MASKED_PERSON'));
}

async function test3_customRegex(): Promise<void> {
  console.log('\x1b[33mTest 3: Custom Regex Entity\x1b[0m');

  const response = await post('/anthropic/v1/messages', {
    model: MODEL,
    messages: [{ role: 'user', content: 'Permit PTS-20240015 was issued to John Smith on 2024-03-15.' }],
    max_tokens: 50,
    masking: {
      method: 'pseudonymization',
      entities: [{ type: 'profile-person' }],
      custom_entities: [{ pattern: '\\bPTS-\\d+\\b', placeholder: 'MASKED_PERMIT' }],
    },
  });

  const maskedInput = response?.masking_info?.masked_input || '';
  check('custom permit number masked', maskedInput.includes('MASKED_PERMIT'));
  check('person also masked', maskedInput.includes('MASKED_PERSON'));
}

async function test4_anonymization(): Promise<void> {
  console.log('\x1b[33mTest 4: Anonymization Mode\x1b[0m');

  const response = await post('/anthropic/v1/messages', {
    model: MODEL,
    messages: [{ role: 'user', content: 'John Smith called Jane Doe yesterday.' }],
    max_tokens: 50,
    masking: {
      method: 'anonymization',
      entities: [{ type: 'profile-person' }],
    },
  });

  const maskedInput = response?.masking_info?.masked_input || '';
  const method = response?.masking_info?.method || '';

  check('anonymization uses unique IDs (MASKED_PERSON_1, _2)', /MASKED_PERSON_1/.test(maskedInput) && /MASKED_PERSON_2/.test(maskedInput));
  check('anonymization cannot unmask (no reverse map)', !response?.content?.[0]?.text?.includes('John Smith'));
  check('method reported as anonymization', method === 'anonymization');
}

async function test5_noMaskingConfig(): Promise<void> {
  console.log('\x1b[33mTest 5: No masking config (pass-through)\x1b[0m');

  const response = await post('/anthropic/v1/messages', {
    model: MODEL,
    messages: [{ role: 'user', content: 'Hello world' }],
    max_tokens: 50,
  });

  check('no masking_info when masking config absent', !response?.masking_info);
}

async function test6_triggerword(): Promise<void> {
  console.log('\x1b[33mTest 6: Triggerword Activation\x1b[0m');

  const response = await post('/anthropic/v1/messages', {
    model: MODEL,
    messages: [{ role: 'user', content: '<sail-proxy:pseudonymization:on> John Smith lives at 123 Main St and his email is john@example.com' }],
    max_tokens: 50,
  });

  const maskedInput = response?.masking_info?.masked_input || '';
  check('triggerword activates masking', !!response?.masking_info);
  check('triggerword stripped from masked input', !maskedInput.includes('<sail-proxy:'));
  check('PII masked via triggerword', maskedInput.includes('MASKED_PERSON') && maskedInput.includes('MASKED_EMAIL'));
}

async function test7_triggerwordAnonymization(): Promise<void> {
  console.log('\x1b[33mTest 7: Anonymization Triggerword\x1b[0m');

  const response = await post('/anthropic/v1/messages', {
    model: MODEL,
    messages: [{ role: 'user', content: '<sail-proxy:anonymization:on> Jane Doe called Bob Johnson' }],
    max_tokens: 50,
  });

  const method = response?.masking_info?.method || '';
  const maskedInput = response?.masking_info?.masked_input || '';
  check('anonymization triggerword sets method', method === 'anonymization');
  check('anonymization triggerword masks PII', maskedInput.includes('MASKED_PERSON'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
  console.log('\x1b[36m  Pseudonymization Plugin - Integration Tests\x1b[0m');
  console.log(`\x1b[36m  Target: ${BASE_URL}/anthropic/v1/messages\x1b[0m`);
  console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
  console.log('');

  const running = await isGatewayRunning();
  if (!running) {
    console.error('\x1b[31mERROR: Gateway not responding on ' + BASE_URL + '\x1b[0m');
    console.error('Start with: DEBUG=true PAYLOAD_LOGGING_ENABLED=true pnpm run dev');
    process.exit(1);
  }

  try { await test1_basicPseudonymization(); } catch (e: any) { console.error('  ERROR:', e.message); }
  console.log('');
  try { await test2_allowList(); } catch (e: any) { console.error('  ERROR:', e.message); }
  console.log('');
  try { await test3_customRegex(); } catch (e: any) { console.error('  ERROR:', e.message); }
  console.log('');
  try { await test4_anonymization(); } catch (e: any) { console.error('  ERROR:', e.message); }
  console.log('');
  try { await test5_noMaskingConfig(); } catch (e: any) { console.error('  ERROR:', e.message); }
  console.log('');
  try { await test6_triggerword(); } catch (e: any) { console.error('  ERROR:', e.message); }
  console.log('');
  try { await test7_triggerwordAnonymization(); } catch (e: any) { console.error('  ERROR:', e.message); }
  console.log('');

  // Summary
  console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
  const total = passCount + failCount;
  console.log(`  Results: \x1b[32m${passCount} passed\x1b[0m, \x1b[31m${failCount} failed\x1b[0m, ${total} total`);
  console.log('');

  // Check for payload logs
  const logsDir = path.join(process.cwd(), 'logs', 'payloads');
  if (fs.existsSync(logsDir)) {
    const files = fs.readdirSync(logsDir);
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const recentFiles = files.filter(f => {
      try {
        const stat = fs.statSync(path.join(logsDir, f));
        return stat.mtimeMs > fiveMinAgo;
      } catch { return false; }
    });

    if (recentFiles.length > 0) {
      console.log(`  \x1b[32mPayload logs available:\x1b[0m ${recentFiles.length} recent files in ./logs/payloads/`);
      console.log('  To verify masking was sent upstream:');
      console.log('    Look for *sap_request_payload*.json files and search for MASKED_ tokens');
    }
  } else {
    console.log('  \x1b[33mNote:\x1b[0m Enable payload logging to verify masked data sent upstream:');
    console.log('    DEBUG=true PAYLOAD_LOGGING_ENABLED=true pnpm run dev');
  }

  console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
