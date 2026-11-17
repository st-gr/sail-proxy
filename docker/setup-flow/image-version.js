'use strict';
/**
 * The image version question of setup-docker.js (registry mode), the counterpart of
 * setup-kyma.js's selectImageVersion: the released versions of sail-proxy-gateway the registry
 * lists, newest first, plus "Enter custom version..."; a typed version when the registry cannot be
 * listed. The rules for a typed tag are setup-kyma.js's (validateCustomTag).
 *
 * Without a login: setup-docker.js asks for none (docker pull uses the machine's own), so a private
 * registry is not listed and the version is typed. Digests are not fetched: compose pulls by tag.
 *
 * Every registry call goes through `request(url, options)`, which resolves to the body of a 2xx
 * answer and rejects otherwise, with the HTTP status as error.statusCode when there was one.
 */

const IMAGE = 'sail-proxy-gateway';
const LISTING_PAGE_SIZE = 100;
const CUSTOM = 'custom';
const MANIFEST_TYPES = 'application/vnd.docker.distribution.manifest.v2+json, ' +
  'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json';

const isValidSemver = (version) => /^\d+\.\d+\.\d+$/.test(String(version).replace(/^v/, ''));

/** A valid Docker image tag: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}. */
const isValidDockerTag = (tag) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(String(tag));

/** Negative when a < b, 0 when equal, positive when a > b. */
function compareSemver(a, b) {
  const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n || 0, 10));
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * Where the registry APIs live. Images are named registry/organization/name, and the registry
 * answer may carry a path ("ghcr.io/st-gr" with organization "sail-proxy-private"): the APIs then
 * live at the host alone, with the path as the start of the repository namespace.
 */
function registryApiTarget({ registry, organization }) {
  const [host, ...rest] = String(registry).split('/').filter(Boolean);
  const namespace = [...rest, ...String(organization || '').split('/')].filter(Boolean).join('/');
  return { host, namespace };
}

const isDockerHub = (host) => host === 'docker.io' || host.includes('docker.io');

/** The Authorization header for the gateway image's repository; none for a plain registry. */
async function pullAuthorization(host, namespace, request) {
  let url;
  if (host === 'ghcr.io') url = `https://ghcr.io/token?scope=repository:${namespace}/${IMAGE}:pull&service=ghcr.io`;
  else if (isDockerHub(host)) url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${namespace}/${IMAGE}:pull`;
  else return {};
  const { token } = JSON.parse(await request(url, { headers: { Accept: 'application/json' } }));
  return { Authorization: `Bearer ${token}` };
}

/** Every tag the registry lists for the gateway image (one page); rejects when it cannot be listed. */
async function fetchImageTags(images, request) {
  const { host, namespace } = registryApiTarget(images);
  const headers = { Accept: 'application/json', ...(await pullAuthorization(host, namespace, request)) };
  if (isDockerHub(host)) {
    const url = `https://registry.hub.docker.com/v2/repositories/${namespace}/${IMAGE}/tags/?page_size=${LISTING_PAGE_SIZE}`;
    return (JSON.parse(await request(url, { headers })).results || []).map((r) => r.name);
  }
  return JSON.parse(await request(`https://${host}/v2/${namespace}/${IMAGE}/tags/list`, { headers })).tags || [];
}

/**
 * Whether the registry has the gateway image under `tag`: 'present' when it serves the manifest,
 * 'missing' when it answers 404, 'unknown' otherwise (refused, unreachable).
 */
async function manifestState(images, tag, request) {
  const { host, namespace } = registryApiTarget(images);
  try {
    const headers = { Accept: MANIFEST_TYPES, ...(await pullAuthorization(host, namespace, request)) };
    await request(`https://${isDockerHub(host) ? 'registry-1.docker.io' : host}/v2/${namespace}/${IMAGE}/manifests/${tag}`, { headers });
    return 'present';
  } catch (error) {
    return error && error.statusCode === 404 ? 'missing' : 'unknown';
  }
}

