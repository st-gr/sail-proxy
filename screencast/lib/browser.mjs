// Puppeteer helpers shared by the screenshot runner (plan 2) and the recorder (plan 3).
import puppeteer from 'puppeteer';

// userDataDir keeps a browser profile between runs (the recorder's own GitHub sign-in); without it every launch is fresh.
export const launchOptions = ({ width, height, headless = true, userDataDir }) => ({ headless, args: ['--no-sandbox', `--window-size=${width},${height}`], ...(userDataDir ? { userDataDir } : {}) });

export async function openBrowser({ width = 1440, height = 900, scale = 2, headless = true, userDataDir } = {}) {
  const browser = await puppeteer.launch(launchOptions({ width, height, headless, userDataDir }));
  const page = await browser.newPage();
  // A kept profile restores its earlier tabs: close them and bring this page to the front, since a background tab
  // skips CSS transitions (the caption's fade-in) and the recording would show no caption.
  if (userDataDir) { for (const p of await browser.pages()) if (p !== page) await p.close().catch(() => {}); await page.bringToFront(); }
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  return { browser, page };
}

export const goto = (page, url) => page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

const BUSY = '.sapUiLocalBusyIndicator, .sapMBusyIndicator, .sapUiBlockLayer, .sapUiBusy';
export async function settled(page, { timeout = 15000, interval = 250 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const st = await page.evaluate((busy) => {
      const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const core = window.sap && sap.ui && sap.ui.getCore && sap.ui.getCore();
      return {
        busy: Array.from(document.querySelectorAll(busy)).some(shown),
        ready: !!(core && (typeof core.isInitialized !== 'function' || core.isInitialized()))
      };
    }, BUSY).catch(() => ({ busy: true, ready: false }));
    if (!st.busy && st.ready) { await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {}); return; }
    if (Date.now() - t0 > timeout) throw new Error(`page not settled after ${timeout} ms (busy=${st.busy}, ready=${st.ready})`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Visible text hosts: UI5 navigation items, icon tab texts (both tab bar renderings), buttons, links, segmented buttons, titles and table cell texts.
const TEXT_HOSTS = [
  '.sapTntNLIText', '.sapMITBText', '.sapMITHTextContent', '.sapMBtnContent', 'button', 'ui5-button', '.sapMLnk', 'a',
  '.sapMSegBBtn', '.sapMText', '.sapMLabel', '.sapMTitle', '.sapMSLITitle', '.sapMSelectListItem', '.sapMObjectIdentifierTitle', '.sapMObjStatusText',
  '.sapMListTblCell span', '.sapUiTableCell span', 'td span', '[role="gridcell"] span'
].join(', ');

const NAV_TEXT = '.sapTntNLIText';

async function findVisibleText(page, hosts, text) {
  const handle = await page.evaluateHandle((h, t) => {
    const shown = (e) => {
      if (e.closest('[aria-hidden="true"]') && !e.closest('.sapMDialog')) return false;
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && (!e.checkVisibility || e.checkVisibility());
    };
    const hits = Array.from(document.querySelectorAll(h)).filter((e) => e.textContent.trim() === t && shown(e));
    // The innermost hits (containing no other hit); app content wins over the side navigation, so an
    // in-app tab called "Models" or "Files" is not mistaken for the navigation entry of the same name.
    const inner = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
    return inner.find((e) => !e.closest('.sapTntSideNavigation')) || inner[0] || null;
  }, hosts, text);
  const el = handle.asElement();
  if (!el) await handle.dispose();
  return el;
}

// The visible element whose text equals `text`. With `nav` (or a `group`) only side-navigation texts match;
// an item inside a collapsed group is reached by clicking the group's text first and looking again.
export async function findText(page, text, { group, nav = !!group } = {}) {
  const hosts = nav ? NAV_TEXT : TEXT_HOSTS;
  let el = await findVisibleText(page, hosts, text);
  if (!el && group) {
    const g = await findVisibleText(page, NAV_TEXT, group);
    if (g) { await g.click(); await g.dispose(); await new Promise((r) => setTimeout(r, 400)); }
    el = await findVisibleText(page, hosts, text);
  }
  return el;
}

export async function clickText(page, text, opts = {}) {
  const el = await findText(page, text, opts);
  if (!el) throw new Error(`no visible element with text "${text}"`);
  await el.click(); await el.dispose();
}

// The first visible element with the ARIA role (or the native tag that implies it) and, when given, the
// accessible name (aria-label, else the trimmed text).
export async function findRole(page, role, name) {
  const native = { button: 'button', link: 'a', textbox: 'input, textarea', checkbox: 'input[type="checkbox"]' }[role] ?? '';
  const handle = await page.evaluateHandle((r, n, nat) => {
    const shown = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const label = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim();
    const sel = `[role="${r}"]${nat ? ', ' + nat : ''}`;
    return Array.from(document.querySelectorAll(sel)).find((e) => shown(e) && (!n || label(e) === n)) || null;
  }, role, name ?? '', native);
  const el = handle.asElement();
  if (!el) await handle.dispose();
  return el;
}

export async function click(page, selector) {
  const el = await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await el.click(); await el.dispose();
}

export const type = (page, selector, text) => page.type(selector, text, { delay: 20 });
export const press = (page, key) => page.keyboard.press(key);
export const inject = (page, source) => page.evaluate(source);

export async function shot(page, { clip, selector, path, pad = 0 }) {
  if (selector) {
    const el = await page.waitForSelector(selector, { visible: true, timeout: 10000 });
    if (!pad) { await el.screenshot({ path }); await el.dispose(); return; }
    const b = await el.boundingBox(); await el.dispose();
    const vp = page.viewport();
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    await page.screenshot({ path, clip: { x, y, width: Math.min(vp.width - x, b.width + 2 * pad), height: Math.min(vp.height - y, b.height + 2 * pad) } });
    return;
  }
  await page.screenshot({ path, clip: clip === 'viewport' || !clip ? undefined : clip });
}
