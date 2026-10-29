// The teaser's still layers, rendered once by the cards' browser: opaque cards (logo, tagline, the architecture diagram, end screen) and
// transparent text (a punch word, a lower title) that ffmpeg moves and fades over the footage. This ffmpeg build
// has no drawtext, so every letter on screen comes from here.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../lib/browser.mjs';
import { CAST_PORT, startCastServer } from '../lib/record.mjs';
import { FINE, SITE, REPO } from '../lib/cards.mjs';

export const TAGLINE = 'Enterprise LLM gateway for SAP AI Core.';
export const END_LINES = [TAGLINE, 'Free.', 'From the community, for the community.'];
export const INSTALL = 'npm install -g @st-gr/sail-proxy';
// npm-dist is the lite gateway; the heavy features need the Docker or Kyma stack.
export const EDITION = 'Lite on your laptop · full stack on Docker or Kyma';
const LOGO = '/assets/sail-proxy-logo.svg';

export function layerModel(kind, input = {}) {
  if (kind === 'logo') return { kind, logo: LOGO, opaque: true };
  if (kind === 'diagram') return { kind, src: '/assets/sail-proxy-deployment-options.svg', opaque: true };
  if (kind === 'tagline') {
    const words = TAGLINE.split(' ');
    if (!(input.shown >= 1 && input.shown <= words.length)) throw new Error(`tagline: shown must be 1 to ${words.length}`);
    return { kind, words, shown: input.shown, opaque: true };
  }
  if (kind === 'end') return { kind, lines: END_LINES, cta: 'Give it a try', install: INSTALL, edition: EDITION, qr: '/teaser/qr-docs.svg', qrLabel: 'Scan for the docs', site: SITE, repo: REPO, fine: FINE, logo: LOGO, opaque: true };
  if (kind === 'word') {
    if (!input.text) throw new Error('word: needs a word');
    return { kind, text: input.text, opaque: false };
  }
  if (kind === 'text') {
    if (!input.lines?.length) throw new Error('text: needs at least one line');
    return { kind, lines: input.lines, style: input.style ?? 'title', opaque: false };
  }
  throw new Error(`unknown layer ${kind}`);
}

// specs: [{ name, kind, input }] → <outDir>/<name>.png, 1920×1080, transparent unless the layer is opaque.
export async function renderLayers(specs, outDir) {
  mkdirSync(outDir, { recursive: true });
  const server = await startCastServer('teaser');
  const { browser, page } = await openBrowser({ width: 1920, height: 1080, scale: 1 });
  const files = [];
  try {
    for (const s of specs) {
      const m = layerModel(s.kind, s.input);
      await page.goto(`http://127.0.0.1:${CAST_PORT}/teaser/layers.html`, { waitUntil: 'load' });
      await page.evaluate((model) => window.__render(model), m);
      await page.waitForFunction(() => document.title === 'rendered', { timeout: 10000 });
      const path = join(outDir, `${s.name}.png`);
      await page.screenshot({ path, omitBackground: !m.opaque });
      files.push(path);
    }
  } finally { await browser.close(); server.close(); }
  return files;
}
