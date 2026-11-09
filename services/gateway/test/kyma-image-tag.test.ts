/**
 * setup-kyma.js accepts any valid Docker tag as a custom image version.
 *
 * The custom-version prompt used to accept X.Y.Z only, so images pushed under
 * a branch tag (e.g. review-fixes-d697e0eb) could not be deployed. It now
 * accepts any valid Docker tag. A semver tag keeps the "not below the lowest
 * listed release" rule; any other tag must exist in the registry listing when
 * the listing succeeded, and is accepted with a warning when it could not be
 * listed. The registry and the prompts are mocked; nothing is fetched.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const KymaSetup = require('../../../kyma/scripts/setup-kyma.js');
// The module object the setup script's own require('https') returns, so its request can be stubbed.
const https = require('https');
/* eslint-enable @typescript-eslint/no-var-requires */

KymaSetup.useYaml({
  dump: (obj: unknown) => JSON.stringify(obj, null, 2) + '\n',
  load: () => {
    throw new Error('yaml.load is not available in tests');
  },
});

const BRANCH_TAG = 'review-fixes-d697e0eb';
const REGISTRY = { registry: 'ghcr.io', organization: 'st-gr/sail-proxy-private' };

/** A setup whose registry answers with the given tags list (or fails). */
function makeSetup(listing: string[] | Error) {
  const setup = new KymaSetup({});
  setup.getGhcrToken = async () => 'anonymous-token';
  setup.makeHttpRequest = async () => {
    if (listing instanceof Error) throw listing;
    return JSON.stringify({ tags: listing });
  };
  setup.fetchImageDigest = async () => null; // never reached for custom tags
  // The manifest lookup of a tag: by default the registry refuses it (cannot be told).
  setup.lookupImageDigest = async () => {
    throw httpError(401);
  };
  return setup;
}

/** The error a registry request rejects with for an HTTP status. */
function httpError(statusCode: number) {
  return Object.assign(new Error(`Failed to get manifest: HTTP ${statusCode}`), { statusCode });
}

/** A manifest lookup that finds `tag` of sail-proxy-gateway and answers `missing` otherwise. */
function manifestOnlyFor(tag: string, missing = 401) {
  return async (_c: unknown, image: string, asked: string) => {
    if (image === 'sail-proxy-gateway' && asked === tag) return 'sha256:abc';
    throw httpError(missing);
  };
}

/**
 * Scripted prompts: picks `choice` from the version list (if asked) and
 * types `typed` into the version input, running the prompt's own validate.
 */
function scriptVersionPrompts(choice: string, typed: string) {
  const validations: unknown[] = [];
  KymaSetup.useInquirer({
    prompt: async (questions: Array<Record<string, any>>) => {
      const answers: Record<string, unknown> = {};
      for (const q of questions) {
        if (q.type === 'list') answers[q.name] = choice;
        else {
          const verdict = q.validate ? await q.validate(typed) : true;
          validations.push(verdict);
          if (verdict !== true) throw new Error(`validate: ${verdict}`);
          answers[q.name] = typed;
        }
      }
      return answers;
    },
  });
  return validations;
}

