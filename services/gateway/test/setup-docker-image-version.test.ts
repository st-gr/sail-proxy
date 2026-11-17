/**
 * setup-docker.js, registry mode: the image version is chosen like in setup-kyma.js. The listed
 * releases of sail-proxy-gateway are offered newest first, plus "Enter custom version..."; without
 * a listing the version is typed. Until 2026-11-17 the setup wrote the checkout's version without
 * asking, so an installation could not be set up on another published version.
 *
 * Local builds are not asked: they build the checkout, under its version. The registry is a stub;
 * nothing is fetched.
 */
import * as fs from 'fs';
import * as path from 'path';
import { forbidChildProcess, makeDockerRoot, newDockerSetup, stubRegistry } from './helpers/setupDockerHarness';
import { scripted, Step } from './helpers/scriptedPrompter';

const savedArgv = process.argv;
process.argv = [savedArgv[0], 'setup-docker.js'];
/* eslint-disable @typescript-eslint/no-var-requires */
const DockerSetup = require('../../../docker/setup-docker.js');
process.argv = savedArgv;
const { PromptSession, REVIEW } = require('../../../docker/setup-flow/session');
const imageVersion = require('../../../docker/setup-flow/image-version');
/* eslint-enable @typescript-eslint/no-var-requires */

const VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')).version as string;
const OLDER = '0.2.0';
const OLDEST = '0.1.0';
const BRANCH_TAG = 'review-fixes-d697e0eb';
// As a registry lists them: unordered, with tags that are no release.
const LISTING = [OLDER, 'latest', VERSION, BRANCH_TAG, OLDEST];

let root: string;
let savedEnv: NodeJS.ProcessEnv;
let warnings: string[];

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of ['SAP_AI_CORE_SERVICE_KEY', 'POSTGRES_USER', 'POSTGRES_PASSWORD']) delete process.env[key];
  root = makeDockerRoot();
  warnings = [];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as any);
  forbidChildProcess();
});

