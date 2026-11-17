// Deploy with Docker Compose: documentation page, the service key in the BTP cockpit (clip), setup and start
// (casts), the real sign-in through nginx and Dex on port 8080, a key created in the cockpit, the call (cast),
// the usage page scrolled through, the deployment overview.
// The sign-in uses the local test account the setup prints (admin@example.com); the cockpit is then the real
// one behind oauth2-proxy, not the header proxy.
import setupAndStart from './setup-take.steps.js';
import { signInAndCall } from './signin-take.steps.js';

const DOCS = 'http://localhost:4173/sail-proxy';
const STACK = 'http://localhost:8080';
const SHELL = `${STACK}/admin/app/shell/?sap-language=en&sap-theme=sap_horizon`;

export default async (api) => {
  const { section, goto, click, type, wait, hold, mark, caption, cast, scroll, end } = api;
  // Sections 1 and 2 (the page, the service key, the setup and the start) live in their own file, taken on their own.
  await setupAndStart(api);

  // Sections 3 and 4 (the sign-in, a key, the call) live in their own file, taken on their own.
  await signInAndCall(api);

  await section(5);
  await goto(SHELL);
  await click('nav=Usage > Analytics');
  await caption('Usage Analytics: the call has landed');
  await wait(5000);
  await scroll(500);
  await caption('Requests per provider, response time against cost, per-provider details');
  await wait(4000);
  await scroll(500);
  await wait(5000);
  await goto(`${DOCS}/deploy/overview`);
  await caption('Next: the same stack on SAP BTP Kyma');
  await wait(10000); // the closing sentence runs over this page; the clip ends here
  await end();
  // Off camera: leave the demo data as it was, delete the key this run created.
  await goto(SHELL);
  await click('nav=API Keys > Access');
  await click('text=Docker video key');
  await click('text=Delete');
  await click('role=button:Delete');
  await wait(1500);
};
