// Deploy on SAP BTP Kyma: the Kyma page, the four terminal casts, the public cockpit on the real host with the
// overlay active (the host is replaced on screen), the teardown cast, the production checklist.
import kymaPage from './page-take.steps.js';
import cleanupAndNext from './cleanup-take.steps.js';

const DOCS = 'http://localhost:4173/sail-proxy';
const HOST = process.env.SAIL_DOCS_KYMA_HOST || 'sail-proxy-test.sail.example.com';
const SHELL = `https://${HOST}/admin/app/shell/?sap-language=en&sap-theme=sap_horizon`;

export default async (api) => {
  const { section, goto, click, type, wait, mark, caption, cast } = api;
  // Section 1 (the Kyma page) lives in its own file, taken on its own.
  await kymaPage(api);

  await section(2);
  await caption('Prerequisites');
  await cast('prereqs');

  await section(3);
  await caption('setup-kyma.js --namespace sail-proxy-test');
  await cast('setup');

  await section(4);
  await caption('deploy-kyma.js --namespace sail-proxy-test');
  await cast('deploy');
  await caption('Pods, VirtualService and health');
  await cast('rollout');

  await section(5);
  await goto(`https://${HOST}/`);
  await caption('The sign-in page on the public host');
  await wait(2500);
  await type('#login', 'admin@example.com');
  await type('#password', 'admin123');
  await click('#submit-login');
  await wait(2500);
  await mark('signed in');
  await goto(SHELL);
  await caption('The Admin Cockpit on Kyma');
  await wait(6000);
  await click('nav=API Keys > Access');
  await caption('A fresh namespace: no keys yet');
  await wait(5000);
  await goto(`${DOCS}/deploy/authentication#github-oauth`);
  await caption('A GitHub sign-in: the OAuth App registration');
  await wait(9000);

  // Section 6 (the teardown and the production checklist) lives in its own file, taken on its own.
  await cleanupAndNext(api);
};
