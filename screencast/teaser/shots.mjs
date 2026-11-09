// The teaser's shot list on the song's grid (at(bar, beat), song seconds): slow opening, a shot per bar in the first
// build, half bars in the second, beats from the drop at 60 s, the end screen on the last crash at 100 s.
// F = full only, B = full and short. Clip starts are seconds into out/<video>/clips/section-<n>.mp4; crops keep
// the tutorials' caption bar out of frame.
import { at } from './beats.mjs';

const F = ['full']; const B = ['full', 'short']; const S = ['short'];
// 16:9 windows above the caption bar: casts and docs centred, cockpit content right of the navigation.
const TERM = { x: 0, y: 0, w: 1620, h: 911 };
const APP = { x: 300, y: 0, w: 1620, h: 911 };
const NEAR = { x: 420, y: 60, w: 1280, h: 720 };
// The picture Open WebUI generated in 06 section 9 (a deployed Gemini image model), centred in the chat.
const IMG = { x: 572, y: 256, w: 858, h: 482 };
// The API reference (Swagger UI, a teaser-only take) centred; it has no navigation and no caption bar.
const DOCS = { x: 150, y: 0, w: 1620, h: 911 };
const SWAGGER = '05-cockpit/swagger/section-7';
const clip = (c, start, crop = APP) => ({ clip: c, start, crop });
const card = (name, more = {}) => ({ card: name, ...more });
// A punch may break into lines with \n (layers.css keeps the break).
const punch = (word, atSec) => ({ lines: [word], style: 'punch', ...(atSec != null ? { at: atSec } : {}) });
const title = (text) => ({ lines: [text], style: 'title' });

let n = 0;
const s = (from, to, source, effect, versions, text) => ({ id: `s${String(++n).padStart(2, '0')}`, from, to, source, effect, versions, ...(text ? { text } : {}) });

