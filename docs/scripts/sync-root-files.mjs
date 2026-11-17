// Copies the root files the site includes (CHANGELOG.md, CONTRIBUTING.md) into docs/.generated/ with
// their relative links rebased to GitHub, and the deployment diagram into docs/public/generated/ as a light and a
// dark copy (an SVG in an <img> follows the OS colour scheme, not the site's toggle, so the pages show the copy that
// matches the toggle), plus the diagram's Docker and Kyma panels cropped out of each for their deployment pages. All outputs are
// gitignored and regenerated before every dev and build.
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

// The Docker panel of the diagram in its user units: the panel's box (x 531.5, y 266, 500 × 270) with the "SAP API"
// pill on its left edge and the "REST" pill on its right.
export const DOCKER_PANEL = { x: 489, y: 260, width: 583, height: 282 };
// The Kyma panel (box x 530, y 556, 500 × 262), down to the drawing's bottom edge at 824.
export const KYMA_PANEL = { x: 489, y: 550, width: 583, height: 274 };

// The same drawing showing only `box`: the root <svg> tag's viewBox, width and height, nothing else.
export function cropSvg(svg, { x, y, width, height }) {
  const root = /<svg\b[^>]*>/.exec(svg);
  if (!root || !/\sviewBox="[^"]*"/.test(root[0])) throw new Error('the diagram SVG has no viewBox on its root');
  const tag = root[0]
    .replace(/\sviewBox="[^"]*"/, ` viewBox="${x} ${y} ${width} ${height}"`)
    .replace(/\swidth="[^"]*"/, ` width="${width}px"`)
    .replace(/\sheight="[^"]*"/, ` height="${height}px"`);
  return svg.slice(0, root.index) + tag + svg.slice(root.index + root[0].length);
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
  for (const scheme of ['light', 'dark']) {
    writeFileSync(join(pub, `deployment-options-${scheme}.svg`), themedSvg(svg, scheme));
    writeFileSync(join(pub, `docker-panel-${scheme}.svg`), cropSvg(themedSvg(svg, scheme), DOCKER_PANEL));
    writeFileSync(join(pub, `kyma-panel-${scheme}.svg`), cropSvg(themedSvg(svg, scheme), KYMA_PANEL));
  }
  return ['CHANGELOG.md', 'CONTRIBUTING.md', 'deployment-options-light.svg', 'deployment-options-dark.svg', 'docker-panel-light.svg', 'docker-panel-dark.svg', 'kyma-panel-light.svg', 'kyma-panel-dark.svg'];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`synced ${syncRootFiles(join(docsRoot, '..'), docsRoot).join(', ')}`);
}
