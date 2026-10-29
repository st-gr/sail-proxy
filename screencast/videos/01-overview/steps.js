// Overview: the documentation home, the deployment overview, a walk through the cockpit as the admin (with the
// Deploy dialog cancelled), one call (cast), its usage row and the Cost tab, then the pages to go to next.
const DOCS = 'http://localhost:4173/sail-proxy';
const SHELL = '/admin/app/shell/?sap-language=en&sap-theme=sap_horizon';

export default async ({ section, goto, click, hover, press, wait, caption, cast, scroll }) => {
  await section(1);
  await goto(`${DOCS}/`);
  await caption('One gateway between your tools and SAP AI Core');
  await wait(24000);
  await press('End');
  await caption('Pick your path');
  await wait(30000);

  await section(2);
  await goto(`${DOCS}/deploy/overview`);
  await caption('Standalone CLI, Docker Compose or SAP BTP Kyma');
  await wait(22000);

  await section(3);
  await goto(SHELL);
  await caption('The Admin Cockpit');
  await wait(4000);
  await click('nav=API Keys > Access');
  await caption('API keys per user');
  await wait(6000);
  await click('nav=Usage > Analytics');
  await caption('Usage Analytics');
  await wait(4000);
  await scroll(1000, { ms: 4000 });
  await wait(5000);
  await click('nav=Model Library > Models');
  await caption('The Model Library');
  await wait(4000);
  // Deploy only opens SAP's confirmation; Cancel closes it, nothing is deployed.
  await click('text=Gemini 3 Pro Image');
  await click('[id$="--deployButton"]');
  await caption('Deploy a model straight from the cockpit');
  await wait(5000);
  await click('role=button:Cancel');
  await wait(1000);
  await click('nav=Entitlements & Quotas > Models');
  await caption('Entitlements and quotas');
  await wait(6000);
  await click('nav=Tool Governance > Settings');
  await caption('Tool Governance');
  await wait(4000); // the list settles first; 05 waits as long and its inventory opens at once
  await click('text=Open Tool Inventory');
  // The inventory can take a few seconds the first time; hover() waits for its Back button, so the hold starts
  // only once the inventory is on screen.
  await hover('text=Back to Tool Policies');
  await caption('The tool inventory: every tool the clients sent');
  await wait(5000);
  await click('text=Back to Tool Policies');
  await click('text=Default developer policy');
  await caption('A tool policy: allow and deny lists by pattern');
  await wait(7000);
  await click('nav=Vector Stores > Grounding');
  await caption('Grounding: hosted file search');
  await wait(6000);

  await section(4);
  await caption('One call through the gateway');
  await cast('call');
  await goto(SHELL);
  await click('nav=Usage > Analytics');
  await caption('The call in Usage Analytics');
  await wait(6000);
  await click('text=Cost');
  await caption('The Cost tab: per model, SAP billing per key, per user and per team');
  await wait(3000);
  await scroll(1400, { ms: 5000 });
  await wait(5000);

  await section(5);
  await goto(`${DOCS}/guide/quick-start`);
  await caption('Quick start');
  await wait(7000);
  await goto(`${DOCS}/deploy/overview`);
  await caption('Deployment options');
  await wait(6000);
  await goto(`${DOCS}/guide/clients/claude-code`);
  await caption('One page per client');
  await wait(7000);
};
