import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelector, resolve, createSteps, PACE } from './steps.mjs';

test('parseSelector tells text, nav, role and css apart', () => {
  assert.deepEqual(parseSelector('text=API Keys'), { kind: 'text', value: 'API Keys' });
  assert.deepEqual(parseSelector('nav=API Keys > Access'), { kind: 'nav', value: 'API Keys', group: 'Access' });
  assert.deepEqual(parseSelector('nav=Usage'), { kind: 'nav', value: 'Usage', group: undefined });
  assert.deepEqual(parseSelector('role=button:Create'), { kind: 'role', value: 'button', name: 'Create' });
  assert.deepEqual(parseSelector('#login'), { kind: 'css', value: '#login' });
  assert.throws(() => parseSelector(''), /selector/);
});

// A page whose selectors all resolve (or none, with found=false), a clock that adds up the sleeps.
function fakePage({ found = true } = {}) {
  const calls = [];
  const handle = { hover: async () => calls.push('hover'), click: async () => calls.push('click'), dispose: async () => {} };
  return {
    calls,
    page: {
      goto: async (url) => calls.push(`goto ${url}`),
      evaluate: async () => ({ busy: false, ready: true }),
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => (found ? handle : null),
      evaluateHandle: async () => ({ asElement: () => (found ? handle : null), dispose: async () => {} }),
      keyboard: { type: async (t, o) => calls.push(`type ${t} ${o.delay}`), press: async (k) => calls.push(`press ${k}`) },
      waitForFunction: async () => {}
    }
  };
}

test('actions before section(1) are refused and sections must ascend by one', async () => {
  const { page } = fakePage();
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 2, castSeconds: () => 1, castUrl: () => 'u' });
  await assert.rejects(() => api.goto('/x'), /before section\(1\)/);
  await api.section(1);
  await assert.rejects(() => api.section(3), /section\(3\) after section\(1\)/);
});

test('a click costs at least the pacing waits and typing is slowed per character', async () => {
  const { page, calls } = fakePage(); let slept = 0; const events = [];
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 1, castUrl: () => 'u', on: (e) => events.push(e.event), sleep: async (ms) => { slept += ms; } });
  await api.section(1); await api.click('text=Create'); await api.type('#name', 'abc');
  assert.ok(slept >= PACE.beforeClick + PACE.afterClick + PACE.beforeClick + PACE.afterType, `slept ${slept}`);
  assert.ok(calls.includes('type abc 40'));
  assert.deepEqual(events, ['section', 'click', 'type']);
});

test('a dry run collects every miss and goes on; a recording stops at the first', async () => {
  const dry = fakePage({ found: false });
  const d = createSteps({ page: dry.page, base: 'http://b', video: 'v', total: 1, castSeconds: () => null, castUrl: () => 'u', dryRun: true, sleep: async () => {} });
  await d.api.section(1); await d.api.click('text=Nope'); await d.api.type('#x', 'y'); await d.api.cast('missing');
  assert.deepEqual(d.misses(), ['click(text=Nope) in section 1', 'type(#x) in section 1', 'cast(missing) in section 1: no videos/v/casts/missing.cast']);
  const live = fakePage({ found: false });
  const l = createSteps({ page: live.page, base: 'http://b', video: 'v', total: 1, castSeconds: () => null, castUrl: () => 'u', sleep: async () => {} });
  await l.api.section(1);
  await assert.rejects(() => l.api.click('text=Nope'), /no visible element for text=Nope/);
});

test('cast() plays the cast page and reports its length', async () => {
  const { page, calls } = fakePage(); const events = [];
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: (n) => (n === 'up' ? 12.5 : null), castUrl: (n) => `http://c/${n}`, on: (e) => events.push(e), sleep: async () => {} });
  await api.section(1); await api.cast('up');
  assert.ok(calls.includes('goto http://c/up'));
  assert.deepEqual(events[1], { event: 'cast', name: 'up', seconds: 12.5 });
});

test('play() plays a video clip on the clip page and reports it on the timeline like a cast', async () => {
  const { page, calls } = fakePage(); const events = [];
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => null, castUrl: () => 'u', clipSeconds: (n) => (n === 'key' ? 8 : null), clipUrl: (n) => `http://c/clip/${n}`, on: (e) => events.push(e), sleep: async () => {} });
  await api.section(1); await api.play('key');
  assert.ok(calls.includes('goto http://c/clip/key'));
  assert.deepEqual(events.slice(1).map((e) => e.event), ['cast', 'cast-end']);
  assert.deepEqual(events[1], { event: 'cast', name: 'key', seconds: 8 });
  const dry = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => null, castUrl: () => 'u', dryRun: true, sleep: async () => {} });
  await dry.api.section(1); await dry.api.play('gone');
  assert.deepEqual(dry.misses(), ['play(gone) in section 1: no videos/v/clips/gone.webm']);
});

