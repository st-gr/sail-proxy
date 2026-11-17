// Cockpit deep dive, as the admin through the header proxy. The Create page leaves a draft; it is discarded
// at the end of section 1 so the demo data stays as seeded. Section 4 needs the seeded team "Platform team"
// and images built after Teams Part B.
import configAndOperations from './config-take.steps.js';

const SHELL = '/admin/app/shell/?sap-language=en&sap-theme=sap_horizon';

export default async (api) => {
  const { section, goto, click, type, wait, hold, caption, scroll } = api;
  await section(1);
  await goto(SHELL);
  await click('nav=API Keys > Access');
  await caption('API Keys: every user their own');
  await wait(8000);
  await click('text=Create');
  await caption('Create: a name and the user; the expiry defaults to 90 days');
  await wait(8000);
  await click('text=Discard Draft');
  await caption('Active flag and expiry date per key');
  await wait(14000);

  await section(2);
  await click('nav=Usage > Analytics');
  await caption('Usage Analytics: tokens and cost, this month');
  await wait(5000);
  await scroll(900, { ms: 3000 });
  await caption('Requests per provider, response time against cost, per-provider details');
  await wait(5000);
  await click('text=Cost');
  await caption('Cost per model, SAP billing per key, cost per user and per team');
  await wait(3000);
  await scroll(1400, { ms: 5000 });
  await wait(4000);
  await click('text=Performance');
  await caption('Response time and error rates');
  await wait(8000);
  await click('text=Models');
  await caption('Usage by model');
  await wait(8000);
  await click('nav=SAP Capacity Unit Prices > Settings');
  await caption('SAP capacity-unit rates turn cost factors into money');
  await wait(10000);

  await section(3);
  await click('nav=Entitlements & Quotas > Models');
  await click('text=Quota profiles');
  await caption('Quota profiles');
  await wait(3000);
  await click('text=Standard team');
  await caption('A quota profile: request, token and spend limits, and who it is assigned to');
  await wait(12000);
  await click('nav=Users & Quotas > Settings');
  await caption('Users: status, spend and tokens this month');
  await wait(10000);

  await section(4);
  await click('nav=Teams > Settings');
  await caption('Teams: a shared pool and a member profile');
  await wait(8000);
  await click('text=Platform team');
  await caption('Pool, member profile, entitlement and tool policy');
  await wait(12000);
  // The members table loads when its anchor tab is clicked; scrolling to it leaves it empty. The caption goes
  // first: set after this click, it never reached the picture (two recordings).
  await caption('The members: a team admin and two members');
  await click('[id$="--fe::FacetSection::Members-anchor-text"]');
  await wait(10000);

  await section(5);
  await click('nav=Tool Governance > Settings');
  await caption('Tool policies');
  await wait(4000);
  await click('text=Open Tool Inventory');
  await caption('The tool inventory: every tool the clients sent, with its outcome');
  await wait(12000);
  await click('text=Back to Tool Policies');
  await click('text=Default developer policy');
  await caption('Allow and deny lists by pattern; this one only records');
  await wait(16000);

  await section(6);
  await click('nav=Vector Stores > Grounding');
  await caption('Vector stores');
  await wait(8000);
  await click('text=Team handbook');
  await caption('A store: files, details, test retrieval');
  await wait(6000);
  await click('text=Test Retrieval');
  await type('textarea[id$="--searchQueryInput-inner"]', 'What should a new engineer do in the first week?');
  await click('[id$="--searchButton"]');
  await caption('Test retrieval: the passages an agent would receive, ranked');
  await wait(14000);
  await click('nav=Files > Grounding');
  await caption('Files and the stores they are in');
  await wait(9000);
  await hold(3000); // the narration ends before the section does: keep the page on screen

  // Section 7 (configuration, logs, security notifications, settings) lives in its own file, taken on its own.
  await configAndOperations(api);
};
