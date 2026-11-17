// Sections 1 and 2 of the Docker video, taken on their own (`node record.js 03-docker-compose --steps setup-take
// --first-section 1`, then the clips and their timing copied over sections 1 and 2) and played by steps.js: the
// Docker page with the deployment panel, the service key, the interactive setup cast and the start.
const DOCS = 'http://localhost:4173/sail-proxy';

export default async ({ section, goto, wait, hold, caption, cast, play, scroll }) => {
  await section(1);
  await goto(`${DOCS}/deploy/docker`);
  await caption('The Docker Compose deployment');
  await wait(9000);
  await scroll(300, { ms: 2500, x: 960 }); // the whole panel stays in view, the table of paths comes up below it
  await wait(8000);

  await section(2);
  // The BTP cockpit clip is cut from an earlier recording with a fake key; it is not in git (see the README).
  await caption('The service key: SAP BTP cockpit, your SAP AI Core instance, Copy JSON');
  await play('btp-service-key', { title: 'SAP BTP cockpit' });
  await wait(9000); // the prerequisites run over the copied key
  await caption('Prerequisites and the setup script');
  await cast('setup');
  await wait(9000); // the service key can be replaced later in the cockpit
  await caption('Start the stack');
  await cast('up');
  await hold(3000); // the health answer is the cast's last line: let it be read
};