function captureOutput() {
  const lines: string[] = [];
  const spies = ['log', 'warn', 'error'].map((m) =>
    jest.spyOn(console, m as 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    })
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

describe('setup-kyma.js custom image version', () => {
  let out: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    out = captureOutput();
  });

  afterEach(() => {
    out.restore();
    KymaSetup.useInquirer(null);
  });

  it('accepts a branch tag that the registry lists', async () => {
    const setup = makeSetup(['0.10.0', '0.9.5', BRANCH_TAG]);
    scriptVersionPrompts('custom', BRANCH_TAG);
    const result = await setup.selectImageVersion(REGISTRY);
    expect(result.tag).toBe(BRANCH_TAG);
    expect(result.useDigests).toBe(false);
  });

  it('still offers only semver releases in the version list', async () => {
    const setup = makeSetup(['0.10.0', BRANCH_TAG, '0.9.5']);
    expect(await setup.fetchImageTags(REGISTRY)).toEqual(['0.10.0', '0.9.5']);
  });

  it('accepts a listed branch tag when the registry has no semver release at all', async () => {
    const setup = makeSetup([BRANCH_TAG]);
    scriptVersionPrompts('custom', BRANCH_TAG);
    const result = await setup.selectImageVersion(REGISTRY);
    expect(result.tag).toBe(BRANCH_TAG);
  });

  it.each(['bad tag!', '-starts-with-dash', '.dot', 'a'.repeat(129), 'with/slash', 'tag:colon', ''])(
    'rejects the invalid Docker tag %j',
    async (tag) => {
      const setup = makeSetup(['0.10.0', BRANCH_TAG]);
      scriptVersionPrompts('custom', tag);
      await expect(setup.selectImageVersion(REGISTRY)).rejects.toThrow(/valid image tag/);
    }
  );

  it('still rejects a semver version below the lowest listed release', async () => {
    const setup = makeSetup(['0.10.0', '0.9.5']);
    scriptVersionPrompts('custom', '0.9.4');
    await expect(setup.selectImageVersion(REGISTRY)).rejects.toThrow(/0\.9\.5 or higher/);
  });

  it('accepts a semver version at or above the lowest listed release, with or without v', async () => {
    for (const typed of ['0.9.5', 'v0.11.0']) {
      const setup = makeSetup(['0.10.0', '0.9.5']);
      scriptVersionPrompts('custom', typed);
      expect((await setup.selectImageVersion(REGISTRY)).tag).toBe(typed);
    }
  });

  it('rejects a branch tag the successful listing does not contain', async () => {
    const setup = makeSetup(['0.10.0', 'review-fixes-00000000']);
    scriptVersionPrompts('custom', BRANCH_TAG);
    await expect(setup.selectImageVersion(REGISTRY)).rejects.toThrow(
      /review-fixes-d697e0eb.*not found.*sail-proxy-gateway/
    );
  });

  it('accepts a branch tag with a warning when the registry could not be listed', async () => {
    const setup = makeSetup(new Error('HTTP 401'));
    scriptVersionPrompts('custom', BRANCH_TAG);
    const result = await setup.selectImageVersion(REGISTRY);
    expect(result.tag).toBe(BRANCH_TAG);
    expect(out.lines.join('\n')).toMatch(/could not be verified/i);
  });

  // sail-proxy-test 2026-11-06: registry ghcr.io with organization "sail-proxy-private" (the
  // "st-gr/" prefix left out). The listing was refused and the manifest answered 404, yet the tag
  // was accepted, rendered, and every new pod ended in ImagePullBackOff.
  it('rejects a branch tag the unlistable registry answers 404 for, naming registry and organization', async () => {
    const setup = makeSetup(new Error('HTTP 403'));
    setup.lookupImageDigest = manifestOnlyFor('another-tag', 404);
    scriptVersionPrompts('custom', BRANCH_TAG);
    await expect(setup.selectImageVersion({ registry: 'ghcr.io', organization: 'sail-proxy-private' })).rejects.toThrow(
      /review-fixes-d697e0eb.*not found.*ghcr\.io\/sail-proxy-private.*registry or organization/
    );
  });

  it('accepts a branch tag the unlistable registry serves the manifest of', async () => {
    const setup = makeSetup(new Error('HTTP 403'));
    setup.lookupImageDigest = manifestOnlyFor(BRANCH_TAG, 404);
    scriptVersionPrompts('custom', BRANCH_TAG);
    expect((await setup.selectImageVersion(REGISTRY)).tag).toBe(BRANCH_TAG);
  });

  // A release may be rendered before it is built: the summary then gives the build commands.
  it('still accepts a release the registry answers 404 for', async () => {
    const setup = makeSetup(new Error('HTTP 403'));
    setup.lookupImageDigest = manifestOnlyFor('another-tag', 404);
    scriptVersionPrompts('custom', '0.12.0');
    expect((await setup.selectImageVersion(REGISTRY)).tag).toBe('0.12.0');
  });
});

