// Section 6 of the Kyma video, taken on its own (`node record.js 04-kyma --steps cleanup-take --first-section 6`, then
// the clip and its timing copied over section 6) and played by steps.js: the teardown cast (recorded earlier) and the
// Kyma page's production checklist.
const DOCS = 'http://localhost:4173/sail-proxy';

export default async ({ section, goto, wait, caption, cast, scroll }) => {
  await section(6);
  await caption('Tear the test namespace down');
  await cast('cleanup');
  await goto(`${DOCS}/deploy/kyma#production-checklist`); // the outline is empty until the page scrolls: open the section directly
  await scroll(380, { ms: 2000, x: 960 }); // the checklist up into view
  await caption('Next: the production checklist and the cockpit deep dive');
  await wait(20000); // the closing sentence runs over this page
};
