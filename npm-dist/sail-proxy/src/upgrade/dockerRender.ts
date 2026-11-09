// Drives the release kit's own setup-docker.js for `upgrade docker`: the current settings are read
// from the install directory, every question they answer is answered from them (onlyNew.js), only
// the rest is asked (collect, writes nothing); later, after the backup, the answers are written into
// the install directory with the target image tag (apply). Volumes are never deleted, nothing is
// pulled or started by setup, and keys are never regenerated.
import * as fs from 'fs';
import * as path from 'path';
import { DbBuilders } from './dockerHost';
import { PromptOne } from './kymaRender';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
export type DockerKit = {
  root: string;
  DockerSetup: any;
  PromptSession: any;
  onlyNewPromptFn: (real: PromptOne, current: Record<string, unknown>) => PromptOne;
  installRecord: any;
  /** kyma/scripts/local-config-snapshot.js: the files setup-docker.js writes, snapshot and restore */
  localConfig: any;
  builders: DbBuilders;
};
/** Registry and organization of the target images (the installation's own unless test mode), and the tag. */
export type DockerImages = { registry: string; organization: string; tag: string };

/** Files of the release itself the upgrade writes into the install directory (tracked in a clone). */
export const RELEASE_FILES = [
  'docker/docker-compose.yml',
  'services/gateway/.env.sample',
  'services/admin/.env.sample',
  'services/ollama/.env.sample',
  'services/gateway/api_config.json',
  'services/admin/api_config.json',
];

/** Loads the kit's scripts from its temp copy; setup-docker.js reads its flags when loaded. */
export function loadDockerKit(root: string): DockerKit {
  const argv = process.argv;
  process.argv = [argv[0], path.join(root, 'docker', 'setup-docker.js')];
  try {
    const at = (...p: string[]) => require(path.join(root, ...p));
    const db = at('cli-tools', 'kyma-db-manager.js');
    return {
      root,
      DockerSetup: at('docker', 'setup-docker.js'),
      PromptSession: at('docker', 'setup-flow', 'session.js').PromptSession,
      onlyNewPromptFn: at('docker', 'setup-flow', 'onlyNew.js').onlyNewPromptFn,
      installRecord: at('docker', 'setup-flow', 'install-record.js'),
      localConfig: at('kyma', 'scripts', 'local-config-snapshot.js'),
      builders: {
        buildPgDumpCommand: db.buildPgDumpCommand,
        buildRestorePsqlCommand: db.buildRestorePsqlCommand,
        dumpRelations: db.dumpRelations,
        buildDropRelationsStatement: db.buildDropRelationsStatement,
        createRestoreLineFilter: db.createRestoreLineFilter,
        assertCompleteDump: at('cli-tools', 'kyma-pod-files.js').assertCompleteDump,
      },
    };
  } finally {
    process.argv = argv;
  }
}

/**
 * Every file the upgrade (setup-docker.js and the release files) may write or delete in the
 * install directory, relative and with '/', plus every other docker/.env* file and the record.
 */
export function managedFiles(kit: DockerKit, dir: string): string[] {
  const out = new Set<string>([
    ...kit.localConfig.dockerSetupOutputs(dir),
    ...RELEASE_FILES,
    'docker/nginx.conf',
    `docker/${kit.installRecord.INSTALL_RECORD_FILE}`,
  ]);
  const docker = path.join(dir, 'docker');
  if (fs.existsSync(docker)) for (const name of fs.readdirSync(docker)) if (/^\.env/.test(name)) out.add(`docker/${name}`);
  return [...out].sort();
}

/** A DockerSetup on the install directory with the kit's templates, kept away from volumes and pulls. */
function newSetup(kit: DockerKit, dir: string): any {
  const setup = new kit.DockerSetup({});
  setup.configsDir = path.join(kit.root, 'docker', 'configs');
  setup.dockerDir = path.join(dir, 'docker');
  setup.projectRoot = dir;
  setup.checkExistingVolumes = () => [];
  setup.deleteVolumes = () => { throw new Error('upgrade never deletes volumes'); };
  setup.detectArchitecture = () => ({ isAppleSilicon: false, isARM64: false, isAMD64: true });
  // The summary would list docker volumes and offer a pull: neither belongs in an upgrade
  setup.showCompletion = async () => {};
  return setup;
}

/** Asks only what is new; writes nothing. */
export async function collectDockerAnswers(o: {
  kit: DockerKit; dir: string; images: DockerImages; prompt: PromptOne; adjustSetup?: (setup: any) => void;
}): Promise<{ setup: any; answers: any }> {
  const { kit, images } = o;
  const setup = newSetup(kit, o.dir);
  if (o.adjustSetup) o.adjustSetup(setup);
  setup.currentSecrets = await setup.loadCurrentSecrets();
  const current = await setup.loadCurrentValues();
  // Answers no file holds, or that the upgrade decides: registry images at the target coordinates,
  // no setup backup (the upgrade backs up), no pull by setup, the database password kept.
  const extras: Record<string, unknown> = {
    imageMode: 'registry', registry: images.registry, organization: images.organization,
    createBackup: false, pullImages: false, deleteVolumes: false,
  };
  if (setup.currentSecrets.POSTGRES_PASSWORD) extras.POSTGRES_PASSWORD = true;
  // Not set means the application default, and answering that default writes nothing
  if (current.SAP_BILLING_CURRENCY === undefined) extras.SAP_BILLING_CURRENCY = 'USD';
  if (current.INSTALLED_PLUGINS_ENABLED === undefined) extras.INSTALLED_PLUGINS_ENABLED = true;
  const session = new kit.PromptSession({ promptFn: async () => { throw new Error('asked before the session was ready'); }, current });
  const view = new Proxy({}, {
    get: (_t, key) => (typeof key === 'string' && key in extras ? extras[key] : session.current[key as string]),
  }) as Record<string, unknown>;
  session.promptFn = kit.onlyNewPromptFn(o.prompt, view);
  let answers;
  try {
    answers = await session.run((s: unknown) => setup.collectAnswers(s));
  } finally {
    setup.session = null;
  }
  if (current.provider !== undefined && answers.provider !== current.provider) {
    throw new Error(`The login provider would change (${current.provider} → ${answers.provider}); an upgrade keeps it.`);
  }
  return { setup, answers };
}

/** Writes the release files from the kit, then the answers with the target images (no record). */
export async function applyDockerAnswers(kit: DockerKit, setup: any, answers: any, images: DockerImages): Promise<void> {
  for (const rel of RELEASE_FILES) {
    const target = path.join(setup.projectRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(kit.root, ...rel.split('/')), target);
  }
  await setup.applyAnswers({
    ...answers,
    imageMode: 'registry', registry: images.registry, organization: images.organization, imageTag: images.tag,
    createBackup: false, deleteVolumes: false, pullImages: false, regenerateKeys: [], providerChange: null,
    skipInstallRecord: true,
  });
}

/** The record the upgrade writes last: target version, public answers, sha256 of the release files. */
export function recordUpgrade(kit: DockerKit, dir: string, answers: any, images: DockerImages, sha256: (b: Buffer) => string): void {
  const files: Record<string, string> = {};
  for (const rel of RELEASE_FILES) {
    const file = path.join(dir, ...rel.split('/'));
    if (fs.existsSync(file)) files[rel] = sha256(fs.readFileSync(file));
  }
  kit.installRecord.writeInstallRecord(path.join(dir, 'docker'), {
    version: images.tag,
    answers: kit.installRecord.recordDockerAnswers({ ...answers, imageMode: 'registry', registry: images.registry, organization: images.organization }),
    recordedBy: 'upgrade',
    files,
  });
}
