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
  return setup;
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