test('scroll() wheels over the content in small steps and reports the distance', async () => {
  const { page, calls } = fakePage(); const events = [];
  page.mouse = { move: async (x, y) => calls.push(`move ${x} ${y}`), wheel: async ({ deltaY }) => calls.push(`wheel ${deltaY}`) };
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 1, castUrl: () => 'u', on: (e) => events.push(e), sleep: async () => {} });
  await api.section(1); await api.scroll(600, { ms: 2000 });
  const wheels = calls.filter((c) => c.startsWith('wheel '));
  assert.equal(calls.find((c) => c.startsWith('move ')), 'move 1100 600');
  assert.equal(wheels.length, 20);
  assert.equal(wheels.reduce((n, c) => n + Number(c.slice(6)), 0), 600);
  assert.deepEqual(events[1], { event: 'scroll', deltaY: 600 });
});

test('scroll() stops wheeling at the end of the scroll container but keeps its duration', async () => {
  const { page, calls } = fakePage(); let room = 100; let slept = 0;
  page.evaluate = async () => room;
  page.mouse = { move: async () => {}, wheel: async ({ deltaY }) => { calls.push(`wheel ${deltaY}`); room = Math.max(0, room - deltaY); } };
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 1, castUrl: () => 'u', sleep: async (ms) => { slept += ms; } });
  await api.section(1); slept = 0; await api.scroll(600, { ms: 2000 });
  assert.equal(calls.filter((c) => c.startsWith('wheel ')).length, 4);
  assert.ok(slept >= 2000);
});

test('a caption is shown again when the app reloads the page itself, but not after goto', async () => {
  const { page } = fakePage(); const shown = []; const handlers = {};
  page.on = (event, fn) => { handlers[event] = fn; };
  page.evaluate = async (fn, text) => { if (text === 'In German') shown.push(text); return { busy: false, ready: true }; };
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 1, castUrl: () => 'u', sleep: async () => {} });
  await api.section(1); await api.caption('In German');
  await handlers.load(); assert.deepEqual(shown, ['In German', 'In German']);
  await api.goto('/x'); await handlers.load(); assert.deepEqual(shown, ['In German', 'In German']);
});

test('hold() reports before it waits, so the logged time is where the held picture starts', async () => {
  const { page } = fakePage(); const log = [];
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 1, castUrl: () => 'u', on: (e) => log.push(e.event), sleep: async (ms) => log.push(`sleep ${ms}`) });
  await api.section(1); await api.hold(1500);
  assert.deepEqual(log, ['section', 'hold', 'sleep 1500']);
});

test('a step file for one later section starts its count there', async () => {
  const { page } = fakePage();
  const mk = () => createSteps({ page, base: 'http://b', video: 'v', total: 6, firstSection: 5, castSeconds: () => 1, castUrl: () => 'u', sleep: async () => {} }).api;
  await mk().section(5);
  await assert.rejects(mk().section(1), /section\(1\) after section\(4\)/);
});

test('a click on a page without UI5 does not wait for UI5 to settle', async () => {
  const { page } = fakePage(); let settledCalls = 0;
  page.evaluate = async (fn) => { if (String(fn).includes('window.sap && window.sap.ui)')) return false; settledCalls++; return { busy: false, ready: false }; };
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 1, castUrl: () => 'u', sleep: async () => {} });
  await api.section(1); await api.click('#x');
  assert.equal(settledCalls, 0);
});

test('goto runs settled() only on a page with UI5, and just pauses on a plain page', async () => {
  const run = async (ui5) => {
    let settledCalls = 0; const slept = [];
    const page = {
      goto: async () => {},
      evaluate: async (fn) => { if (String(fn).includes('window.sap && window.sap.ui)')) return ui5; settledCalls++; return { busy: false, ready: true }; },
      waitForNetworkIdle: async () => {}
    };
    const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 1, castUrl: () => 'u', sleep: async (ms) => { slept.push(ms); } });
    await api.section(1); await api.goto('/x');
    return { settledCalls, slept };
  };
  const ui5 = await run(true); const plain = await run(false);
  assert.ok(ui5.settledCalls > 0 && !ui5.slept.includes(300));
  assert.equal(plain.settledCalls, 0);
  assert.ok(plain.slept.includes(300));
});

