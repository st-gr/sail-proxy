import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebaseLinks, themedSvg } from './sync-root-files.mjs';

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
