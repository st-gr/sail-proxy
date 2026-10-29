// The screenshot manifest: one entry per image. `identity` picks the proxy port (admin :4010, user :4011,
// none = absolute URL); `url` is a path on the proxy unless absolute; `theme` and English are passed as
// URL parameters the shell reads before UI5 boots. Steps: settled, settled-plain, clickText <text> [group],
// click <selector>, clickFirstRow, type <selector> <text>, press <key>, wait <ms>, script <js>, goto <path>; `after` steps run once
// the image is written (clean-up). A clickText argument
// { seed: '<field>', format: '(%s)' } (type and clickText) is read from screencast/out/seed-keys.json at
// run time; the card grid of the Model Library shows a model id in parentheses. { env: '<NAME>' } reads the environment
// instead (the n8n shots sign in with N8N_EMAIL / N8N_PASSWORD from screencast/out/n8n-owner.env).
const shell = (theme = 'sap_horizon') => `/admin/app/shell/?sap-language=en&sap-theme=${theme}`;
const nav = (text, group) => (group ? ['clickText', text, group] : ['clickText', text]);
const S = ['settled'];
const cockpit = (id, steps, alt, extra = {}) => ({
  id, section: 'cockpit', identity: 'admin', theme: 'sap_horizon', url: shell(), steps: [S, ...steps], clip: 'viewport', alt, ...extra
});

// n8n (a local instance whose credentials point at the gateway): signs in with the owner from the environment,
// then opens the item by its visible name. The test cluster's host is redacted to the placeholder like everywhere.
const n8nLogin = [['settled-plain'], ['type', 'input[type="email"]', { env: 'N8N_EMAIL' }], ['type', 'input[type="password"]', { env: 'N8N_PASSWORD' }],
  ['press', 'Enter'], ['wait', 3000], ['script', "localStorage.setItem('N8N_THEME', 'light')"]];
// clickText looks among UI5 controls; in n8n, click the innermost element showing exactly this text.
const n8nClick = (text) => ['script', `Array.from(document.querySelectorAll('body *')).filter((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(text)}).pop().click()`];
const n8n = (id, steps, alt, extra = {}) => ({
  id, section: 'clients', identity: 'none', theme: null, url: 'http://127.0.0.1:5678/signin', viewport: { width: 1440, height: 900, scale: 2 },
  steps: [...n8nLogin, ...steps], clip: 'viewport', alt, ...extra
});
const n8nCredential = (name) => [['goto', '/home/credentials'], ['wait', 2500], n8nClick(name), ['wait', 2000]];

