// Deploy with Docker Compose: documentation page, the service key in the BTP cockpit (clip), setup and start
// (casts), the real sign-in through nginx and Dex on port 8080, a key created in the cockpit, the call (cast),
// the usage page scrolled through, the deployment overview.
// The sign-in uses the local test account the setup prints (admin@example.com); the cockpit is then the real
// one behind oauth2-proxy, not the header proxy.
const DOCS = 'http://localhost:4173/sail-proxy';
const STACK = 'http://localhost:8080';
const SHELL = `${STACK}/admin/app/shell/?sap-language=en&sap-theme=sap_horizon`;

export default async ({ section, goto, click, type, wait, hold, mark, caption, cast, play, scroll, end }) => {
  await section(1);
  await goto(`${DOCS}/deploy/docker`);
  await caption('The Docker Compose deployment');
  await wait(9000);
  await click('text=Architecture');
  await wait(8000);

  await section(2);
  // The BTP cockpit clip is cut from an earlier recording with a fake key; it is not in git (see the README).
  await caption('The service key: SAP BTP cockpit, your SAP AI Core instance, Copy JSON');
  await play('btp-service-key', { title: 'SAP BTP cockpit' });
  await wait(9000); // the prerequisites run over the copied key
  await caption('Prerequisites and the setup script');
  await cast('setup');
  await wait(14000); // what --ci means, and what the script asks without it
  await caption('Start the stack');
  await cast('up');
  await hold(3000); // the health answer is the cast's last line: let it be read

  await section(3);
  await goto(`${STACK}/`);
  await caption('nginx sends you to the Dex sign-in page');
  await wait(2500);
  await type('#login', 'admin@example.com');
  await type('#password', 'admin123');
  await click('#submit-login');
  // Dex asks once per sign-in to share the profile with oauth2-proxy (no skipApprovalScreen in the local config).
  await click('role=button:Grant Access');
  await wait(2500);
  await mark('signed in');
  await goto(SHELL);
  await caption('The Admin Cockpit');
  await wait(5000);

  await section(4);
  await click('nav=API Keys > Access');
  await caption('API Keys');
  await wait(2000);
  await click('text=Create');
  await caption('Create a key');
  await type('input[id$="::name::Field-edit-inner"]', 'Docker video key');
  await type('input[id$="::email::Field-edit-inner"]', 'admin@example.com');
  await mark('name typed');
  await click('text=Create');
  await wait(2500);
  await mark('key created');
  await caption('The full key stays on its page; Copy API Key copies it');
  await wait(4000);
  await cast('call');
  await hold(5000); // the model's answer is the cast's last output: let it be read

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
