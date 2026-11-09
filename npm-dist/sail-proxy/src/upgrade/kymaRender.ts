// Drives the release kit's own setup-kyma.js for an upgrade: the current settings are read from the
// installation, every question they answer is answered from them (onlyNew.js), only the rest is
// asked, and the target release is rendered to a temp directory without deploying.
import * as path from 'path';
import { KubectlRead } from './kubectl';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
export type KitScripts = {
  KymaSetup: any;
  PromptSession: any;
  onlyNewPromptFn: (real: PromptOne, current: Record<string, unknown>) => PromptOne;
  deployKyma: any;
  migrationJobs: any;
  installRecord: any;
  dbOps: any;
  kubectlRead: KubectlRead;
  outputRoot: (kymaDir: string, namespace: string) => string;
};
/** One question in, its answer out (PromptSession's promptFn). */
export type PromptOne = (question: any) => Promise<any>;
/** The tag always; registry and organization only in test mode (else the installation's own). */
export type ImageTarget = { registry?: string; organization?: string; tag: string };

/** Loads the kit's scripts from its temp copy (their paths are relative to their own location). */
export function loadKitScripts(root: string): KitScripts {
  const argv = process.argv;
  // setup-kyma.js and setup-docker.js read their flags when loaded
  process.argv = [argv[0], path.join(root, 'kyma', 'scripts', 'setup-kyma.js')];
  try {
    const at = (...p: string[]) => require(path.join(root, ...p));
    return {
      KymaSetup: at('kyma', 'scripts', 'setup-kyma.js'),
      PromptSession: at('docker', 'setup-flow', 'session.js').PromptSession,
      onlyNewPromptFn: at('docker', 'setup-flow', 'onlyNew.js').onlyNewPromptFn,
      deployKyma: at('kyma', 'scripts', 'deploy-kyma.js'),
      migrationJobs: at('kyma', 'scripts', 'migration-jobs.js'),
      installRecord: at('kyma', 'scripts', 'install-record.js'),
      dbOps: at('cli-tools', 'kyma-db-manager.js'),
      kubectlRead: at('kyma', 'scripts', 'kubectl-read.js').runKubectlRead,
      outputRoot: at('kyma', 'scripts', 'kyma-namespace.js').outputRoot,
    };
  } finally {
    process.argv = argv;
  }
}

export type Rendered = {
  setup: any;
  answers: any;
  containerConfig: any;
  /** outputRoot(outputDir, namespace): holds manifests/ and templates/ */
  renderRoot: string;
  manifestsDir: string;
};

/**
 * Asks (only what is new) and renders the target release into outputDir. The images keep the
 * installation's registry and organization (a mirror, a private org) with the target's tag; test
 * mode sets all three. Keys are never regenerated (the key question
 * answers keep, and the provider is the current one, so no provider change can add a key).
 */
export async function renderTarget(o: {
  kit: KitScripts;
  namespace: string;
  outputDir: string;
  target: ImageTarget;
  prompt: PromptOne;
  clusterIp: string;
  kubectlRead?: KubectlRead;
  adjustSetup?: (setup: any) => void;
}): Promise<Rendered> {
  const { kit, namespace: ns, target } = o;
  const setup = new kit.KymaSetup({ outputRoot: o.outputDir, namespace: ns, outputIsTemporary: true });
  if (o.kubectlRead) setup.runKubectl = o.kubectlRead;
  setup._k8sApiClusterIp = o.clusterIp;
  // The version is the target's: no registry listing, no version question
  setup.selectImageVersion = async () => ({ tag: target.tag, useDigests: false, imageDigests: {}, published: true });
  if (o.adjustSetup) o.adjustSetup(setup);

  const session = new kit.PromptSession({ promptFn: async () => { throw new Error('asked before the session was ready'); } });
  setup.session = session;
  const live = await session.once(`existing-keys:${ns}`, () => setup.readExistingKeys());
  if (live.state !== 'exists') throw new Error(`Namespace ${ns} holds no installation to upgrade.`);
  const current = await session.once(`current-values:${ns}`, () => setup.loadCurrentValues(ns));
  delete current.imageTag;
  delete current.imageDigest;
  if (target.registry) {
    delete current.customRegistry;
    Object.assign(current, kit.installRecord.registryAnswers(target.registry));
  }
  if (target.organization) current.organization = target.organization;
  // readLiveValues reports a pull secret only when there is one
  if (current.imagePullSecrets === undefined) current.imagePullSecrets = false;

  // Answers the session's current values do not hold: the namespace, and the database user and
  // password, which an existing namespace keeps (its volume accepts only those; Enter keeps them).
  const extras: Record<string, unknown> = { namespace: ns };
  if (live.db) Object.assign(extras, { POSTGRES_USER: live.db.POSTGRES_USER, POSTGRES_PASSWORD: true });
  // Not set means the application default, and answering that default writes nothing
  // (billingToWrite / pluginInstallToWrite): the installation keeps running as it does.
  if (current.SAP_BILLING_CURRENCY === undefined) extras.SAP_BILLING_CURRENCY = 'USD';
  if (current.INSTALLED_PLUGINS_ENABLED === undefined) extras.INSTALLED_PLUGINS_ENABLED = true;
  const view = new Proxy({}, {
    get: (_t, key) => (typeof key === 'string' && key in extras ? extras[key] : session.current[key as string]),
  }) as Record<string, unknown>;
  session.promptFn = kit.onlyNewPromptFn(o.prompt, view);
  setup.answersNamespace = undefined;
  const answers = await session.run((s: unknown) => setup.collectAnswers(s));
  if (current.provider !== undefined && answers.provider !== current.provider) {
    throw new Error(`The login provider would change (${current.provider} → ${answers.provider}); an upgrade keeps it.`);
  }
  await setup.applyAnswers({ ...answers, autoDeploy: null, regenerateKeys: [], providerChange: null });
  const renderRoot = kit.outputRoot(o.outputDir, ns);
  return { setup, answers, containerConfig: answers.containerConfig, renderRoot, manifestsDir: path.join(renderRoot, 'manifests') };
}