export const shots = [
  cockpit('home', [], 'The Admin Cockpit home page with the side navigation and the welcome text'),
  cockpit('dark-home', [], 'The Admin Cockpit home page in the dark theme', { theme: 'sap_horizon_dark', url: shell('sap_horizon_dark') }),
  cockpit('api-keys-list', [nav('API Keys', 'Access'), S], 'The API Keys list with the demo keys, their owners and their state'),
  cockpit('api-keys-create-dialog', [nav('API Keys', 'Access'), S, ['clickText', 'Create'], S], 'The page for creating a new API key with its name and owner fields',
    { after: [['clickText', 'Discard Draft'], S] }),
  cockpit('api-keys-states', [nav('API Keys', 'Access'), S], 'Active, disabled and expired keys side by side in the list', { clip: { selector: '.sapUiMdcTable' }, viewport: { width: 1440, height: 1200, scale: 2 } }),
  cockpit('aws-credentials', [nav('AWS Credentials', 'Access'), S], 'The AWS Credentials list with one SigV4 credential'),
  cockpit('usage-overview', [nav('Usage', 'Analytics'), S], 'The usage overview with tokens and cost over the last 30 days'),
  cockpit('usage-performance', [nav('Usage', 'Analytics'), S, ['clickText', 'Performance'], S], 'Usage performance: latency and throughput of the requests'),
  cockpit('usage-models', [nav('Usage', 'Analytics'), S, ['clickText', 'Models'], S], 'Usage split by model'),
  cockpit('security-notifications', [nav('Security Notifications', 'Analytics'), S], 'Security notifications for two failed sign-ins'),
  cockpit('model-library', [nav('Model Library', 'Models'), S], 'The Model Library with the catalogue of models'),
  cockpit('model-library-cost-dialog', [nav('Model Library', 'Models'), S, ['type', 'input[id$="--searchField-I"]', { seed: 'priceModelId' }], ['press', 'Enter'], S, ['clickText', { seed: 'priceModelId', format: '(%s)' }], S], 'The object page of an image model with its manually entered price'),
  cockpit('entitlements-quotas', [nav('Entitlements & Quotas', 'Models'), S, ['clickText', 'Quota profiles'], S], 'The quota profiles of Entitlements & Quotas with the Standard team profile'),
  cockpit('grounding-corpora', [nav('Vector Stores', 'Grounding'), S], 'The vector stores list with the Team handbook store'),
  cockpit('grounding-files', [nav('Files', 'Grounding'), S], 'The grounding files list with the three handbook documents'),
  cockpit('users-quotas', [nav('Users & Quotas', 'Settings'), S], 'The users list with status, spend and tokens this month'),
  cockpit('sap-rates', [nav('SAP Capacity Unit Prices', 'Settings'), S], 'The SAP Capacity Unit prices used to turn cost factors into money'),
  cockpit('tool-policy', [nav('Tool Governance', 'Settings'), S, ['clickText', 'Default developer policy'], S], 'A tool policy with its allow and deny lists'),
  cockpit('configuration-editor', [nav('Configuration Management', 'Settings'), S], 'The configuration list with the active configuration'),
  cockpit('configuration-detail', [nav('Configuration Management', 'Settings'), S, ['clickFirstRow'], S, ['clickText', 'Providers'], S], 'The active configuration opened beside the list, on its Providers tab'),
  cockpit('settings-theme', [['click', '[id$="--profileAvatar"]'], ['click', '[id$="--settingsButton"]'], S], 'The Settings dialog with the Light, Dark and System theme choice and the language', { clip: { selector: '.sapMDialog' } }),
  { ...cockpit('user-home', [], 'The cockpit as an ordinary user sees it: only their own keys and usage'), identity: 'user' },
  { ...cockpit('user-api-keys', [nav('API Keys', 'Access'), S], 'A user\'s own API keys'), identity: 'user' },
  n8n('n8n-credential-openai', n8nCredential('SAIL-PROXY (OpenAI)'), 'The n8n OpenAI credential with a gateway API key and the gateway\'s /openai/v1 base URL'),
  n8n('n8n-credential-anthropic', n8nCredential('SAIL-PROXY (Anthropic)'), 'The n8n Anthropic credential with a gateway API key and the gateway\'s /anthropic base URL'),
  n8n('n8n-credential-gemini', n8nCredential('SAIL-PROXY (Gemini)'), 'The n8n Google Gemini credential with the gateway\'s /google host and a gateway API key'),
  n8n('n8n-credential-aws', [...n8nCredential('SAIL-PROXY (AWS Bedrock)'), ['script', "Array.from(document.querySelectorAll('body *')).filter((e) => e.children.length === 0 && e.textContent.trim() === 'Bedrock Runtime Endpoint').pop().scrollIntoView({ block: 'center' })"], ['wait', 600]],
    'The n8n AWS credential with a gateway-issued access key and the gateway\'s /aws-bedrock address as Bedrock Runtime Endpoint'),
  n8n('n8n-workflow-chat', [['goto', '/home/workflows'], ['wait', 2500], ['click', '::-p-text(Ask SAIL-PROXY)'], ['wait', 4000], ['press', 'Escape'],
    ['click', '::-p-text(Open chat)'], ['wait', 1500],
    ['type', 'textarea', 'What is 1234 * 5678? Use the calculator.'], ['press', 'Enter'], ['wait', 20000]],
    'An n8n AI Agent workflow on the gateway: the chat asks for 1234 * 5678 and the agent answers with the Calculator\'s result'),
  // Open WebUI on the demo stack (compose profile `clients`, port 4031): a fresh chat, the Image switch (the first
  // switch of the integrations menu) and a prompt; the picture is generated anew on each run (a few cents).
  { id: 'openwebui-image', section: 'clients', identity: 'none', theme: null, url: 'http://localhost:4031/', viewport: { width: 1440, height: 900, scale: 2 },
    steps: [['settled-plain'], ['wait', 1500], ['click', '#integration-menu-button'], ['wait', 600], ['click', '[role="menu"] [role="switch"]'], ['press', 'Escape'],
      ['type', '#chat-input', 'A ship of glowing circuitry passes a dead-end wall labelled ORCHESTRATION and sails through a gate labelled SAIL-PROXY into a harbor where AI paints images. Cinematic, navy and cyan.'],
      ['press', 'Enter'], ['wait', 35000]],
    clip: 'viewport', alt: 'Open WebUI with an image generated by a deployed Gemini image model through the gateway' },
  { id: 'dex-sign-in', section: 'deploy', identity: 'none', theme: null, url: 'http://localhost:8080/', viewport: { width: 1200, height: 700, scale: 2 }, steps: [['settled-plain']], clip: 'viewport', alt: 'The Dex sign-in page of the Docker Compose stack' },
  { id: 'og-image', section: 'home', identity: 'none', theme: null, url: 'http://localhost:4173/sail-proxy/', viewport: { width: 1200, height: 630, scale: 1 }, steps: [['settled-plain'], ['script', "document.documentElement.style.zoom = '0.85'"], ['wait', 300]], clip: 'viewport', alt: 'Social preview of the documentation site' }
];
