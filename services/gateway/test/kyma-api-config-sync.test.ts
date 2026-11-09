/**
 * Kyma api_config ConfigMap Sync Test
 *
 * kyma/templates/configmaps/admin-api-config.yaml embeds a full copy of
 * api_config.json as a YAML block scalar and is mounted over
 * /app/services/admin/api_config.json in the Kyma admin deployment, so whatever
 * is embedded there IS the config a Kyma cluster runs with.
 *
 * It is a FOURTH copy that cli-tools/sync-api-config.js does not track (it can
 * only md5-match plain JSON files, not a re-indented YAML embedding), and it is
 * gitignored: `kyma/templates/configmaps/*.yaml` are local artifacts of the last
 * setup-kyma.js run. That combination is how a machine set up before the
 * six-group restructure of api_config.json kept an old-flat-shape ConfigMap on
 * disk that deploy-kyma.js would have applied verbatim.
 *
 * The durable fix is in deploy-kyma.js, which now re-renders the ConfigMap from
 * the repository's api_config.json right before applying it. This test guards
 * that renderer: it asserts the rendering round-trips to the canonical config,
 * and — when the local artifact exists — that the artifact is not stale.
 *
 * Lives here rather than under kyma/ because this repo's only Jest runner is
 * services/gateway's; see test/kyma-db-manager-commands.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderApiConfigMap } = require('../../../kyma/scripts/deploy-kyma.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CANONICAL_FILE = path.join(REPO_ROOT, 'services', 'gateway', 'api_config.json');
const ADMIN_FILE = path.join(REPO_ROOT, 'services', 'admin', 'api_config.json');
const CONFIGMAP_FILE = path.join(
  REPO_ROOT,
  'kyma',
  'templates',
  'configmaps',
  'admin-api-config.yaml'
);

/** The six top-level groups of the restructured api_config. */
const EXPECTED_GROUPS = [
  'capabilities',
  'hooks',
  'models',
  'observability',
  'platform',
  'providers',
];

/**
 * Reverse the renderer: pull the `api_config.json` block scalar back out of the
 * ConfigMap and undo its four-space indent.
 *
 * Deliberately not js-yaml: no YAML parser is a dependency of any service in
 * this repo (only kyma/scripts vendors one), and a block scalar under a known
 * key needs no parser.
 */
function extractEmbeddedConfig(yamlText: string): string {
  const lines = yamlText.split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === 'api_config.json: |');
  if (startIndex === -1) {
    throw new Error(
      'No "api_config.json: |" block found in the ConfigMap. ' +
        'If the key or the scalar style changed, update this test with it.'
    );
  }

  const body: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    // The block scalar ends at the first non-empty line not indented into it.
    if (line !== '' && !line.startsWith('    ')) break;
    body.push(line.startsWith('    ') ? line.slice(4) : line);
  }

  // Drop the trailing blank line the renderer's closing newline produces.
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return body.join('\n') + '\n';
}

describe('kyma admin-api-config ConfigMap rendering', () => {
  const canonicalText = fs.readFileSync(CANONICAL_FILE, 'utf8');

  it('renders from a source that is itself a synced copy of the canonical config', () => {
    // deploy-kyma.js renders from services/admin/api_config.json, the copy
    // cli-tools/sync-api-config.js keeps identical to the gateway's. If that
    // stops holding, the ConfigMap silently stops tracking the source of truth.
    expect(fs.readFileSync(ADMIN_FILE, 'utf8')).toBe(canonicalText);
  });

  it('embeds the canonical config byte-for-byte', () => {
    const rendered = renderApiConfigMap(canonicalText, 'sail-proxy');
    expect(extractEmbeddedConfig(rendered)).toBe(canonicalText);
  });

  it('embeds parseable JSON in the six-group shape, not the old flat sections', () => {
    const embedded = JSON.parse(extractEmbeddedConfig(renderApiConfigMap(canonicalText, 'sail-proxy')));
    expect(embedded).toEqual(JSON.parse(canonicalText));
    expect(Object.keys(embedded.api_config).sort()).toEqual(EXPECTED_GROUPS);
  });

  it('renders a ConfigMap named admin-api-config in the requested namespace', () => {
    // The admin deployment mounts the ConfigMap by this name; a rename here
    // would produce a valid YAML file that mounts nothing.
    const rendered = renderApiConfigMap(canonicalText, 'other-ns');
    expect(rendered).toContain('name: admin-api-config');
    expect(rendered).toContain('namespace: other-ns');
  });
});

describe('locally generated kyma api_config ConfigMap', () => {
  // kyma/templates/configmaps/*.yaml is gitignored, so this file exists only on
  // a machine that has run setup-kyma.js. When it does exist it is what
  // deploy-kyma.js would apply, so it must not be stale.
  const exists = fs.existsSync(CONFIGMAP_FILE);
  const maybeIt = exists ? it : it.skip;

  maybeIt('is not stale relative to the canonical api_config.json', () => {
    const embedded = extractEmbeddedConfig(fs.readFileSync(CONFIGMAP_FILE, 'utf8'));
    expect(JSON.parse(embedded)).toEqual(JSON.parse(fs.readFileSync(CANONICAL_FILE, 'utf8')));
  });
});
