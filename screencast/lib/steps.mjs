// The step DSL handed to videos/<v>/steps.js. Pacing is built in (a viewer must see the pointer arrive, the
// click land and the result), selectors are UI5-aware, every action is reported to the recorder through
// `on`, and a dry run collects every selector that did not resolve instead of stopping at the first.
import { goto as pageGoto, settled, findText, findRole } from './browser.mjs';

export const PACE = { beforeClick: 1000, afterClick: 1500, afterType: 1000, perChar: 40, hover: 4000, afterGoto: 800, afterPress: 600 };

export function parseSelector(sel) {
  if (typeof sel !== 'string' || !sel) throw new Error(`selector must be a non-empty string, got ${JSON.stringify(sel)}`);
  if (sel.startsWith('text=')) return { kind: 'text', value: sel.slice(5) };
  if (sel.startsWith('nav=')) { const [value, group] = sel.slice(4).split('>').map((s) => s.trim()); return { kind: 'nav', value, group }; }
  if (sel.startsWith('role=')) {
    const m = /^role=([a-z]+)(?::(.+))?$/.exec(sel);
    if (!m) throw new Error(`bad role selector ${sel}`);
    return { kind: 'role', value: m[1], name: m[2] };
  }
  return { kind: 'css', value: sel };
}

// text=, nav= and role= selectors are looked up again every `interval` ms for up to `timeout` ms (a view may still
// be rendering); a css selector waits through waitForSelector.
export async function resolve(page, sel, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeout = 5000, interval = 250 } = {}) {
  const s = parseSelector(sel);
  if (s.kind === 'css') return page.waitForSelector(s.value, { visible: true, timeout }).catch(() => null);
  const look = () => {
    if (s.kind === 'text') return findText(page, s.value);
    if (s.kind === 'nav') return findText(page, s.value, { group: s.group, nav: true });
    return findRole(page, s.value, s.name);
  };
  for (let i = 0, n = Math.ceil(timeout / interval); ; i++) {
    const el = await look();
    if (el || i >= n) return el;
    await sleep(interval);
  }
}

// In the page: the pixels the nearest scrollable ancestor of the point can still move in direction dir.
function scrollRoom(x, y, dir) {
  let el = document.elementFromPoint(x, y);
  while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  el = el || document.scrollingElement;
  return dir < 0 ? el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop;
}