// The completion summary tells the user whether images still have to be built and where they
// come from. It used to ask for a build for every tag except one fixed public version, and to call
// every registry public.
describe('setup-kyma.js knows whether the chosen images are published', () => {
  let out: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    out = captureOutput();
  });

  afterEach(() => {
    out.restore();
    KymaSetup.useInquirer(null);
  });

  it('marks a version chosen from the listed releases as published', async () => {
    const setup = makeSetup(['0.11.0', '0.10.0']);
    scriptVersionPrompts('0.11.0', '');
    expect((await setup.selectImageVersion(REGISTRY)).published).toBe(true);
  });

  it('marks a typed tag the registry lists as published', async () => {
    const setup = makeSetup(['0.11.0', BRANCH_TAG]);
    scriptVersionPrompts('custom', BRANCH_TAG);
    expect((await setup.selectImageVersion(REGISTRY)).published).toBe(true);
  });

  it('marks a typed release the registry does not list as not published', async () => {
    const setup = makeSetup(['0.11.0', '0.10.0']);
    scriptVersionPrompts('custom', '0.12.0');
    expect((await setup.selectImageVersion(REGISTRY)).published).toBe(false);
  });

  // The listing reads one page (100 entries); an older tag can exist beyond it.
  it('marks a typed tag missing from the listing as published when the registry has its manifest', async () => {
    const setup = makeSetup(['0.11.0', '0.10.0']);
    setup.lookupImageDigest = manifestOnlyFor('0.10.5');
    scriptVersionPrompts('custom', '0.10.5');
    expect((await setup.selectImageVersion(REGISTRY)).published).toBe(true);
  });

  it('leaves it unknown when a full listing page lacks the tag and the manifest cannot be read', async () => {
    const page = Array.from({ length: 100 }, (_, i) => `review-${String(i).padStart(3, '0')}`).concat('0.11.0');
    const setup = makeSetup(page);
    scriptVersionPrompts('custom', '0.12.0');
    expect((await setup.selectImageVersion(REGISTRY)).published).toBeNull();
  });

  it('leaves it unknown when the registry could not be listed', async () => {
    const setup = makeSetup(new Error('HTTP 401'));
    scriptVersionPrompts('custom', BRANCH_TAG);
    expect((await setup.selectImageVersion(REGISTRY)).published).toBeNull();
  });

  it('marks a tag as published when the listing failed but the registry has its manifest', async () => {
    const setup = makeSetup(new Error('HTTP 401'));
    setup.lookupImageDigest = manifestOnlyFor(BRANCH_TAG);
    scriptVersionPrompts('custom', BRANCH_TAG);
    expect((await setup.selectImageVersion(REGISTRY)).published).toBe(true);
  });

  it('marks a typed release as not published when the listing failed and the registry answers 404', async () => {
    const setup = makeSetup(new Error('HTTP 403'));
    setup.lookupImageDigest = manifestOnlyFor('another-tag', 404);
    scriptVersionPrompts('custom', '0.12.0');
    expect((await setup.selectImageVersion(REGISTRY)).published).toBe(false);
  });
});

