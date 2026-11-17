// Section 3 of the Kyma video alone (the setup cast), for a re-take after the setup's questions changed, without
// the live namespace the other sections need. `node record.js 04-kyma --steps setup-take --first-section 3`
// writes out/04-kyma/setup-take/clips/section-3.mp4; copy it over out/04-kyma/clips/section-3.mp4.
export default async ({ section, caption, cast }) => {
  await section(3);
  await caption('setup-kyma.js --namespace sail-proxy-test');
  await cast('setup');
};
