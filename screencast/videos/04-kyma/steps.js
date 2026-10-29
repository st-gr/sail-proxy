// Deploy on SAP BTP Kyma: the Kyma page, the four terminal casts, the public cockpit on the real host with the
// overlay active (the host is replaced on screen), the teardown cast, the production checklist.
const DOCS = 'http://localhost:4173/sail-proxy';
const HOST = process.env.SAIL_DOCS_KYMA_HOST || 'sail-proxy-test.sail.example.com';
const SHELL = `https://${HOST}/admin/app/shell/?sap-language=en&sap-theme=sap_horizon`;

export default async ({ section, goto, click, type, wait, mark, caption, cast }) => {
  await section(1);
  await goto(`${DOCS}/deploy/kyma`);
  await caption('The Kyma deployment');
  await wait(9000);
  await click('text=Architecture');
  await wait(9000);

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

  await section(6);
  await caption('Tear the test namespace down');
  await cast('cleanup');
  await goto(`${DOCS}/deploy/kyma`);
  await click('text=Production checklist');
  await caption('Next: the production checklist and the cockpit deep dive');
  await wait(6000);
};
