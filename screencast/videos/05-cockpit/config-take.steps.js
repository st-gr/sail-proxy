// Section 7, Configuration and operations, recorded on its own (`node record.js 05-cockpit --steps config-take
// --first-section 7`, then the clip and its timing copied over section 7) and played by steps.js as its section 7.
// Before a take: payload capture On on the Logs page, a raw capture of one seeded user that is stopped again (so its
// bar is not on screen), and a handful of requests today, one of them masked with the trigger word; the gateway
// without LOG_LEVEL, so the default level is the page's to change.
const SHELL = '/admin/app/shell/?sap-language=en&sap-theme=sap_horizon';

export default async ({ section, goto, click, type, press, wait, caption, scroll, end }) => {
  await section(7);
  await goto(SHELL);
  await click('nav=Configuration Management > Settings');
  await caption('Configuration versions');
  await wait(5000);
  await caption('The shipped defaults hold entries this configuration lacks');
  await wait(4000);
  await click('text=Compare with defaults');
  await caption('Compare with defaults: the picked entries go into a new configuration');
  await wait(9000);
  await click('text=Close');
  await click('text=Active');
  await click('text=Providers');
  await caption('The active configuration: providers, substitutions, streaming');
  await wait(7000);
  await click('text=Observability');
  await caption('Pseudonymization: one global switch, off as shipped; it names the flags it overrules');
  await wait(7000);
  await scroll(450, { ms: 2500, x: 1600 }); // the entity categories, each with its own switch
  await wait(4000);
  await caption('Observability: SIEM sinks for the security and usage events');
  await scroll(1400, { ms: 3500, x: 1600 }); // on to the SIEM panel and its sinks
  await wait(7000);

  await click('nav=Logs > Settings');
  await caption('Logs: the gateway log, live and searchable');
  await wait(6000);
  await type('input[placeholder="Search message, component, request ID"]', 'chat/completions');
  await press('Enter');
  await caption('Search: the matches in bold');
  await wait(5000);
  await click('text=Switches and levels');
  await caption('Switches and levels: what is stored, the default level, component levels for a while');
  await wait(8000);
  await click('text=Payload traces');
  await click('text=Today');
  await caption('Payload traces: a light trace of every request');
  await wait(6000);
  await click('text=Masked');
  await caption('A masked request keeps the masked prompt and answer');
  await wait(8000);
  await click('text=Close');
  await click('text=Not masked, Raw');
  await caption('Raw capture: every stage, unmasked, for a short time; each view is audited');
  await wait(3000);
  await click('text=Raw capture (4)');
  await wait(7000);
  await click('text=Close');

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