afterEach(() => {
  process.env = savedEnv;
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const tagIn = (rel: string) => (read(rel).match(/^DOCKER_TAG=(.*)$/m) || [])[1];

const HEAD: Step[] = [
  ['POSTGRES_USER', 'admin_user'],
  ['POSTGRES_PASSWORD', ''],
  ['configMethod', 'skip'],
  ['provider', 'local'],
  ['LOGOUT_REDIRECT_URL', 'auto-shell'],
  ['useDevelopment', true]
];
const REGISTRY: Step[] = [['imageMode', 'registry'], ['registry', 'ghcr.io'], ['organization', 'st-gr']];
const TAIL: Step[] = [['SAP_BILLING_CURRENCY', 'USD'], ['INSTALLED_PLUGINS_ENABLED', true]];
const WRITE: Step[] = [['pullImages', false], [REVIEW, 'WRITE']];

/** An interactive run in registry mode against a registry that lists `listing` (or fails). */
async function registryRun(versionSteps: Step[], listing: string[] | Error, manifest?: (tag: string) => number) {
  const script = scripted([...HEAD, ...REGISTRY, ...versionSteps, ...TAIL, ...WRITE]);
  const { setup } = newDockerSetup(DockerSetup, root, {});
  const requests = stubRegistry(setup, listing, manifest);
  setup.createSession = (current?: Record<string, unknown>) => new PromptSession({ promptFn: script.promptFn, current });
  await setup.run();
  script.assertDone();
  const question = (id: string) => script.shown.filter((q) => q.id === id);
  return { script, requests, question };
}

describe('setup-docker.js registry mode: the image version chooser', () => {
  it('offers the listed releases newest first with the checkout\'s version preselected, and writes the chosen one', async () => {
    const { question, requests } = await registryRun([['imageVersion', OLDER]], LISTING);
    const [asked] = question('imageVersion');
    expect(asked.question.choices).toEqual([
      { name: `${VERSION} (latest)`, value: VERSION },
      { name: OLDER, value: OLDER },
      { name: OLDEST, value: OLDEST },
      { name: 'Enter custom version...', value: 'custom' }
    ]);
    expect(asked.default).toBe(VERSION);
    expect(question('customImageVersion')).toEqual([]);

    expect(tagIn('docker/.env.docker')).toBe(OLDER);
    expect(tagIn('docker/.env')).toBe(OLDER);
    expect(JSON.parse(read('docker/.sail-proxy-install.json')).version).toBe(OLDER);
    // One listing of the gateway image, on the registry that was answered
    expect(requests.filter((url) => /tags\/list/.test(url))).toEqual(['https://ghcr.io/v2/st-gr/sail-proxy-gateway/tags/list']);
  });

  it('Enter on the list keeps what the setup wrote before: the checkout\'s version', async () => {
    await registryRun([['imageVersion', VERSION]], LISTING);
    expect(tagIn('docker/.env.docker')).toBe(VERSION);
    expect(JSON.parse(read('docker/.sail-proxy-install.json')).version).toBe(VERSION);
  });

  it('a checkout whose version is not published yet starts on the custom entry, with that version typed in', async () => {
    const { question } = await registryRun([['imageVersion', 'custom'], ['customImageVersion', VERSION]], [OLDER, OLDEST]);
    expect(question('imageVersion')[0].default).toBe('custom');
    expect(question('customImageVersion')[0].default).toBe(VERSION);
    expect(tagIn('docker/.env.docker')).toBe(VERSION);
  });

  it('a custom tag: a release below the lowest listed one and a tag the registry does not list are refused', async () => {
    const { question } = await registryRun(
      [['imageVersion', 'custom'], ['customImageVersion', '0.0.9'], ['customImageVersion', 'no-such-tag'], ['customImageVersion', ` ${BRANCH_TAG} `]],
      LISTING
    );
    expect(question('customImageVersion')[0].rejected).toEqual(['0.0.9', 'no-such-tag']);
    expect(tagIn('docker/.env.docker')).toBe(BRANCH_TAG);
    expect(JSON.parse(read('docker/.sail-proxy-install.json')).version).toBe(BRANCH_TAG);
    expect(warnings.filter((w) => /could not be verified/.test(w))).toEqual([]);
  });

  it('a registry that cannot be listed: the version is typed, starting from the checkout\'s', async () => {
    const { question } = await registryRun([['customImageVersion', OLDER]], new Error('HTTP 401: denied'));
    expect(question('imageVersion')).toEqual([]);
    expect(question('customImageVersion')[0].default).toBe(VERSION);
    expect(tagIn('docker/.env.docker')).toBe(OLDER);
  });

  it('without a listing, a tag whose manifest the registry answers 404 for is refused', async () => {
    const { question } = await registryRun(
      [['customImageVersion', 'no-such-tag'], ['customImageVersion', BRANCH_TAG]],
      new Error('HTTP 401: denied'),
      (tag) => (tag === BRANCH_TAG ? 200 : 404)
    );
    expect(question('customImageVersion')[0].rejected).toEqual(['no-such-tag']);
    expect(tagIn('docker/.env.docker')).toBe(BRANCH_TAG);
  });

  it('without a listing, a tag the registry will not tell about is taken with a warning', async () => {
    await registryRun([['customImageVersion', BRANCH_TAG]], new Error('HTTP 401: denied'), () => 401);
    expect(tagIn('docker/.env.docker')).toBe(BRANCH_TAG);
    expect(warnings.filter((w) => /could not be verified/.test(w))).toHaveLength(1);
  });

  it('Back from the version list and forward again lists the registry once', async () => {
    const { requests } = await registryRun(
      [['imageVersion', 'BACK'], ['organization', 'st-gr'], ['imageVersion', OLDER]],
      LISTING
    );
    expect(requests.filter((url) => /tags\/list/.test(url))).toHaveLength(1);
    expect(tagIn('docker/.env.docker')).toBe(OLDER);
  });

  it('local builds are not asked and build the checkout\'s version', async () => {
    const script = scripted([...HEAD, ['imageMode', 'local'], ...TAIL, [REVIEW, 'WRITE']]);
    const { setup } = newDockerSetup(DockerSetup, root, {});
    const requests = stubRegistry(setup, LISTING);
    setup.createSession = (current?: Record<string, unknown>) => new PromptSession({ promptFn: script.promptFn, current });
    await setup.run();
    script.assertDone();
    expect(script.shown.map((q) => q.id).filter((id) => /mageVersion/.test(id))).toEqual([]);
    expect(requests).toEqual([]);
    expect(tagIn('docker/.env.docker')).toBe(VERSION);
  });
});

describe('setup-docker.js registry mode: a re-run starts from the installed version', () => {
  it('the list preselects the tag the installation uses, and says when the checkout differs', async () => {
    await registryRun([['imageVersion', OLDER]], LISTING);
    const before = read('docker/.env.docker');

    const lines: string[] = [];
    (console.log as jest.Mock).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const { setup } = newDockerSetup(DockerSetup, root, {});
    stubRegistry(setup, LISTING);
    const current = await setup.loadCurrentValues();
    expect(current.imageTag).toBe(OLDER);

    const shown: any[] = [];
    setup.session = new PromptSession({
      current,
      promptFn: async (question: any) => {
        shown.push(question);
        return question.default;
      }
    });
    expect(await setup.selectImageVersion('ghcr.io', 'st-gr')).toBe(OLDER);
    expect(shown.map((q) => [q.id, q.default])).toEqual([['imageVersion', OLDER]]);
    expect(lines.filter((l) => l.includes(`This checkout is version ${VERSION}`) && l.includes(OLDER))).toHaveLength(1);
    expect(read('docker/.env.docker')).toBe(before);
  });

  it('a tag the registry no longer lists is offered on the custom entry', async () => {
    await registryRun([['customImageVersion', BRANCH_TAG]], new Error('HTTP 401: denied'), () => 401);
    const { setup } = newDockerSetup(DockerSetup, root, {});
    stubRegistry(setup, [VERSION, OLDER]);
    const current = await setup.loadCurrentValues();
    const shown: any[] = [];
    setup.session = new PromptSession({
      current,
      promptFn: async (question: any) => {
        shown.push(question);
        return question.default;
      }
    });
    // The listing lacks the branch tag, so Enter on the typed default is refused by its validation:
    // the defaults are what is shown, and that is what this pins.
    await setup.selectImageVersion('ghcr.io', 'st-gr').catch(() => undefined);
    expect(shown.map((q) => [q.id, q.default])).toEqual([['imageVersion', 'custom'], ['customImageVersion', BRANCH_TAG]]);
  });

  it('a local-build installation holds no chosen tag', async () => {
    const script = scripted([...HEAD, ['imageMode', 'local'], ...TAIL, [REVIEW, 'WRITE']]);
    const { setup } = newDockerSetup(DockerSetup, root, {});
    setup.createSession = (current?: Record<string, unknown>) => new PromptSession({ promptFn: script.promptFn, current });
    await setup.run();
    const again = newDockerSetup(DockerSetup, root, {}).setup;
    expect((await again.loadCurrentValues()).imageTag).toBeUndefined();
  });
});

describe('docker/setup-flow/image-version.js: where a registry is asked', () => {
  const calls = (answers: Record<string, unknown>) => {
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      const hit = Object.keys(answers).find((part) => url.includes(part));
      if (!hit) throw Object.assign(new Error('HTTP 404: not found'), { statusCode: 404 });
      return JSON.stringify(answers[hit]);
    };
    return { urls, request };
  };

  it('ghcr.io: an anonymous pull token, then the tag list of the gateway image', async () => {
    const { urls, request } = calls({ '/token': { token: 't' }, 'tags/list': { tags: ['1.0.0'] } });
    expect(await imageVersion.fetchImageTags({ registry: 'ghcr.io', organization: 'st-gr' }, request)).toEqual(['1.0.0']);
    expect(urls).toEqual([
      'https://ghcr.io/token?scope=repository:st-gr/sail-proxy-gateway:pull&service=ghcr.io',
      'https://ghcr.io/v2/st-gr/sail-proxy-gateway/tags/list'
    ]);
  });

  it('a registry answer with a path: the path starts the repository namespace', async () => {
    const { urls, request } = calls({ '/token': { token: 't' }, 'tags/list': { tags: [] } });
    await imageVersion.fetchImageTags({ registry: 'ghcr.io/st-gr', organization: 'sail-proxy-private' }, request);
    expect(urls[1]).toBe('https://ghcr.io/v2/st-gr/sail-proxy-private/sail-proxy-gateway/tags/list');
  });

  it('docker.io: the Hub listing', async () => {
    const { urls, request } = calls({ 'auth.docker.io': { token: 't' }, 'registry.hub.docker.com': { results: [{ name: '1.0.0' }, { name: 'latest' }] } });
    expect(await imageVersion.fetchImageTags({ registry: 'docker.io', organization: 'acme' }, request)).toEqual(['1.0.0', 'latest']);
    expect(urls[1]).toBe('https://registry.hub.docker.com/v2/repositories/acme/sail-proxy-gateway/tags/?page_size=100');
  });

  it('any other registry: its own tag list, without a token', async () => {
    const { urls, request } = calls({ 'tags/list': { tags: ['2.0.0'] } });
    expect(await imageVersion.fetchImageTags({ registry: 'registry.example.invalid', organization: 'acme' }, request)).toEqual(['2.0.0']);
    expect(urls).toEqual(['https://registry.example.invalid/v2/acme/sail-proxy-gateway/tags/list']);
  });

  it('manifestState: present, missing on 404, unknown otherwise', async () => {
    const target = { registry: 'ghcr.io', organization: 'st-gr' };
    const answering = (status: number) => async (url: string) => {
      if (url.includes('/token')) return JSON.stringify({ token: 't' });
      if (status === 200) return '{}';
      throw Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
    };
    expect(await imageVersion.manifestState(target, 'x', answering(200))).toBe('present');
    expect(await imageVersion.manifestState(target, 'x', answering(404))).toBe('missing');
    expect(await imageVersion.manifestState(target, 'x', answering(401))).toBe('unknown');
    expect(await imageVersion.manifestState(target, 'x', async () => { throw new Error('ENOTFOUND'); })).toBe('unknown');
  });
});
