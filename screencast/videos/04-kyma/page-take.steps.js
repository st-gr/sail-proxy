// Section 1 of the Kyma video, taken on its own (`node record.js 04-kyma --steps page-take --first-section 1`, then
// the clip and its timing copied over section 1) and played by steps.js: the Kyma page with the deployment panel.
const DOCS = 'http://localhost:4173/sail-proxy';

export default async ({ section, goto, wait, caption, scroll }) => {
  await section(1);
  await goto(`${DOCS}/deploy/kyma`);
  await caption('The Kyma deployment');
  await wait(9000);
  await scroll(300, { ms: 2500, x: 960 }); // the whole panel stays in view, the services table comes up below it
  await wait(9000);
};
