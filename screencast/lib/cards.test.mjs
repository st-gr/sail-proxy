import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardModel, DURATION, SITE, REPO } from './cards.mjs';

const meta = { title: 'Deploy with Docker Compose', subtitle: 'Five services on one host', kicker: 'sail-proxy · deploy', next: 'Deploy on SAP BTP Kyma',
  sections: [{ n: 1, title: 'What you get', outcome: 'The services' }, { n: 2, title: 'Set up', outcome: 'The setup script' }] };

test('the intro card carries kicker, title, subtitle, site and version for five seconds', () => {
  const m = cardModel(meta, 'intro', { version: '0.10.0', logo: 'file:///logo.svg' });
  assert.equal(m.kind, 'intro'); assert.equal(m.title, 'Deploy with Docker Compose'); assert.equal(m.version, 'v0.10.0');
  assert.equal(m.site, SITE); assert.equal(m.logo, 'file:///logo.svg'); assert.equal(m.seconds, DURATION.intro);
});

test('a section card numbers itself out of the total and lasts three seconds', () => {
  const m = cardModel(meta, 'section', { n: 2 });
  assert.deepEqual([m.n, m.total, m.sectionTitle, m.outcome, m.seconds], [2, 2, 'Set up', 'The setup script', 3]);
  assert.throws(() => cardModel(meta, 'section', { n: 3 }), /no section 3/);
});

test('the outro lists docs, code and next, and lasts eight seconds plus the recap', () => {
  const m = cardModel(meta, 'outro', { recapSeconds: 12.4, logo: 'l' });
  assert.deepEqual(m.lines, [['Docs', SITE], ['Code', REPO], ['Next', 'Deploy on SAP BTP Kyma']]);
  assert.equal(m.seconds, 20.4); assert.ok(m.fine.includes('AGPL-3.0'));
});
