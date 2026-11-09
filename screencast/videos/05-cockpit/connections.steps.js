// Section 8, Connections, recorded on its own (record.js 05-cockpit --steps connections --first-section 8) and
// appended to the cockpit video. Needs `seed.js --connections --spend` with the provider env files and two SAP AI Core
// keys (SAIL_DOCS_SAP_KEYS), then redact.local.json refreshed: every real endpoint, tenant, client id, key and
// credential hint is masked in the page before it is drawn. Run frame-check.mjs on the clip before using it.
const SHELL = '/admin/app/shell/?sap-language=en&sap-theme=sap_horizon';

export default async ({ section, goto, click, wait, hold, caption, scroll, end }) => {
  await section(8);
  await goto(SHELL);
  await click('nav=Connections > Settings');
  await caption('Connections: your own provider accounts next to SAP AI Core');
  await wait(9000);
  await click('text=Azure OpenAI');
  await caption('Only the settings this provider needs; the credential shows as a hint only');
  await wait(6000);
  await scroll(700, { ms: 3000 });
  await wait(4000);
  await click('text=Test Connection');
  await caption('Test Connection'); // short, so the result toast in the middle stays clear
  await wait(6000);
  await click('text=Add Model');
  await caption('Add Model: a picker filled from the provider\'s own list');
  await wait(2500);
  await click('[id$="--upstream-arrow"]'); // the provider's deployments
  await wait(5000);
  await click('text=Cancel');
  await wait(3000); // the models table with its price is already in view; scrolling on would hide it
  await caption('A list price per 1K tokens; only a priced model can be published, as <model>--<connection>');
  await wait(12000);
  await caption('The same plugins as SAP traffic; quotas and team pools count its cost');
  await wait(8000);
  await click('nav=Usage > Analytics');
  await caption('Connections cost beside SAP cost');
  await wait(5000);
  await click('text=Cost');
  await scroll(2450, { ms: 5000 }); // past the SAP billing panel to the Connections spend panel
  await caption('Spend by connection');
  await wait(6000);
  await click('nav=Connections > Settings');
  await click('text=SAP AI Core (tenant B)');
  await caption('SAP AI Core tenants as connections');
  await wait(4000);
  await click('text=Activate');
  await caption('Activate: every gateway switches tenant without a restart');
  await wait(3000);
  await click('role=button:Activate');
  await wait(5000);
  await click('nav=Usage > Analytics');
  await click('text=Cost');
  await click('[id$="--tenantScopeSelect"]');
  await caption('SAP cost per tenant');
  await wait(3000);
  await click('text=demo-tenant-b.us10');
  await wait(7000);
  await hold(2000);
  await end();
  // Off camera: the installation's own tenant is the active one again, and the filter back to all tenants.
  await click('[id$="--tenantScopeSelect"]');
  await click('text=All tenants');
  await click('nav=Connections > Settings');
  await click('text=SAP AI Core (installation)');
  await click('text=Activate');
  await click('role=button:Activate');
  await wait(5000);
};
