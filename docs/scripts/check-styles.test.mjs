import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleProblems } from './check-styles.mjs';

const site = '<link rel="preload stylesheet" href="/sail-proxy/assets/style.ntJZ6HW_.css" as="style">';
const swagger = '<link rel="preload stylesheet" href="/sail-proxy/assets/swagger-ui.DIS4uyGR.css" as="style">';

test('a page that links the site stylesheet passes', () => {
  assert.deepEqual(styleProblems({ 'index.html': site, 'reference/api.html': `${site}${swagger}` }), []);
});

test('a page without the site stylesheet fails', () => {
  assert.deepEqual(styleProblems({ 'index.html': swagger }), ['index.html: does not link the site stylesheet', "index.html: links Swagger UI's stylesheet"]);
});

test("only the API reference page may link Swagger UI's stylesheet", () => {
  assert.deepEqual(styleProblems({ 'guide/videos.html': `${site}${swagger}` }), ["guide/videos.html: links Swagger UI's stylesheet"]);
});
