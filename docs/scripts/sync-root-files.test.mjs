import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebaseLinks, themedSvg, cropSvg, DOCKER_PANEL, KYMA_PANEL } from './sync-root-files.mjs';

const GH = 'https://github.com/st-gr/sail-proxy/blob/main/';

test('relative markdown links in a root file become GitHub blob links', () => {
  const md = 'See [conduct](CODE_OF_CONDUCT.md) and [docs](docs/guide/faq.md#x) and [site](https://st-gr.github.io/sail-proxy/) and [abs](/LICENSE).';
  assert.equal(rebaseLinks(md), `See [conduct](${GH}CODE_OF_CONDUCT.md) and [docs](${GH}docs/guide/faq.md#x) and [site](https://st-gr.github.io/sail-proxy/) and [abs](${GH}LICENSE).`);
});

test('anchors-only, mailto and images are left alone', () => {
  const md = '[top](#top) [mail](mailto:a@b.c) ![logo](docs/assets/sail-proxy-logo.svg)';
  assert.equal(rebaseLinks(md), md);
});

test('themedSvg pins the diagram to one colour scheme, so the site toggle can pick it', () => {
  const svg = '<svg style="background-color: light-dark(#fff, #121212); color-scheme: light dark;" width="1"></svg>';
  assert.equal(themedSvg(svg, 'light'), '<svg style="background-color: light-dark(#fff, #121212); color-scheme: light;" width="1"></svg>');
  assert.equal(themedSvg(svg, 'dark'), '<svg style="background-color: light-dark(#fff, #121212); color-scheme: dark;" width="1"></svg>');
  assert.throws(() => themedSvg('<svg></svg>', 'dark'), /color-scheme: light dark/);
});

test('cropSvg sets the root viewBox, width and height to the box and changes nothing else', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" style="color-scheme: light;" width="1076px" height="824px" viewBox="0 0 1076 824"><rect x="531.5"/></svg>';
  assert.equal(cropSvg(svg, { x: 486, y: 260, width: 586, height: 282 }),
    '<svg xmlns="http://www.w3.org/2000/svg" style="color-scheme: light;" width="586px" height="282px" viewBox="486 260 586 282"><rect x="531.5"/></svg>');
});

test('cropSvg refuses an SVG whose root carries no viewBox', () => {
  assert.throws(() => cropSvg('<svg width="1px"></svg>', DOCKER_PANEL), /viewBox/);
});

test('the Docker panel box holds the panel rectangle of the master SVG with its pills', () => {
  // the panel's <rect x="531.5" y="266" width="500" height="270"> lies inside, with the SAP API pill (from x 491) and the REST pill (to x 1068)
  assert.ok(DOCKER_PANEL.x <= 490 && DOCKER_PANEL.x + DOCKER_PANEL.width >= 1070);
  assert.ok(DOCKER_PANEL.y <= 262 && DOCKER_PANEL.y + DOCKER_PANEL.height >= 540);
});

test('the Kyma panel box holds the Kyma panel rectangle of the master SVG with its pills', () => {
  // the panel's <rect x="530" y="556" width="500" height="262"> lies inside, with the SAP API pill (from x 491) and the REST pill (to x 1068)
  assert.ok(KYMA_PANEL.x <= 490 && KYMA_PANEL.x + KYMA_PANEL.width >= 1070);
  assert.ok(KYMA_PANEL.y <= 552 && KYMA_PANEL.y + KYMA_PANEL.height >= 820);
});
