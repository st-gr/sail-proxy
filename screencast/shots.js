#!/usr/bin/env node
// Renders every manifest entry (or --only <id>) through the proxy with the redaction overlay injected,
// then asserts that the page text holds no real value of the redaction map before writing the image.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, goto, settled, clickText, click, type, press, inject, shot } from './lib/browser.mjs';
import { overlaySource, redactionMisses, pageText } from './lib/redact.mjs';
import { loadMap } from './check.js';
import { loadState } from './lib/state.mjs';
import { shots } from './shots.manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PROXY = { admin: 'http://127.0.0.1:4010', user: 'http://127.0.0.1:4011' };
const mapPath = join(here, 'redact.local.json');
const seedPath = join(here, 'out', 'seed-keys.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Loaded by main(): the redaction map (real → mock) and the overlay built from it.
let map = {};
let overlay = '';

export function parseOnly(argv) {
  const i = argv.indexOf('--only');
  if (i === -1) return null;
  const id = argv[i + 1];
  if (!id || id.startsWith('--')) throw new Error('usage: --only <id>');
  return id;
}

let seed = null;
function seedValue(field) {
  if (!seed) {
    if (!existsSync(seedPath)) throw new Error(`seed state ${seedPath.replace(root + '/', '')} missing (run screencast/seed.js)`);
    seed = loadState(readFileSync(seedPath, 'utf8'));
  }
  if (typeof seed[field] !== 'string') throw new Error(`seed state has no ${field}`);
  return seed[field];
}

// { env: '<NAME>' } reads a value from the environment at run time (a login for a client app such as n8n, never logged).
function envValue(name) {
  if (typeof process.env[name] !== 'string' || !process.env[name]) throw new Error(`environment variable ${name} missing`);
  return process.env[name];
}

const resolve = (a) => (a && typeof a === 'object'
  ? (a.format ?? '%s').replace('%s', a.env !== undefined ? envValue(a.env) : seedValue(a.seed))
  : a);

async function clickFirstRow(page) {
  const handle = await page.evaluateHandle(() => {
    const rows = Array.from(document.querySelectorAll('.sapMListTblRow, .sapUiTableContentRow .sapUiTableTr, .sapUiTableTr'))
      .filter((r) => !r.classList.contains('sapUiTableRowHidden') && !r.classList.contains('sapMListTblHeader') && !r.closest('.sapUiTableColHdrCnt') && r.getBoundingClientRect().height > 0 && r.textContent.trim());
    const row = rows[0];
    return row ? (row.querySelector('.sapMText, .sapMLnk, .sapMObjectIdentifierTitle') || row) : null;
  });
  const el = handle.asElement();
  if (!el) { await handle.dispose(); throw new Error('no visible table row'); }
  await el.click(); await el.dispose();
}

async function run(entry) {
  const vp = entry.viewport ?? { width: 1440, height: 900, scale: 2 };
  const { browser, page } = await openBrowser(vp);
  try {
    const url = /^https?:/.test(entry.url) ? entry.url : PROXY[entry.identity] + entry.url;
    await goto(page, url);
    await inject(page, overlay);
    const steps = async (list) => {
      for (const [name, ...args] of list) {
        if (name === 'settled') await settled(page);
        else if (name === 'settled-plain') await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
        else if (name === 'clickText') {
          // A text from the state file never reaches an error message.
          if (args[0] && typeof args[0] === 'object') {
            await clickText(page, resolve(args[0]), { group: args[1] }).catch(() => { throw new Error(`no visible element for seed value ${args[0].seed}`); });
          } else await clickText(page, args[0], { group: args[1] });
          await sleep(400);
        } else if (name === 'click') { await click(page, args[0]); await sleep(400); }
        else if (name === 'clickFirstRow') { await clickFirstRow(page); await sleep(400); }
        else if (name === 'type') await type(page, args[0], resolve(args[1]));
        else if (name === 'goto') await goto(page, new URL(args[0], page.url()).href);
        else if (name === 'press') await press(page, args[0]);
        else if (name === 'wait') await sleep(args[0]);
        else if (name === 'script') await page.evaluate(args[0]);
        else throw new Error(`unknown step ${name}`);
        await inject(page, overlay);
      }
    };
    await steps(entry.steps);
    await sleep(entry.settleMs ?? 600);
    // No focus ring or keyboard-shortcut hint from the last click.
    await page.mouse.move(1, 1); await page.evaluate(() => document.activeElement?.blur?.()); await sleep(200);
    // A MessageToast ("data loaded") would cover the content: wait for it to fade out.
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('.sapMMessageToast')).some((e) => e.getBoundingClientRect().height > 0), { timeout: 8000 }).catch(() => {});
    const misses = redactionMisses(await page.evaluate(`(${pageText})(document)`), map);
    if (misses.length) throw new Error(`redaction miss: ${misses.join(', ')}`);
    const out = entry.id === 'og-image' ? join(root, 'docs', 'public', 'og-image.png') : join(root, 'docs', 'assets', 'screenshots', entry.section, `${entry.id}.png`);
    mkdirSync(dirname(out), { recursive: true });
    const sel = typeof entry.clip === 'object' ? entry.clip.selector : undefined;
    await shot(page, { clip: entry.clip, selector: sel, pad: entry.pad ?? 0, path: out });
    console.log(`shot ${entry.id} -> ${out.replace(root + '/', '')}`);
    // Clean-up steps (e.g. discard the draft a Create click opened) keep the demo data unchanged.
    if (entry.after) await steps(entry.after);
  } finally { await browser.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let only;
  try {
    only = parseOnly(process.argv);
    if (existsSync(mapPath)) { map = loadMap(readFileSync(mapPath, 'utf8')); delete map._comment; }
  } catch (err) { console.error(err.message); process.exit(2); }
  overlay = overlaySource(map);
  const list = only ? shots.filter((s) => s.id === only) : shots;
  if (!list.length) { console.error(`no entry ${only}`); process.exit(2); }
  let failed = 0;
  for (const e of list) { try { await run(e); } catch (err) { failed++; console.error(`FAILED ${e.id}: ${err.message}`); } }
  console.log(`${list.length - failed} rendered, ${failed} failed`);
  if (failed) process.exit(1);
}
