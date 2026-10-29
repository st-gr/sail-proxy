// Clients: one documentation page and one cast per tool (each in its own interactive interface, the same task, Claude Code once more in an OpenShell sandbox), Copilot by its page only, Open WebUI in the browser with
// a chat answer and an image from a deployed Gemini image model, n8n's AI Agent, the usage page scrolled through at the end.
const DOCS = 'http://localhost:4173/sail-proxy';
const SHELL = '/admin/app/shell/?sap-language=en&sap-theme=sap_horizon';
const WEBUI = 'http://localhost:4031/';
// n8n runs as the container sail-n8n with its credentials pointed at this stack; the recording browser profile
// (SAIL_DOCS_BROWSER_PROFILE) is signed in to it beforehand by stack/n8n-sign-in.mjs, so no login is on camera.
const N8N = 'http://127.0.0.1:5678';
const IMAGE_PROMPT = 'A ship of glowing circuitry passes a dead-end wall labelled ORCHESTRATION and sails through a gate labelled SAIL-PROXY into a harbor where AI paints images. Cinematic, navy and cyan.';

export default async ({ section, goto, click, type, press, wait, until, caption, cast, play, scroll }) => {
  await section(1); await goto(`${DOCS}/guide/clients/claude-code`); await caption('Claude Code'); await wait(5000); await caption('Claude Code in its own interface, on the gateway'); await cast('claude'); await wait(2000);
  await section(2); await goto(`${DOCS}/guide/clients/codex`); await caption('Codex CLI'); await wait(4000); await caption('Codex in its own interface, on the gateway'); await cast('codex');
  await section(3); await goto(`${DOCS}/guide/clients/github-copilot`); await caption('GitHub Copilot: the patch script or the Ollama provider'); await wait(10000); await click('text=OpenRouter provider (patched)'); await wait(12000);
  await section(4); await goto(`${DOCS}/guide/clients/gemini`); await caption('Gemini CLI'); await wait(4000); await caption('Gemini CLI in its own interface, on the gateway'); await cast('gemini');
  await section(5); await goto(`${DOCS}/guide/clients/pi`); await caption('pi'); await wait(4000); await caption('pi in its own interface, on the gateway'); await cast('pi');
  await section(6); await goto(`${DOCS}/guide/clients/opencode`); await caption('opencode'); await wait(4000); await caption('opencode in its own interface, on the gateway'); await cast('opencode');
  // Claude Code in an NVIDIA OpenShell sandbox on Kyma, on the gateway's in-cluster address (casts.mjs: openshell).
  await section(7); await goto(`${DOCS}/guide/clients/openshell`); await caption('Claude Code in an NVIDIA OpenShell sandbox'); await wait(6000); await caption('Inside the sandbox: the gateway as base URL, a placeholder key, no route of its own'); await cast('openshell');
  // Claude Desktop in its third-party gateway mode, recorded by hand on a 1920×1080 display (clips/claude-desktop.webm,
  // gitignored; the README has the cut): the model picker, a chat answer, the Code tab adding greet and running it.
  await section(8); await goto(`${DOCS}/guide/clients/claude-desktop`); await caption('Claude Desktop'); await wait(6000);
  await caption('Claude Desktop in its gateway mode, no Claude.ai account'); await play('claude-desktop', { title: 'Claude Desktop' });
  // Open WebUI runs only with the compose profile `clients` (see the README); the question goes to gpt-5-mini.
  await section(9); await goto(`${DOCS}/guide/clients/open-webui`); await caption('Open WebUI'); await wait(6000);
  await goto(WEBUI); await caption('Open WebUI with the gateway as its OpenAI connection'); await wait(4000);
  await type('#chat-input', 'In two sentences, what does an LLM gateway do for a team?'); await press('Enter');
  await caption('The answer comes through the gateway'); await wait(16000);
  // Image generation (Open WebUI's openai image engine on the gateway, model gemini-3.1-flash-image--deployed).
  // The Image row of the Integrations menu is its first switch (the switches carry no label of their own).
  await click('#integration-menu-button'); await click('[role="menu"] [role="switch"]'); await press('Escape');
  await caption('Image generation on a deployed Gemini image model'); await type('#chat-input', IMAGE_PROMPT); await press('Enter');
  await caption('The image comes from a deployment: orchestration has no image output');
  // The image takes 20 s to well over a minute; Open WebUI shows this line together with it.
  await until('::-p-text(View Result from generate_image)', { timeoutMs: 180000 }); await wait(8000);
  await section(10); await goto(`${DOCS}/guide/clients/n8n`); await caption('n8n'); await wait(6000);
  await goto(`${N8N}/home/credentials`); await click('::-p-text(SAIL-PROXY (OpenAI))'); await caption('An OpenAI credential with the gateway as base URL'); await wait(7000); await press('Escape');
  await goto(`${N8N}/home/workflows`); await click('::-p-text(Ask SAIL-PROXY)'); await press('Escape');
  await caption('An AI Agent with the Calculator tool'); await wait(4000); await click('::-p-text(Open chat)');
  await type('textarea', 'What is 1234 * 5678? Use the calculator.'); await press('Enter');
  await caption('The agent calls the tool, every model call through the gateway'); await wait(16000);
  await section(11); await goto(SHELL); await click('nav=Usage > Analytics'); await caption('Every call, by provider and model'); await wait(4000);
  await scroll(1000, { ms: 4000 }); await wait(4000);
  await click('text=Cost'); await caption('Cost per model, per key, per user'); await wait(2000); await scroll(1400, { ms: 5000 }); await wait(4000);
  await click('text=Models'); await caption('And by model'); await wait(4000); await scroll(1000, { ms: 4000 }); await wait(4000);
};
