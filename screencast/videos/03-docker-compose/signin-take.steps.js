// Sections 3 and 4 of the Docker video, taken on their own (`node record.js 03-docker-compose --steps signin-take
// --first-section 3`, then the clips and their timing copied over sections 3 and 4) and played by steps.js: the real
// sign-in through nginx and Dex, a key created in the cockpit, the call. The demo stack must be up.
const STACK = 'http://localhost:8080';
const SHELL = `${STACK}/admin/app/shell/?sap-language=en&sap-theme=sap_horizon`;

export async function signInAndCall({ section, goto, click, type, wait, hold, mark, caption, cast }) {
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
  await caption('Call the gateway: an OpenAI-style request through nginx, the key in the header');
  await cast('call');
  await hold(5000); // the model's answer is the cast's last output: let it be read
}

// On its own: end the take, then delete the key it created (steps.js does that after section 5).
export default async (api) => {
  await signInAndCall(api);
  await api.end();
  await api.goto(SHELL);
  await api.click('nav=API Keys > Access');
  await api.click('text=Docker video key');
  await api.click('text=Delete');
  await api.click('role=button:Delete');
  await api.wait(1500);
};
