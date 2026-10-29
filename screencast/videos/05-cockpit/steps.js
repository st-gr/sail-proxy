// Cockpit deep dive, as the admin through the header proxy. The Create page leaves a draft; it is discarded
// at the end of section 1 so the demo data stays as seeded. Section 4 needs the seeded team "Platform team"
// and images built after Teams Part B.
const SHELL = '/admin/app/shell/?sap-language=en&sap-theme=sap_horizon';

export default async ({ section, goto, click, type, wait, hold, caption, scroll, end }) => {
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

  await section(7);
  await click('nav=Configuration Management > Settings');
  await caption('Configuration versions');
  await wait(6000);
  await click('text=Active');
  await click('text=Providers');
  await caption('The active configuration: providers, substitutions, streaming');
  await wait(8000);
  await click('text=Observability');
  await caption('Pseudonymization: personal data masked before a request leaves, restored in the answer');
  await wait(5000);
  await scroll(450, { ms: 2500, x: 1600 }); // the entity categories, each with its own switch
  await wait(4000);
  await caption('Observability: SIEM sinks for the security and usage events');
  await scroll(1400, { ms: 3500, x: 1600 }); // on to the SIEM panel and its sinks
  await wait(8000);
  await click('nav=Security Notifications > Analytics');
  await caption('Failed authentications and other security events');
  await wait(8000);
  await click('[id$="--profileAvatar"]');
  await click('[id$="--settingsButton"]');
  await caption('Settings: theme and language');
  await wait(2000);
  await click('[id$="--settingsTheme"]');
  await click('text=Dark');
  await click('[id$="--settingsSave"]'); // the theme changes live
  await caption('The dark theme');
  await wait(6000);
  await click('[id$="--profileAvatar"]');
  await click('[id$="--settingsButton"]');
  await click('[id$="--settingsLanguage"]');
  await click('text=Deutsch');
  // Set before the reload: the runner shows it again on the reloaded page (a caption set after it never showed).
  await caption('The cockpit in German, one of seven languages');
  await click('[id$="--settingsSave"]'); // a changed language reloads the cockpit
  await wait(12000);
  await end();
  // Off camera: back to Light and English for the admin (both are stored per user on the server).
  await click('[id$="--profileAvatar"]');
  await click('[id$="--settingsButton"]');
  await click('[id$="--settingsTheme"]');
  await click('text=Hell');
  await click('[id$="--settingsLanguage"]');
  await click('text=English');
  await click('[id$="--settingsSave"]');
  await wait(5000);
};