/**
 * Asks for the image version.
 * @param {object} o
 * @param {(questions: object[]) => Promise<object>} o.prompt
 * @param {(key: string, fn: () => Promise<*>) => Promise<*>} o.once  read-only work, once per session
 * @param {(url: string, options: object) => Promise<string>} o.request
 * @param {string} o.registry
 * @param {string} o.organization
 * @param {string} [o.currentTag]  the tag the installation uses now (a re-run)
 * @param {string} o.projectVersion  the version of the checkout the setup runs from
 * @returns {Promise<string>} the tag to write
 */
async function askImageVersion({ prompt, once, request, registry, organization, currentTag, projectVersion }) {
  const images = { registry, organization };
  const label = `${registry}/${organization}`;
  const lookup = `${registry}|${organization}`;

  // Every tag the listing returned; null = the listing failed.
  const listed = await once(`image-tags:${lookup}`, async () => {
    console.log('\n🔍 Fetching available versions...');
    try {
      return await fetchImageTags(images, request);
    } catch (error) {
      console.warn('⚠️  Could not fetch image tags:', error.message);
      console.log('   You can still enter a version manually.\n');
      return null;
    }
  });
  const listedTags = listed && new Set(listed);
  const releases = [...(listedTags || [])].filter(isValidSemver).sort((a, b) => -compareSemver(a, b));

  if (currentTag !== undefined && currentTag !== projectVersion) {
    console.log(`ℹ️  This checkout is version ${projectVersion}; the installation uses ${currentTag}.`);
  }
  // Enter keeps the installed tag on a re-run, and otherwise what the setup always wrote: the
  // checkout's version (its compose file and templates belong to that release).
  const preferred = currentTag !== undefined ? currentTag : projectVersion;

  const validate = async (input) => {
    const tag = String(input || '').trim();
    if (!isValidDockerTag(tag)) {
      return 'Please enter a valid image tag: up to 128 letters, digits, "_", "." or "-", not starting with "." or "-" (e.g., 1.2.3 or review-fixes-d697e0eb)';
    }
    if (isValidSemver(tag)) {
      const lowest = releases[releases.length - 1];
      return lowest !== undefined && compareSemver(tag, lowest) < 0 ? `Version must be ${lowest} or higher` : true;
    }
    if (listedTags && !listedTags.has(tag)) return `Tag "${tag}" was not found for ${IMAGE} in ${label}`;
    if (!listedTags && (await once(`manifest-state:${lookup}:${tag}`, () => manifestState(images, tag, request))) === 'missing') {
      return `Tag "${tag}" was not found for ${IMAGE} in ${label} (the registry answered 404): check the registry or organization answer (Up arrow goes back)`;
    }
    return true;
  };

  const typed = async (message) => {
    const { customImageVersion } = await prompt([
      { type: 'input', name: 'customImageVersion', message, default: preferred, validate, filter: (input) => String(input || '').trim() }
    ]);
    if (!isValidSemver(customImageVersion) && !listedTags) {
      console.warn(`⚠️  Tag "${customImageVersion}" could not be verified: the tags of ${label} could not be listed. Make sure it exists for all images.`);
    }
    return customImageVersion;
  };

  if (releases.length === 0) return typed('Enter image version or tag (e.g., 1.0.0 or review-fixes-d697e0eb):');

  console.log('\nChoose image version:');
  const { imageVersion } = await prompt([
    {
      type: 'list',
      name: 'imageVersion',
      message: 'Select version:',
      choices: [
        ...releases.map((tag, index) => ({ name: index === 0 ? `${tag} (latest)` : tag, value: tag })),
        { name: 'Enter custom version...', value: CUSTOM }
      ],
      default: releases.includes(preferred) ? preferred : CUSTOM
    }
  ]);
  return imageVersion === CUSTOM ? typed('Enter version or image tag (e.g., 1.2.3 or review-fixes-d697e0eb):') : imageVersion;
}

module.exports = { askImageVersion, fetchImageTags, manifestState, registryApiTarget, isValidDockerTag, isValidSemver, compareSemver };
