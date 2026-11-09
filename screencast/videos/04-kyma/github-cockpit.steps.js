// The cockpit after the GitHub sign-in (github-sign-in.steps.js ends on Dex's Grant Access, whose redirect does
// not repaint in the recording): recorded right after it with the same profile, which now holds the session, and
// spliced behind it. `node record.js 04-kyma --steps github-cockpit --first-section 5`.
const SHELL = 'http://localhost:8080/admin/app/shell/?sap-language=en&sap-theme=sap_horizon';

export default async ({ section, goto, caption, hold, end }) => {
  await section(5);
  await goto(SHELL);
  await caption('Signed in through GitHub: the team\'s admins are cockpit admins');
  await hold(6000);
  await end();
};