// The test-namespace recipe answers the registry as Custom "ghcr.io/st-gr" with organization
// "sail-proxy-private". The lookups used to send that to https://ghcr.io/st-gr/v2/..., which GitHub
// answers with a 303, so no tag could ever be listed or checked for that answer.
describe('setup-kyma.js looks up a GHCR registry given with an owner path', () => {
  const PATHED = { registry: 'ghcr.io/st-gr', organization: 'sail-proxy-private' };
  let out: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    out = captureOutput();
  });

  afterEach(() => {
    out.restore();
  });

  function recordingSetup() {
    const setup = new KymaSetup({});
    const urls: string[] = [];
    const tokenScopes: string[] = [];
    setup.getGhcrToken = async (namespace: string, repository: string) => {
      tokenScopes.push(`${namespace}/${repository}`);
      return 'token';
    };
    setup.makeHttpRequest = async (url: string) => {
      urls.push(url);
      if (url.startsWith('https://api.github.com/users/')) {
        if (url.includes('/packages/')) return JSON.stringify([{ metadata: { container: { tags: [BRANCH_TAG] } } }]);
        return JSON.stringify({ type: 'User' });
      }
      return JSON.stringify({ tags: [BRANCH_TAG] });
    };
    return { setup, urls, tokenScopes };
  }

  it('lists the tags anonymously at ghcr.io/v2 under the whole namespace', async () => {
    const { setup, urls, tokenScopes } = recordingSetup();
    await setup.fetchImageTags(PATHED);
    expect(urls).toEqual(['https://ghcr.io/v2/st-gr/sail-proxy-private/sail-proxy-gateway/tags/list']);
    expect(tokenScopes).toEqual(['st-gr/sail-proxy-private/sail-proxy-gateway']);
    expect(setup.listedTags.has(BRANCH_TAG)).toBe(true);
  });

  it('lists the tags with credentials through the package of the owner', async () => {
    const { setup, urls } = recordingSetup();
    await setup.fetchImageTags({ ...PATHED, dockerUsername: 'someone', dockerPassword: 'not-a-real-token' });
    expect(urls).toContain('https://api.github.com/users/st-gr');
    expect(urls).toContain('https://api.github.com/users/st-gr/packages/container/sail-proxy-private%2Fsail-proxy-gateway/versions?per_page=100');
    expect(setup.listedTags.has(BRANCH_TAG)).toBe(true);
  });

  it('reads the manifest at ghcr.io/v2 under the whole namespace', async () => {
    const { setup } = recordingSetup();
    const manifestUrls: string[] = [];
    setup.fetchManifestAndResolve = async (url: string) => {
      manifestUrls.push(url);
      return 'sha256:abc';
    };
    expect(await setup.fetchImageDigest(PATHED, 'sail-proxy-gateway', BRANCH_TAG)).toBe('sha256:abc');
    expect(manifestUrls).toEqual([`https://ghcr.io/v2/st-gr/sail-proxy-private/sail-proxy-gateway/manifests/${BRANCH_TAG}`]);
  });

  it('reads a public ghcr manifest without a login through an anonymous pull token', async () => {
    // 2026-11-08: the 0.12.0 upgrade of production (public images, no pull secret) sent the manifest
    // request without a token and ghcr answered 401, which it does for public images too.
    const setup = new KymaSetup({});
    const tokenCalls: unknown[][] = [];
    setup.getGhcrToken = async (...args: unknown[]) => {
      tokenCalls.push(args);
      return 'anonymous-token';
    };
    const sent: Array<{ url: string; token: string }> = [];
    setup.fetchManifestAndResolve = async (url: string, token: string) => {
      sent.push({ url, token });
      return 'sha256:abc';
    };
    expect(await setup.lookupImageDigest({ registry: 'ghcr.io', organization: 'st-gr' }, 'sail-proxy-admin', '0.12.0')).toBe('sha256:abc');
    expect(tokenCalls).toEqual([['st-gr', 'sail-proxy-admin', undefined, undefined]]);
    expect(sent).toEqual([{ url: 'https://ghcr.io/v2/st-gr/sail-proxy-admin/manifests/0.12.0', token: 'anonymous-token' }]);
  });

  it('rejects a manifest request with the HTTP status the registry answered', async () => {
    const request = jest.spyOn(https, 'request').mockImplementation(((_url: string, _o: unknown, onResponse: (res: unknown) => void) => {
      const req = { on: () => req, end: () => onResponse({ statusCode: 404, headers: {}, resume: () => undefined }) };
      return req;
    }) as never);
    try {
      await expect(new KymaSetup({}).fetchManifestAndResolve('https://ghcr.io/v2/x/manifests/y', 'token', '', 'linux/amd64'))
        .rejects.toMatchObject({ statusCode: 404, message: expect.stringMatching(/HTTP 404/) });
    } finally {
      request.mockRestore();
    }
  });
});