export function createSteps({ page, base, video, total, castSeconds, castUrl, clipSeconds = () => null, clipUrl = () => null, dryRun = false, firstSection = 1, on: report = () => {}, warn = (m) => console.warn(m), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let section = firstSection - 1; const misses = []; let steps = 0; let ended = false;
  // After end() the steps still run (clean-up off camera) but report nothing: no clip, no timing, no check.
  const on = (e) => (ended ? undefined : report(e));
  const need = (fn) => { if (!section) throw new Error(`${fn}() before section(1)`); };
  const find = async (sel, fn) => {
    const h = await resolve(page, sel, { sleep });
    if (!h) { misses.push(`${fn}(${sel}) in section ${section}`); if (dryRun) return null; throw new Error(`no visible element for ${sel}`); }
    return h;
  };
  // Waits for UI5 only on a page that has it: elsewhere (GitHub, Dex) settled() would sit out its whole timeout.
  const hasUi5 = () => page.evaluate(() => !!(window.sap && window.sap.ui)).catch(() => false);
  const quiet = async () => { if (await hasUi5()) await settled(page, { timeout: 10000 }).catch(() => {}); else await sleep(300); };
  // The caption of the current screen; a page the app reloads itself (a language change) gets it again on load.
  let shown = null;
  const showCaption = ({ text, opts }) => page.evaluate((t, o) => { if (window.__sailCaption) window.__sailCaption(t, o); }, text, opts).catch(() => {});
  page.on?.('load', () => (shown ? showCaption(shown) : undefined));
  // Plays a cast or a clip page: the timing mark is its first visible frame (the page's `playing`), not the navigation.
  const playPage = async (name, seconds, url, miss) => {
    if (seconds == null) { misses.push(miss); if (dryRun) return; throw new Error(`nothing to play for ${name}`); }
    if (dryRun) { await on({ event: 'cast', name, seconds }); return; }
    await pageGoto(page, url());
    const playing = await page.waitForFunction(() => document.title === 'playing' || document.title === 'ended', { timeout: 10000 }).then(() => true, () => false);
    if (!playing) warn(`cast ${name}: the player did not report playing within 10 s; timing mark taken now`);
    await on({ event: 'cast', name, seconds });
    await page.waitForFunction(() => document.title === 'ended', { timeout: (seconds + 20) * 1000 });
    await on({ event: 'cast-end', name });
    await sleep(1000);
  };
  const api = {
    async section(n) {
      if (ended) throw new Error(`section(${n}) after end(): nothing after end() is recorded`);
      if (n !== section + 1) throw new Error(`section(${n}) after section(${section}): sections are numbered 1, 2, 3… in order`);
      section = n; steps++; await on({ event: 'section', n });
    },
    async goto(path) {
      need('goto'); steps++; shown = null;
      await pageGoto(page, /^https?:/.test(path) ? path : base + path);
      // settled() waits for the UI5 core; a page without UI5 (the cast page, the docs site) has the navigation's own idle wait.
      if (await hasUi5()) await settled(page, { timeout: 20000 }).catch(() => {});
      else await sleep(300);
      await sleep(PACE.afterGoto); await on({ event: 'goto', path });
    },
    async click(sel) {
      need('click'); steps++;
      const h = await find(sel, 'click'); if (!h) return;
      await h.hover(); await sleep(PACE.beforeClick); await h.click(); await h.dispose();
      await quiet(); await sleep(PACE.afterClick); await on({ event: 'click', sel });
    },
    async type(sel, text) {
      need('type'); steps++;
      const h = await find(sel, 'type'); if (!h) return;
      await h.hover(); await sleep(PACE.beforeClick); await h.click(); await h.dispose();
      await page.keyboard.type(text, { delay: PACE.perChar });
      await sleep(PACE.afterType); await on({ event: 'type', sel });
    },
    async hover(sel) {
      need('hover'); steps++;
      const h = await find(sel, 'hover'); if (!h) return;
      await h.hover(); await h.dispose(); await sleep(PACE.hover); await on({ event: 'hover', sel });
    },
    // Wheels the page under the pointer (x, y: over the content, right of the cockpit's navigation) by deltaY
    // pixels in steps of 100 ms, so the viewer sees it move; negative scrolls up. Wheeling stops where the
    // scroll container under the pointer ends (more wheels there make a UI5 page bounce), the time still passes.
    async scroll(deltaY, { ms = 2000, x = 1100, y = 600 } = {}) {
      need('scroll'); steps++;
      const n = Math.max(1, Math.round(ms / 100));
      await page.mouse.move(x, y);
      for (let i = 0; i < n; i++) {
        const room = await page.evaluate(scrollRoom, x, y, Math.sign(deltaY)).catch(() => null);
        if (typeof room !== 'number' || room >= 1) await page.mouse.wheel({ deltaY: deltaY / n });
        await sleep(100);
      }
      await sleep(PACE.afterPress); await on({ event: 'scroll', deltaY });
    },
    async press(key) { need('press'); steps++; await page.keyboard.press(key); await quiet(); await sleep(PACE.afterPress); await on({ event: 'press', key }); },
    // Waits until an element shows (a slow model's answer, a generated image) instead of guessing a fixed wait; the idle
    // stretch is shortened in assembly. In a dry run a missing element is listed like a missing click target.
    async until(sel, { timeoutMs = 60000 } = {}) {
      need('until'); steps++;
      const h = await resolve(page, sel, { sleep, timeout: timeoutMs });
      if (!h) { misses.push(`until(${sel}) in section ${section}`); if (!dryRun) throw new Error(`${sel} did not appear within ${timeoutMs / 1000} s`); }
      await h?.dispose?.(); await on({ event: 'until', sel });
    },
    async wait(ms) { need('wait'); steps++; await sleep(ms); await on({ event: 'wait', ms }); },
    // A wait the assembler keeps although nothing moves and nobody speaks: a result the viewer should read.
    async hold(ms) { need('hold'); steps++; await on({ event: 'hold', ms }); await sleep(ms); },
    async mark(label) { need('mark'); await on({ event: 'mark', label }); },
    async caption(text) {
      need('caption'); steps++; shown = { text, opts: { step: section, total } };
      await showCaption(shown);
      await on({ event: 'caption', text });
    },
    async cast(name) {
      need('cast'); steps++;
      await playPage(name, castSeconds(name), () => castUrl(name), `cast(${name}) in section ${section}: no videos/${video}/casts/${name}.cast`);
    },
    // A recorded video clip (videos/<v>/clips/<name>.webm) in the same frame; on the timeline it counts as a cast.
    async play(name, { title = name } = {}) {
      need('play'); steps++;
      await playPage(name, clipSeconds(name), () => clipUrl(name, title), `play(${name}) in section ${section}: no videos/${video}/clips/${name}.webm`);
    },
    // Closes the running clip (with its redaction check); the steps after it run off camera.
    async end() {
      need('end'); steps++;
      await on({ event: 'end' }); ended = true;
    }
  };
  return { api, misses: () => misses.slice(), section: () => section, steps: () => steps };
}
