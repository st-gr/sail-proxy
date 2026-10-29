// Copies the root files the site includes (CHANGELOG.md, CONTRIBUTING.md) into docs/.generated/ with
// their relative links rebased to GitHub, and the deployment diagram into docs/public/generated/ as a light and a
// dark copy (an SVG in an <img> follows the OS colour scheme, not the site's toggle, so the pages show the copy that
// matches the toggle). All outputs are gitignored and regenerated before every dev and build.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITHUB_BLOB = 'https://github.com/st-gr/sail-proxy/blob/main/';
// [text](target) where target has no scheme, is not an anchor and is not an image (no "!" before "[")
const LINK = /(^|[^!])\[([^\]]*)\]\(((?![a-z]+:)(?!#)[^)\s]+)\)/g;

export function rebaseLinks(markdown) {
  return markdown.replace(LINK, (m, pre, text, target) => `${pre}[${text}](${GITHUB_BLOB}${target.replace(/^\//, '')})`);
}

// The draw.io export themes itself with light-dark() under `color-scheme: light dark`; pinning the scheme picks one.
export function themedSvg(svg, scheme) {
  if (!svg.includes('color-scheme: light dark')) throw new Error('the diagram SVG no longer carries color-scheme: light dark');
  return svg.replace('color-scheme: light dark', `color-scheme: ${scheme}`);
}

export function syncRootFiles(repoRoot, docsRoot) {
  const gen = join(docsRoot, '.generated');
  mkdirSync(gen, { recursive: true });
  for (const name of ['CHANGELOG.md', 'CONTRIBUTING.md']) {
    writeFileSync(join(gen, name), rebaseLinks(readFileSync(join(repoRoot, name), 'utf8')));
  }
  const pub = join(docsRoot, 'public', 'generated');
  mkdirSync(pub, { recursive: true });
  const svg = readFileSync(join(docsRoot, 'assets', 'sail-proxy-deployment-options.svg'), 'utf8');
  for (const scheme of ['light', 'dark']) writeFileSync(join(pub, `deployment-options-${scheme}.svg`), themedSvg(svg, scheme));
  return ['CHANGELOG.md', 'CONTRIBUTING.md', 'deployment-options-light.svg', 'deployment-options-dark.svg'];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`synced ${syncRootFiles(join(docsRoot, '..'), docsRoot).join(', ')}`);
}
