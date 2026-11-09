// The checks of `sail-proxy upgrade docker` before anything is stopped: what is installed (read)
// and whether the run can succeed and be rolled back (preflight). Each failure is a Refusal.
import * as fs from 'fs';
import * as path from 'path';
import { CommandRunner } from './kubectl';
import { Refusal, checkVersions } from './kymaChecks';
import { ImageTarget, PromptOne } from './kymaRender';
import { UpgradePolicy } from './kit';
import { ComposeTarget, composeArgs, imageEnv, composeFiles, databaseSize, findComposeProject, overrideBuildsLocally, projectContainers, trackedChanges } from './dockerHost';
import { DockerImages, DockerKit } from './dockerRender';
import { backupSpaceNeeded } from './kymaChecks';

export const OWN_SERVICES = ['admin', 'gateway', 'nginx'];
const MB = 1024 * 1024;
const firstLine = (e: unknown) => String((e as { stderr?: string })?.stderr || (e as Error)?.message || '').trim().split('\n')[0];

export type DockerInstallation = {
  target: ComposeTarget;
  from: string;
  images: DockerImages;
  /** of admin, gateway, nginx: the services running now (the rollback starts these again) */
  running: string[];
  /** every long-running service running now except postgres: admin, gateway, nginx first, then the rest sorted */
  services: string[];
  /** the running images' coordinates (tag null when pinned by digest) */
  previousImages: { registry: string; organization: string; tag: string | null };
};

/** registry and organization of a `<registry>/<organization>/sail-proxy-gateway:<tag>` image, and its tag. */
export function parseImage(image: string): { registry: string; organization: string; tag: string | null } | null {
  const m = /^(.+)\/sail-proxy-gateway(?::([^@/]+))?(?:@sha256:[0-9a-f]+)?$/.exec(image);
  if (!m) return null;
  const parts = m[1].split('/');
  // docker.io short form: "<organization>/sail-proxy-gateway"
  const hasRegistry = parts.length > 1 && /[.:]|^localhost$/.test(parts[0]);
  return { registry: hasRegistry ? parts[0] : 'docker.io', organization: (hasRegistry ? parts.slice(1) : parts).join('/'), tag: m[2] || null };
}

/** Step `read`: the compose project, installed version and images; refuses what cannot be upgraded. */
export async function readDockerInstallation(o: {
  docker: CommandRunner; git: CommandRunner; kit: DockerKit; dir: string; policy: UpgradePolicy;
  target: ImageTarget; testMode: boolean; prompt: PromptOne;
}): Promise<DockerInstallation> {
  const { dir, policy } = o;
  if (!fs.existsSync(path.join(dir, 'docker', 'docker-compose.yml'))) {
    throw new Refusal(`${dir} is no Docker install directory (no docker/docker-compose.yml). Pass --dir <the clone the installation was set up from>.`);
  }
  if (overrideBuildsLocally(dir)) {
    throw new Refusal('This installation is built locally (docker/docker-compose.override.yml builds the images); `upgrade` installs release images only. Update a local build with git and setup-docker.js.');
  }
  const record = o.kit.installRecord.readInstallRecord(path.join(dir, 'docker'));
  if (fs.existsSync(path.join(dir, '.git'))) {
    const changes = await trackedChanges(o.git, dir, (record && record.files) || {});
    if (changes.length > 0) {
      throw new Refusal(`The install directory has local changes to tracked files (${changes.slice(0, 5).join(', ')}${changes.length > 5 ? ', …' : ''}); the upgrade would overwrite them. Commit or revert them, then run the upgrade again.`);
    }
  }
  if (policy.storageLayoutChange) {
    throw new Refusal('This release changes the layout of file storage or Valkey data; it cannot be installed by `upgrade`. See its release notes.');
  }
  const project = await findComposeProject(o.docker, dir);
  const containers = (await projectContainers(o.docker, project)).filter((c) => !c.oneoff);
  const postgres = containers.find((c) => c.service === 'postgres');
  if (!postgres || postgres.image !== policy.postgresImage) {
    throw new Refusal(`The installation runs Postgres image ${postgres ? postgres.image : '(none)'}, this release needs ${policy.postgresImage}; a Postgres image change is not done by \`upgrade\`.`);
  }
  const gateway = containers.find((c) => c.service === 'gateway');
  const parsed = gateway ? parseImage(gateway.image) : null;
  if (!parsed) throw new Refusal(`Compose project ${project} holds no sail-proxy gateway container from a registry image.`);

  let from: string = (record && record.version) || parsed.tag || '';
  if (!from) {
    from = String(await o.prompt({
      type: 'input', name: 'installedVersion', id: 'installedVersion', noBack: true,
      message: 'The installed images are pinned by digest. Which sail-proxy version is installed (e.g. 0.11.0)?',
      validate: (v: string) => (String(v).trim() ? true : 'A version is required'),
    })).trim();
  }
  checkVersions(from, o.target.tag, policy, o.testMode);
  const images: DockerImages = {
    registry: o.target.registry || parsed.registry,
    organization: o.target.organization || parsed.organization,
    tag: o.target.tag,
  };
  const up = containers.filter((c) => c.state === 'running' && c.service !== 'postgres').map((c) => c.service);
  const running = OWN_SERVICES.filter((s) => up.includes(s));
  const services = [...running, ...[...new Set(up)].filter((s) => !OWN_SERVICES.includes(s)).sort()];
  return {
    target: { project, dir, files: composeFiles(dir) }, from, images, running, services,
    previousImages: { registry: parsed.registry, organization: parsed.organization, tag: parsed.tag },
  };
}

/** Step `preflight`: the new compose file validates, the target images pull, no one-off runs, disk space. */
export async function preflightDocker(o: {
  docker: CommandRunner; kit: DockerKit; installed: DockerInstallation; backupDir: string;
  statfs: (dir: string) => Promise<number>; log: (m: string) => void;
}): Promise<void> {
  const { docker, installed } = o;
  const t = installed.target;
  const env = imageEnv(installed.images);
  const releaseCompose = { ...t, files: [path.join(o.kit.root, 'docker', 'docker-compose.yml'), ...t.files.slice(1)] };
  try {
    await docker(composeArgs(releaseCompose, ['config', '--quiet']), { env });
  } catch (error) {
    throw new Refusal(`The release's compose file does not validate against this installation (${firstLine(error)}). Nothing was changed.`);
  }
  o.log(`Pulling ${installed.images.registry}/${installed.images.organization}/sail-proxy-*:${installed.images.tag} (the installation keeps running)...`);
  try {
    await docker(composeArgs(t, ['pull', 'gateway', 'admin', 'nginx']), { env });
  } catch (error) {
    throw new Refusal(`The target images cannot be pulled (${firstLine(error)}). Log in to the registry (docker login), then run the upgrade again. Nothing was changed.`);
  }
  const oneoffs = (await projectContainers(docker, t.project, true)).filter((c) => c.state === 'running');
  if (oneoffs.length > 0) {
    throw new Refusal(`A one-off container of the installation is running (${oneoffs.map((c) => c.service).join(', ')}, e.g. a rebuild-index run). Wait for it to finish, then run the upgrade again.`);
  }
  const size = await databaseSize(docker, t);
  const need = backupSpaceNeeded(size);
  const free = await o.statfs(o.backupDir);
  if (free < need) {
    throw new Refusal(`Not enough free space for the backup in ${o.backupDir}: ${Math.ceil(need / MB)} MB needed (3 × the ${Math.ceil(size / MB)} MB database plus 100 MB), ${Math.floor(free / MB)} MB free.`);
  }
}