export const SHOTS = [
  // 0–20 s, the opening: the logo, the line word by word, "Free." on the 10 s accent and "Forever." after it.
  s(0, at(2), card('logo'), 'push-in', B),
  ...[1, 2, 3, 4, 5, 6].map((k) => s(at(2, k - 1), at(2, k), card('tagline', { shown: k }), k === 1 ? 'flash' : 'cut', B)),
  s(at(3, 2), at(4), card('tagline', { shown: 7 }), 'cut', B),
  s(at(4), at(4, 2), card('logo'), 'flash', F, punch('Free.')),
  s(at(4, 2), at(6), card('logo'), 'pull-out', F, punch('Forever.')),
  s(at(6), at(8), clip('01-overview/section-1', 4, TERM), 'push-in', F, title('Open source. Community-built.')),

  // 20–40 s, the first build: the architecture, the docs, the CLI.
  s(at(8), at(9), card('diagram'), 'wipe', F, title('One gateway. Every tool.')),
  s(at(9), at(10), card('diagram'), 'push-in', F),
  s(at(10), at(11), clip('01-overview/section-5', 4, TERM), 'slide-left', F),
  s(at(11), at(12), clip('01-overview/section-5', 13, TERM), 'push-in', F),
  s(at(12), at(13), clip('02-cli/section-1', 6, TERM), 'slide-up', F, title('npm install. Done.')),
  s(at(13), at(14), clip('02-cli/section-3', 5, TERM), 'push-in', F),
  s(at(14), at(15), clip('02-cli/section-5', 9.5, TERM), 'glitch', F, title('Your coding tools on SAP AI Core.')),
  s(at(15), at(16), clip('06-clients/section-1', 44, TERM), 'push-in', F),

  // 40–60 s, the second build: every deployment, half-bar cuts.
  s(at(16), at(16, 2), clip('02-cli/section-3', 9, TERM), 'flash', F, title('Your laptop.')),
  s(at(16, 2), at(17), clip('02-cli/section-4', 4, TERM), 'cut', F),
  s(at(17), at(17, 2), clip('03-docker-compose/section-2', 3, TERM), 'slide-left', F),
  s(at(17, 2), at(18), clip('03-docker-compose/section-2', 40, TERM), 'cut', F),
  s(at(18), at(18, 2), clip('03-docker-compose/section-2', 74, TERM), 'flash', F, title('Your Docker host.')),
  s(at(18, 2), at(19), clip('03-docker-compose/section-2', 84, TERM), 'push-in', F),
  s(at(19), at(19, 2), clip('03-docker-compose/section-2', 90, TERM), 'cut', F),
  s(at(19, 2), at(20), clip('03-docker-compose/section-3', 6, TERM), 'glitch', F),
  s(at(20), at(20, 2), clip('04-kyma/section-3', 4, TERM), 'flash', B, title('Your Kubernetes.')),
  s(at(20, 2), at(21), clip('04-kyma/section-4', 12, TERM), 'cut', B),
  s(at(21), at(21, 2), clip('04-kyma/section-4', 32, TERM), 'push-in', B),
  s(at(21, 2), at(22), clip('04-kyma/section-4', 52, TERM), 'cut', B),
  // The Kyma cockpit's Dex sign-in offers GitHub (the plain login is already in the Docker shots).
  s(at(22), at(22, 2), clip('04-kyma/section-5', 44, { x: 480, y: 0, w: 960, h: 540 }), 'slide-left', B),
  s(at(22, 2), at(23), clip('04-kyma/section-5', 26), 'push-in', B),
  s(at(23), at(23, 2), clip('03-docker-compose/section-3', 36), 'cut', B),
  s(at(23, 2), at(24), clip('01-overview/section-3', 5), 'glitch', B),

  // 60–80 s, the drop: the cockpit, then every client, a word per shot.
  s(at(24), at(24, 2), clip('05-cockpit/section-1', 10), 'flash', B, punch('Keys.')),
  s(at(24, 2), at(25), clip('05-cockpit/section-2', 7), 'push-in', B, punch('Usage.')),
  s(at(25), at(25, 2), clip('05-cockpit/section-2', 25), 'glitch', B, punch('Cost.')),
  s(at(25, 2), at(26), clip('05-cockpit/section-3', 10), 'slide-left', B, punch('Quotas.')),
  s(at(26), at(26, 2), clip('05-cockpit/section-4', 8), 'push-in', B, punch('Teams.')),
  s(at(26, 2), at(27), clip('05-cockpit/section-5', 16), 'glitch', B, punch('Tool policies.')),
  s(at(27), at(27, 2), clip('05-cockpit/section-6', 38), 'slide-up', B, punch('Grounding.\nState of the art.')),
  s(at(27, 2), at(28), clip('04-kyma/github-sign-in/section-5', 11, { x: 480, y: 0, w: 960, h: 540 }), 'flash', B, punch('SSO.')),
  // The coding agents in their own interfaces, a beat each, on the diff or the answer; then the apps.
  s(at(28), at(28, 1), clip('06-clients/section-1', 52, TERM), 'flash', B, punch('Claude Code')),
  s(at(28, 1), at(28, 2), clip('06-clients/section-2', 20, TERM), 'glitch', B, punch('Codex')),
  s(at(28, 2), at(28, 3), clip('06-clients/section-4', 40, TERM), 'flash', B, punch('Gemini CLI')),
  s(at(28, 3), at(29), clip('06-clients/section-5', 38, TERM), 'glitch', B, punch('pi')),
  s(at(29), at(29, 1), clip('06-clients/section-6', 40, TERM), 'flash', B, punch('opencode')),
  s(at(29, 1), at(29, 3), clip('06-clients/section-7', 134, TERM), 'push-in', B, punch('NVIDIA OpenShell\non Kyma.')),
  // The sandbox's own curl to Anthropic is refused: it has no route but the gateway.
  s(at(29, 3), at(30, 1), clip('06-clients/section-7', 27, TERM), 'glitch', B, punch('Agents can\'t\nescape.')),
  s(at(30, 1), at(30, 2), clip('06-clients/section-3', 12, TERM), 'flash', F, punch('GitHub Copilot')),
  s(at(30, 2), at(30, 3), clip('06-clients/section-8', 14, { x: 320, y: 205, w: 1280, h: 720 }), 'glitch', F, punch('Claude Desktop')),
  s(at(30, 3), at(31), clip('06-clients/section-10', 55, TERM), 'flash', F, punch('n8n')),
  // The short version has no 80–100 s stretch: the Connections and the API reference take three client beats.
  s(at(30, 1), at(30, 3), clip('05-cockpit/section-8', 8), 'flash', S, punch('Bring your own\nproviders.')),
  s(at(30, 3), at(31), clip(SWAGGER, 3, DOCS), 'glitch', S, punch('got Swagger?')),
  s(at(31), at(31, 1), clip('06-clients/section-9', 46, TERM), 'slide-left', B, punch('Open WebUI')),
  s(at(31, 1), at(31, 2), clip('06-clients/section-9', 70, IMG), 'push-in', B, punch('Images.')),
  s(at(31, 2), at(32), clip('05-cockpit/section-7', 112), 'glitch', B, punch('7 languages.')),

  // 80–100 s: models and native APIs, operations, then a burst on every beat back to the logo.
  s(at(32), at(32, 2), clip('01-overview/section-3', 42), 'flash', F, punch('Any model.')),
  s(at(32, 2), at(33), clip('01-overview/section-3', 54), 'push-in', F, title('Deploy from the cockpit.')),
  s(at(33), at(33, 2), clip('01-overview/section-3', 44, NEAR), 'glitch', F, punch('GPT Realtime.')),
  s(at(33, 2), at(34), clip('06-clients/section-9', 72, IMG), 'pull-out', F, punch('Nano Banana.')),
  s(at(34), at(34, 2), clip('01-overview/section-3', 40, NEAR), 'glitch', F, punch('SAP RPT-1.')),
  s(at(34, 2), at(35), clip('05-cockpit/section-7', 55), 'slide-left', F, punch('SIEM.')),
  s(at(35), at(35, 2), clip('05-cockpit/section-7', 36), 'push-in', F, punch('Pseudonymization.')),
  s(at(35, 2), at(36), clip('05-cockpit/section-8', 8), 'flash', F, punch('Bring your own\nproviders.')),
  // The Connections a beat each, then two beats per punch, two plain flashes into the logo.
  ...[
    ['05-cockpit/section-8', 10, 'OpenAI.'], ['05-cockpit/section-8', 20, 'Azure OpenAI.'],
    ['05-cockpit/section-8', 114, 'Anthropic.'], ['05-cockpit/section-8', 122, 'AWS Bedrock.']
  ].map(([c, t, w], k) => s(at(36, k), at(36, k + 1), clip(c, t), k % 2 ? 'glitch' : 'flash', F, punch(w))),
  s(at(37), at(37, 2), clip('05-cockpit/section-8', 131), 'push-in', F, punch('Multi-tenant.')),
  s(at(37, 2), at(38), clip(SWAGGER, 3, DOCS), 'glitch', F, punch('got Swagger?')),
  // Claude Code's web search answered with its sources (06 section 1): the search runs on SAP AI Core, not from the user.
  s(at(38), at(38, 2), clip('06-clients/section-1', 117, TERM), 'flash', F, punch('Web search.\nUntraceable.')),
  s(at(38, 2), at(38, 3), clip('05-cockpit/section-2', 56), 'glitch', F),
  s(at(38, 3), at(39), clip('05-cockpit/section-7', 114), 'flash', F),
  s(at(39), at(39, 2), card('logo'), 'flash', F, punch('AI governance.')),
  s(at(39, 2), at(40), card('logo'), 'push-in', F, punch('Today.')),

  // 100 s, the last crash: give it a try (held END_HOLD s past the music).
  s(at(40), 105.625, card('end'), 'flash', B)
];
