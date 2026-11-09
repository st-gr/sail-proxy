import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settled } from './browser.mjs';
import { shots } from '../shots.manifest.mjs';

function fakePage(answers) {
  let i = 0;
  return { evaluate: async () => answers[Math.min(i++, answers.length - 1)], waitForNetworkIdle: async () => {} };
}

test('settled resolves once the page reports no busy indicator and an initialized core', async () => {
  const page = fakePage([{ busy: true, ready: false }, { busy: true, ready: true }, { busy: false, ready: true }]);
  const t0 = Date.now(); await settled(page, { timeout: 5000, interval: 10 });
  assert.ok(Date.now() - t0 < 2000);
});

test('settled rejects after the timeout', async () => {
  await assert.rejects(settled(fakePage([{ busy: true, ready: true }]), { timeout: 60, interval: 10 }), /not settled/);
});

test('every manifest entry has a unique id, a section, an identity, a theme, steps and alt text', () => {
  const ids = new Set();
  for (const s of shots) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`); ids.add(s.id);
    assert.ok(['cockpit', 'deploy', 'home', 'clients'].includes(s.section), s.id);
    assert.ok(['admin', 'user', 'none'].includes(s.identity), s.id);
    assert.ok(['sap_horizon', 'sap_horizon_dark', null].includes(s.theme), s.id);
    assert.ok(Array.isArray(s.steps), s.id); assert.ok(s.alt && s.alt.length > 10, s.id);
  }
  assert.ok(shots.length >= 24);
});

import { findText } from './browser.mjs';

test('findText searches navigation texts only with nav or group, app content first otherwise', async () => {
  const hosts = [];
  const page = { evaluateHandle: async (fn, h) => { hosts.push(h); return { asElement: () => null, dispose: async () => {} }; } };
  await findText(page, 'Usage');
  await findText(page, 'Usage', { nav: true });
  await findText(page, 'Usage', { group: 'Analytics' });
  assert.ok(hosts[0].includes('.sapMBtnContent'));
  assert.equal(hosts[1], '.sapTntNLIText');
  assert.equal(hosts[2], '.sapTntNLIText');
});

test('launchOptions keeps a persistent profile only when one is given', async () => {
  const { launchOptions } = await import('./browser.mjs');
  assert.equal(launchOptions({ width: 10, height: 20 }).userDataDir, undefined);
  assert.equal(launchOptions({ width: 10, height: 20, userDataDir: '/p' }).userDataDir, '/p');
  assert.ok(launchOptions({ width: 10, height: 20 }).args.includes('--window-size=10,20'));
});