describe('setup-kyma.js completion summary', () => {
  const base = {
    namespace: 'sail-proxy-test',
    provider: 'github',
    deploymentType: 'internal',
    containerRegistry: 'ghcr.io',
    containerOrganization: 'st-gr/sail-proxy-private',
    containerTag: BRANCH_TAG,
    imagePullSecrets: true,
    dockerUsername: 'robot',
    dockerPassword: 'not-a-real-token',
    passwordWasGenerated: true,
  };

  async function summary(override: Record<string, unknown>) {
    const out = captureOutput();
    try {
      const setup = new KymaSetup({});
      setup.sharedSecrets = {
        POSTGRES_PASSWORD: 'p'.repeat(16), VALIDATION_TOKEN_SECRET: 'v'.repeat(64), METADATA_ENCRYPTION_KEY: 'm'.repeat(64),
        AWS_SECRET_ENCRYPTION_KEY: 'a'.repeat(64), OAUTH2_PROXY_CLIENT_SECRET: 'c'.repeat(64), OAUTH2_PROXY_COOKIE_SECRET: 'k'.repeat(32),
      };
      await setup.showCompletion({ ...base, ...override });
    } finally {
      out.restore();
    }
    return out.lines.join('\n');
  }

  it('asks for no build when the chosen images are published', async () => {
    const text = await summary({ imagesPublished: true });
    expect(text).not.toMatch(/docker (build|push)/);
    expect(text).toMatch(/node \S*deploy-kyma\.js --namespace sail-proxy-test/);
  });

  it('gives the build commands when the tag is not published', async () => {
    const text = await summary({ imagesPublished: false });
    expect(text).toContain(`docker push ghcr.io/st-gr/sail-proxy-private/sail-proxy-gateway:${BRANCH_TAG}`);
  });

  it('gives the build commands as a condition when the tag could not be checked', async () => {
    const text = await summary({ imagesPublished: null });
    expect(text).toMatch(/could not be (checked|verified)/i);
    expect(text).toContain(`docker push ghcr.io/st-gr/sail-proxy-private/sail-proxy-gateway:${BRANCH_TAG}`);
  });

  it('names a private registry as private, pulled with the rendered pull secret', async () => {
    const text = await summary({ imagesPublished: true });
    expect(text).not.toMatch(/public GitHub container registry/);
    expect(text).toMatch(/ghcr\.io\/st-gr\/sail-proxy-private\/sail-proxy-\*.*private.*registry-secret/);
  });

  it('names a registry without a pull secret as public', async () => {
    const text = await summary({
      imagesPublished: true, containerOrganization: 'st-gr', containerTag: '0.11.0', imagePullSecrets: false,
      dockerUsername: undefined, dockerPassword: undefined,
    });
    expect(text).toMatch(/ghcr\.io\/st-gr\/sail-proxy-\*.*public/);
  });
});

describe('setup-kyma.js renders a branch tag into every image', () => {
  let outputRoot: string;

  beforeEach(() => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-tag-out-'));
  });

  afterEach(() => {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it('puts the tag unchanged into every image reference of the core manifests', async () => {
    const setup = new KymaSetup({ outputRoot });
    const out = captureOutput();
    try {
      await setup.createCoreManifests({
        namespace: 'sail-proxy',
        containerRegistry: 'ghcr.io',
        containerOrganization: 'st-gr/sail-proxy-private',
        containerTag: BRANCH_TAG,
        useDigests: false,
        imagePullSecrets: true,
        deploymentType: 'internal',
      });
    } finally {
      out.restore();
    }
    const images = ['gateway.yaml', 'admin.yaml', 'nginx.yaml'].flatMap((file) =>
      [...fs.readFileSync(path.join(outputRoot, 'manifests', 'core', file), 'utf8').matchAll(/^\s*image: (\S+)$/gm)].map(
        (m) => m[1]
      )
    );
    expect(images.filter((i) => i.includes('/sail-proxy-'))).toEqual([
      `ghcr.io/st-gr/sail-proxy-private/sail-proxy-gateway:${BRANCH_TAG}`,
      `ghcr.io/st-gr/sail-proxy-private/sail-proxy-gateway:${BRANCH_TAG}`,
      `ghcr.io/st-gr/sail-proxy-private/sail-proxy-admin:${BRANCH_TAG}`,
      `ghcr.io/st-gr/sail-proxy-private/sail-proxy-nginx:${BRANCH_TAG}`,
    ]);
  });
});
