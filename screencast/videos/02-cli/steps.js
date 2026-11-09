// Deploy with the CLI: casts only, with the deployment overview page as the last picture.
// The waits after the casts hold the last frame while the narration of the section finishes.
const DOCS = 'http://localhost:4173/sail-proxy';

export default async ({ section, goto, wait, caption, cast }) => {
  await section(1); await caption('Install from npm'); await cast('install'); await wait(12000);
  await section(2); await caption('The setup: service key, resource group, port'); await cast('configure'); await wait(21000);
  await section(3); await caption('Run and check'); await cast('run'); await wait(4000);
  await section(4); await caption('Create a key'); await cast('apikey'); await wait(6000);
  await section(5); await caption('sail-proxy claude'); await cast('claude'); await wait(18000);
  await section(6); await caption('Status and logs'); await cast('status');
  await goto(`${DOCS}/deploy/overview`); await caption('Next: Docker Compose and Kyma'); await wait(8000);
};
