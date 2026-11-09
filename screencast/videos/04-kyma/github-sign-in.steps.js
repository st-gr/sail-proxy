// The GitHub sign-in of the Kyma video's section 5, recorded on the local demo stack with the GitHub connector
// (stack/compose.github.yml) and spliced into out/04-kyma/clips/section-5.mp4 (see the README): the same Dex,
// oauth2-proxy and cockpit as on Kyma; no address bar is on screen. GitHub's Authorize page shows only until the
// app is authorized, so revoke the "sail-proxy demo" app under GitHub Settings → Applications before each take.
// Record with SAIL_DOCS_BROWSER_PROFILE=screencast/out/browser-profile (signed in to GitHub by
// stack/browser-login.mjs) and `node record.js 04-kyma --steps github-sign-in --first-section 5`.
const STACK = 'http://localhost:8080';

export default async ({ section, goto, click, wait, caption, hold, end }) => {
  await section(5);
  // Through the sign-out, so a session left by an earlier take does not skip the sign-in page.
  await goto(`${STACK}/oauth2/sign_out?rd=%2F`);
  await caption('A GitHub sign-in: GitHub next to the local accounts');
  await wait(3000);
  await click('text=Log in with GitHub');
  await caption('GitHub asks once to authorize the app');
  await wait(4000);
  await click('button[data-octo-click="oauth_application_authorization"]');
  await wait(2000);
  // Set before the last click: the redirect lands in the cockpit and the runner shows the caption again on load (a
  // caption set after navigating to the cockpit never reached the picture).
  await caption('Signed in through GitHub: the team\'s admins are cockpit admins');
  // Dex asks once per sign-in to share the profile with oauth2-proxy (no skipApprovalScreen in the local config).
  await click('role=button:Grant Access');
  await hold(6000);
  await end();
};
