// Intro, section and outro cards rendered from the video's front matter: the model is pure (tested), the
// renderer loads lib/cards/cards.html through the cast server (a file:// page may not load fonts), starts the
// CSS animation together with page.screencast() and transcodes each card to a clip of its exact length.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from './browser.mjs';
import { ROOT, CAST_PORT, startCastServer, transcode, probeSeconds } from './record.mjs';
import { DURATION } from './timeline.mjs';
import { encodeFor, sizedFile, cardViewport } from './size.mjs';

export { DURATION };
export const SITE = 'st-gr.github.io/sail-proxy';
export const REPO = 'github.com/st-gr/sail-proxy';
export const FINE = 'AGPL-3.0 · Not developed by or endorsed by SAP SE. SAP, SAP AI Core and SAP BTP are trademarks of SAP SE.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cardModel(meta, kind, { n, version, recapSeconds = 0, logo } = {}) {
  if (kind === 'intro') return { kind, kicker: meta.kicker, title: meta.title, subtitle: meta.subtitle, site: SITE, version: `v${version}`, logo, seconds: DURATION.intro };
  if (kind === 'section') {
    const s = meta.sections.find((x) => x.n === n);
    if (!s) throw new Error(`no section ${n}`);
    return { kind, n, total: meta.sections.length, sectionTitle: s.title, outcome: s.outcome, seconds: DURATION.section };
  }
  return { kind: 'outro', lines: [['Docs', SITE], ['Code', REPO], ['Next', meta.next]], fine: FINE, logo, seconds: Math.round((DURATION.outro + recapSeconds) * 10) / 10 };
}

// size '1440p' draws the same cards into out/<video>/cards-1440p/ at 2560×1440 (the layout zoomed by 4/3).
export async function renderCards({ video, meta, version, recapSeconds = 0, size = '1080p', log = () => {} }) {
  const dirName = sizedFile('cards/x', size).split('/')[0];
  const out = join(ROOT, 'out', video, dirName);
  const view = cardViewport(size);
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const logo = '/assets/sail-proxy-logo.svg';
  const url = `http://127.0.0.1:${CAST_PORT}/cards/cards.html`;
  const models = [cardModel(meta, 'intro', { version, logo }), ...meta.sections.map((s) => cardModel(meta, 'section', { n: s.n })), cardModel(meta, 'outro', { recapSeconds, logo })];
  const server = await startCastServer(video);
  const { browser, page } = await openBrowser({ width: view.width, height: view.height, scale: 1 });
  const done = [];
  try {
    for (const m of models) {
      const name = m.kind === 'section' ? `section-${m.n}` : m.kind;
      await page.goto(url, { waitUntil: 'load' });
      if (view.zoom !== 1) await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, view.zoom);
      await page.evaluate((model) => window.__render(model), m);
      await page.waitForFunction(() => document.title === 'rendered', { timeout: 10000 });
      const webm = join(out, `${name}.webm`);
      const rec = await page.screencast({ path: webm, fps: 30 });
      await page.evaluate(() => document.body.classList.add('play'));
      await sleep(m.seconds * 1000 + 300);
      await rec.stop();
      const mp4 = join(out, `${name}.mp4`);
      transcode(webm, mp4, ['-t', String(m.seconds)], [], encodeFor(size)); rmSync(webm);
      done.push({ name, file: `${dirName}/${name}.mp4`, seconds: probeSeconds(mp4) }); log(`card ${name}: ${m.seconds} s`);
    }
  } finally { await browser.close(); server.close(); }
  writeFileSync(join(out, '..', `${dirName}.json`), JSON.stringify(done, null, 2) + '\n');
  return done;
}