test('resolve maps nav= to the side navigation only and text= to app content first', async () => {
  const hosts = [];
  const page = { evaluateHandle: async (fn, h) => { hosts.push(h); return { asElement: () => null, dispose: async () => {} }; } };
  const o = { sleep: async () => {}, timeout: 0 };
  await resolve(page, 'text=Usage', o); await resolve(page, 'nav=Usage', o); await resolve(page, 'nav=Usage > Analytics', o);
  assert.ok(hosts[0].includes('.sapMBtnContent'));
  assert.equal(hosts[1], '.sapTntNLIText');
  assert.equal(hosts[2], '.sapTntNLIText');
});

test('resolve looks again every interval until the element appears, then gives up', async () => {
  let looks = 0; const slept = [];
  const el = { dispose: async () => {} };
  const page = { evaluateHandle: async () => { looks++; return { asElement: () => (looks >= 3 ? el : null), dispose: async () => {} }; } };
  const sleep = async (ms) => { slept.push(ms); };
  assert.equal(await resolve(page, 'role=button:Go', { sleep }), el);
  assert.equal(looks, 3); assert.deepEqual(slept, [250, 250]);
  looks = -1000; slept.length = 0;
  assert.equal(await resolve(page, 'text=Never', { sleep, timeout: 1000 }), null);
  assert.equal(slept.length, 4);
});

test('cast() takes its timing mark when the player reports playing, then waits for the end', async () => {
  const order = []; let title = 'cast';
  const page = {
    goto: async () => { title = 'cast'; order.push('goto'); },
    evaluate: async () => false,
    // a fake player: the first wait sees the title turn to playing, the second sees it end
    waitForFunction: async (fn) => {
      title = title === 'cast' ? 'playing' : 'ended'; order.push(`title ${title}`);
      globalThis.document = { title }; try { assert.ok(fn()); } finally { delete globalThis.document; }
    }
  };
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 3, castUrl: () => 'http://c/up', on: (e) => order.push(`event ${e.event}`), sleep: async () => {} });
  await api.section(1); await api.cast('up');
  assert.deepEqual(order, ['event section', 'goto', 'title playing', 'event cast', 'title ended', 'event cast-end']);
  const warned = []; const silent = { ...page, waitForFunction: async (fn, o) => { if (o.timeout === 10000) throw new Error('timeout'); } };
  const s2 = createSteps({ page: silent, base: 'http://b', video: 'v', total: 1, castSeconds: () => 3, castUrl: () => 'u', on: () => {}, warn: (m) => warned.push(m), sleep: async () => {} });
  await s2.api.section(1); await s2.api.cast('up');
  assert.match(warned[0], /cast up: the player did not report playing within 10 s/);
});

test('end() closes the clip: the steps after it still run but report nothing, and no section follows', async () => {
  const { page, calls } = fakePage(); const events = [];
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 2, castSeconds: () => 1, castUrl: () => 'u', on: (e) => events.push(e.event), sleep: async () => {} });
  await api.section(1); await api.caption('x'); await api.end();
  await api.goto('/clean'); await api.click('text=Delete'); await api.mark('gone'); await api.caption('y');
  assert.deepEqual(events, ['section', 'caption', 'end']);
  assert.ok(calls.includes('goto http://b/clean') && calls.includes('click'), 'the clean-up steps ran');
  await assert.rejects(api.section(2), /after end\(\)/);
});

test('until waits for an element for as long as asked, and fails the take when it never comes', async () => {
  const { page } = fakePage(); const timeouts = [];
  page.waitForSelector = async (s, o) => { timeouts.push(o.timeout); return { dispose: async () => {} }; };
  const { api } = createSteps({ page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 1, castUrl: () => 'u', sleep: async () => {} });
  await api.section(1); await api.until('::-p-text(View Result)', { timeoutMs: 150000 });
  assert.deepEqual(timeouts, [150000]);
  const none = fakePage({ found: false });
  const s2 = createSteps({ page: none.page, base: 'http://b', video: 'v', total: 1, castSeconds: () => 1, castUrl: () => 'u', sleep: async () => {} });
  await s2.api.section(1);
  await assert.rejects(() => s2.api.until('#late', { timeoutMs: 10 }), /#late did not appear within/);
});
