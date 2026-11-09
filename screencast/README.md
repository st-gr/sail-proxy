# Screencast and screenshot toolkit

Everything here runs against a throwaway Docker Compose stack of sail-proxy with invented data. Nothing in this folder stores a credential: the SAP AI Core service key is read from a gateway `.env` you point at and handed to the setup script in memory; `redact.local.json` and `out/` are gitignored.

## Prerequisites

- Docker with Compose 2.24.4 or newer (`!override` in the port override needs it) (`docker compose version`), about 10 GB free for the three images.
- `pnpm install` done at the repository root (puppeteer and its Chrome are cached).
- A gateway `.env` with working `SAP_AI_CORE_URL`, `AUTH_URL`, `CLIENT_ID`, `CLIENT_SECRET` and `SAP_AI_RESOURCE_GROUP`. Export its path: `export SAIL_DOCS_CREDENTIALS_ENV=/path/to/.env`.
- Nothing else of yours on ports 13000, 14004, 14180, 15432, 15556, 16379, 8080 and 443.

## Stack

All commands from the repository root. `dc` is the compose command this toolkit uses (a function, so it works in bash and zsh alike):

    export COMPOSE_PROJECT_NAME=sail-docs DOCKER_TAG=docs-demo
    dc() { docker compose -f docker/docker-compose.yml -f screencast/stack/compose.docs.yml "$@"; }

The demo stack publishes nginx on 8080 and 443 on all interfaces with the public demo password, so it is reachable from the LAN while it runs.

1. Render the stack configuration (local sign-in, localhost, no backup) into this checkout; it writes `docker/.env*`, `docker/dex.config.yaml`, `services/gateway/.env`, `services/admin/.env`, `services/ollama/.env` here and nowhere else:

       node screencast/stack/with-service-key.mjs -- node docker/setup-docker.js --ci --force

2. Prove that no published port collides with a dev server; the pass condition is that the grep prints nothing:

       dc config | grep -nE 'published: "?(3000|4004|6379|5432)"?' && echo "port collision: stop"

3. Build and start: `dc build gateway admin nginx && dc up -d`.
4. Health: `curl -s http://127.0.0.1:13000/health` and `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:14004/odata/v4/admin/` (401 means the admin is up and wants a sign-in header).
5. Stop and remove everything of this project only: `dc down -v`.

Never run `node docker/setup-docker.js` in a checkout that has a real `docker/.env`: it rewrites the env files.

## Proxy

`node screencast/proxy.js` stands in for nginx and oauth2-proxy: `:4010` signs in as the admin identity, `:4011` as the first user (`IDENTITY_INDEX` picks another). It sends no groups header, so the admin maps each e-mail to a role through `LOCAL_USER_MAPPING`; `node screencast/stack/grant-identities.mjs` adds the four demo e-mails to that mapping (and `ROLE_MAPPING`) in `docker/.env.auth`, then recreate the admin with `dc up -d admin`.

- Smoke, admin: `curl -s http://127.0.0.1:4010/admin/odata/v4/admin/whoami -X POST -H 'content-type: application/json' -d '{}'` answers the admin e-mail with the `admin` role.
- Smoke, user: the same call on `:4011` answers the first user's e-mail with only the `user` role.

## What the first run taught

- Setup: `with-service-key.mjs -- node docker/setup-docker.js --ci --force` renders the env files in a few seconds. The setup prints the generated local oauth2-proxy secrets to stdout, so do not run it while a screen recorder is on.
- Single-quoted values: a gateway `.env` that single-quotes `CLIENT_SECRET` used to reach the setup with the quotes included, which it then quoted again, and `docker compose config` failed with a dotenv parse error on that line. The helper now strips either quote kind.
- Port proof: `config` shows exactly 14004, 15556, 13000, 14180, 15432 and 16379 as published ports, and no 3000 or 4004.
- Build: `docker compose build gateway admin nginx` took about 18 minutes (1075 s) on a cold cache; run it detached and poll, a shell command is capped at ten minutes. Images: `ghcr.io/st-gr/sail-proxy-{gateway,admin,nginx}:docs-demo`.
- Disk-full failure mode: with a full Docker VM disk the first `up -d` failed. Symptom: Postgres restarts in a loop with `initdb: error: could not create directory ... pg_wal: No space left on device`, dex stays unhealthy (`nc: bad address 'postgres'`) and everything behind it stays `Created`. Check `docker system df` and free space, then `up -d` again; dex needed one `docker restart sail-docs-dex-1` after Postgres came up.
- Health after the second `up -d` (about two minutes until the gateway answered): gateway `/health` returned `{"status":"healthy","service":"gateway","deployTarget":"docker",...}`, admin `401`, nginx `301`, dex `200`. The admin log shows `successfully deployed to postgres:5432` (there is no literal `connect to db` line in this image) and its only ERROR line is the `Authentication failed` for the unsigned admin probe.

## Seed

With the stack up and the identities granted (see Proxy), and `libs/test-utils` built once (`pnpm --filter @sap-llm-gateway/test-utils build`, the seed reads the cheap live models from it):

    node screencast/seed.js              # create the demo data
    node screencast/seed.js --teardown   # remove it again

What it creates, as the admin identity against the admin on 14004 and the gateway on 13000:

- Part 1: six API keys (four laptop keys, one per identity, plus "Old CI runner" disabled and "Trial key" that expires two minutes after creation), the AWS credential "Bedrock client", the quota profile "Standard team", the tool policy "Default developer policy", a manual price for an image model, and the team "Platform team" (a pool of 1,000 a month, the member profile "Team member default" at 200 a month, the three users as members with the first as team admin, the developer policy). Teams need images built after Teams Part B.
- Part 2: the vector store "Team handbook" with the three invented Markdown files from `seed/corpus/` (uploaded with the admin's key and indexed); 143 real calls over the four laptop keys (120 short chats, one in five on the Claude model and the rest on the cheap chat model, 20 embeddings, 3 tool calls); the usage rows of the run, once their count has been quiet for 20 s, are moved back over the last 30 days (weekdays weighted five to one) with one `UPDATE … WHERE id = '<id>'` per row on the throwaway Postgres, scoped to the demo keys; then one call each with the disabled and the expired key, which show up as two `failed_auth` entries in Security Notifications.

Secrets (key values, ids, the vector store and file ids) go to `screencast/out/seed-keys.json` (mode 0600, gitignored). The seed prints the vector store id and the price model id (neither is a secret) and never a key. The run is idempotent: existing records are matched by name, and each part-2 step records itself in the state file, so a second run makes no gateway calls. `--teardown` deletes the vector store and its files first (with the admin's key), then the keys, the credential, the price, the profile and the policy; whatever fails to go stays in the state file for a second attempt. Usage rows stay in Postgres (they leave the cockpit with their keys); `dc down -v` removes everything. If `out/seed-keys.json` is lost, `--teardown` cannot find the keys; use `dc down -v`.

First run (2026-10-14): indexing about 30 s, the calls about 3 minutes; 126 of 143 calls answered 200 and 17 answered 429 (SAP AI Core throttling the cheap chat model when four keys call it at once; the gateway still records them as usage), 164 usage rows in total including the grounding's ingestion and file-search rows, spread over 27 days. SAP cost of the whole run, read from `ApiKeyUsageSapCostStats`: 0.068 USD; expect a few cents (under 0.10 USD) per run.

## Redaction

Real values never reach a screenshot, a cast or a page. `redact.local.json` (gitignored, mode 600; `redact.sample.json` shows the shape) maps each real value to a mock one. The map is applied in two places: `lib/redact.mjs` `applyMap` rewrites text such as casts, and `overlaySource` returns a script that the runner injects into the browser, where a MutationObserver rewrites text nodes, input values and `title` attributes as the page changes. After the map, generic patterns run: any `*.kyma.ondemand.com` host becomes `sail.example.com`, except the placeholder cluster `c-abc123` (shown on purpose, like the documentation IP range); any IPv4 address outside `127.*` and the `203.0.113.0/24` documentation range becomes `203.0.113.7`; any AWS-shaped access key id becomes `DEMO-ACCESS-KEY-ID`; and any SAP AI Core deployment id (16 lower-case hex characters with at least one letter) becomes `demo-deployment-<n>`, numbered by first appearance so the same id reads the same everywhere on a page; and any SAP auth host (`<subaccount>.authentication.<region>.hana.ondemand.com`) becomes `auth.example.sap`. Any 32-character lower-case hex value (a classic Azure OpenAI key; request and trace ids of that shape go too) becomes `••••••••`; the newer 84-character Azure keys have no shape to match on and are masked by the map only.

`with-service-key.mjs` builds the map from the gateway `.env` (the URLs, their hosts without scheme, the client id and secret) and merges `redact.extra.local.json` (gitignored, a JSON object of real → mock; its entries win) when it exists; plan 3 fills that file with the hostname, the user name, the home path and the maintainer's name.

`node screencast/stack/provider-redactions.mjs` adds the external providers' values to `redact.extra.local.json` (created mode 600 if missing; existing entries stay; running it twice adds nothing). It reads `~/Documents/repos/azure-connection.env`, `aws-connection.env`, `anthropic-connection.env` and `~/.config/ter-demo/openai.env` (or `OPENAI_API_KEY` from the environment); `SAIL_DOCS_AZURE_ENV`, `SAIL_DOCS_AWS_ENV`, `SAIL_DOCS_ANTHROPIC_ENV`, `SAIL_DOCS_OPENAI_ENV` and `SAIL_DOCS_REDACT_EXTRA` override the paths, and a missing file is skipped with a note. The Azure host becomes `demo-resource.openai.azure.com` and its resource name `demo-resource`, the deployments `gpt-demo` / `embed-demo`, tenant and client ids `00000000-0000-0000-0000-000000000000` / `…001`, the access key id `DEMO-ACCESS-KEY-ID` and every key, secret and token `••••••••`; `AWS_REGION` and `BEDROCK_MODEL_ID` are public and stay. It prints only the mock values it added. Re-run `with-service-key.mjs` afterwards so `redact.local.json` carries them. `--check <file>` exits 1 if the file holds one of these real values, naming the mock it should have shown.

`node screencast/lib/frame-check.mjs <video> [--every 0.5] [--map <json>]…` checks a finished video: ffmpeg samples a frame every `--every` seconds, tesseract reads it, and the check fails (exit 1) with the mock and the timestamps for every real value of `redact.local.json` and `redact.extra.local.json` (or the `--map` files) it reads. Values of 8 characters or more are compared case-insensitively with O/0 and l/I/1 folded and spaces dropped; shorter ones as whole words, case-insensitively; values under 4 characters are not checked. Without ffmpeg, tesseract or a map it exits 2.

`node screencast/check.js` is the secret gate. It reads the map and fails with `file:line: pattern` for every real value, key pattern, SAP AI Core deployment id, cluster host, SAP auth host, address outside `127.0.0.0/8` and the `203.0.113.0/24` documentation range, foreign e-mail, and `clientsecret` value. It scans every `.md .json .js .mjs .cjs .ts .cast .txt .vtt .srt .yml .yaml .sample .html .css .vue .py` file under `screencast/` (except the gate and `lib/redact` sources with their tests, `redact.local.json`, `redact.extra.local.json`, `out/` and `node_modules/`), every `.md .cast .vtt .srt .txt .json .ts .vue .css` file under `docs/` (except `.vitepress/cache`, `.vitepress/dist`, `dist`, `.generated`, `node_modules`, `superpowers`, `notes` and `competitive` directly under `docs/`), and the file names in `docs/assets/screenshots`. Placeholders such as `your-client-secret`, code expressions such as `env.CLIENT_SECRET` and the bind-all address `0.0.0.0` are not findings. `pnpm docs:check` runs the gate before the build. Run it before any commit that touches `screencast/` or the screenshots; a finding is fixed at its source, never allowlisted to get past it.

## Screenshots

`pnpm docs:shots` renders every entry of `shots.manifest.mjs` with headless Chrome (puppeteer) and writes `docs/assets/screenshots/<section>/<id>.png` (1440×900 at device scale 2) and the social preview `docs/public/og-image.png` (1200×630). `pnpm docs:shots --only <id>` renders one entry; the run prints `shot <id> -> <path>` per image, `FAILED <id>: <reason>` per failure and a `<n> rendered, <m> failed` summary, and exits 1 if anything failed.

Prerequisites, all from the repository root:

- The stack is up and seeded (see Stack and Seed); the runner reads `out/seed-keys.json` for the price model's id and never prints it.
- `node screencast/proxy.js` is running (cockpit shots use `:4010` as the admin and `:4011` as the user).
- For `og-image`: `pnpm docs:build`, then a fresh `pnpm docs:preview` answering `http://localhost:4173/sail-proxy/`; restart the preview after every rebuild.
- `dex-sign-in` reads the Dex page on `http://localhost:8080/` directly.

Stop the proxy and the preview afterwards.

Each entry gives an `identity` (admin, user or none), a `url` (a proxy path, or absolute), a `theme` and a list of `steps`: `settled` (no UI5 busy indicator, core initialized, network idle), `settled-plain` (network idle only), `clickText <text> [group]` (visible text of a button, tab, link or table cell; with a group it clicks a side-navigation item and expands its group once if collapsed), `click <selector>`, `clickFirstRow`, `type <selector> <text>`, `press <key>`, `wait <ms>`, `script <js>` (evaluates the source in the page; `og-image` zooms the site to 0.85 so the hero fits 1200×630). A `{ seed: '<field>' }` argument is read from the seed state at run time. `after` steps run once the image is written and undo what the shot opened (the API key Create page leaves a draft; its `after` step discards it). The `clip` is `'viewport'` or `{ selector }` for an element crop (`pad` widens it). Every shot runs in English with `?sap-language=en&sap-theme=<theme>`, light except `dark-home`.

Hygiene: the redaction overlay (`lib/redact.mjs`) is injected after the page loads and again after every step. Before an image is written the runner reads `document.body.innerText`, every input value and every `title` attribute, and fails the shot with `redaction miss: <name>` if they still contain a real value of `redact.local.json`, a `*.kyma.ondemand.com` host, an IPv4 address outside `127.*` and `203.0.113.0/24`, an AWS-shaped access key id, an API key (`sk-…`), a SAP auth host, a foreign e-mail address or a SAP AI Core deployment id; the message names the mock value or the pattern, never the real value. The map and `out/seed-keys.json` are parsed through guarded loaders whose errors (`redact.local.json is not valid JSON`, `seed-keys.json is not valid JSON`) never quote the file, and a step that clicks a value from the state file fails with `no visible element for seed value <field>`. `--only` without an id exits 2 with `usage: --only <id>`. Then run `node screencast/check.js`, which also checks the image file names.

What the first run taught (2026-10-14, 25 shots in about two minutes):

- The cockpit header's Settings button sits in the avatar's profile popover: click `[id$="--profileAvatar"]` first. The navigation group "Settings" has the same text, so the dialog is never opened through `clickText('Settings')`.
- In-app texts that repeat a navigation item ("Models" in Usage Analytics, "Files" in a vector store) must not hit the side navigation: `clickText` without a group prefers app content.
- The Model Library shows models as cards with the id in parentheses: search for the id, then click `(<id>)`.
- A "Usage data loaded" toast covers the usage pages for a few seconds; the runner waits for toasts to fade and drops focus (no focus ring, no shortcut hint) before taking the picture.
- The seed starts no grounding job (a job starts only when several files are attached at once), so there is no Jobs shot: an empty page teaches nothing.

## Videos

Six videos are planned under `videos/<id>/`: `script.md` (narration and sections), `steps.js` (what the browser does), `casts.mjs` (terminal recordings to make) and `casts/*.cast` (the recordings, committed and scanned by the gate). `videos/catalog.json` is what the site's videos page shows; the assembler fills in duration and chapters, you fill in `youtubeId` after the upload. State today: 03 is finished (`out/03-docker-compose/03-docker-compose.mp4`); 01, 02, 05 and 06 have script, step file and a green dry run, so they are ready to record (casts are committed for 01, 02 and 06; 05 has none, its script lists none); 04 (Kyma) is recorded (`out/04-kyma/04-kyma.mp4`, see Kyma video).

Prerequisites: the stack up and seeded, `node screencast/proxy.js` running, `pnpm docs:build && pnpm docs:preview` running (restart after every rebuild), `redact.local.json` fresh (`with-service-key.mjs -- true`) with `redact.extra.local.json` holding this Mac's hostname, user name, home path and your full name (see `redact.extra.sample.json`), ffmpeg on the PATH, `OPENAI_API_KEY` in the environment for the narration.

Per video, from the repository root:

1. `pnpm screencast:cast <video> --all` records the casts (`<name>` records one). A cast is refused when its text still holds a real value; the raw output stays in `out/<video>/casts/<name>.raw.log` (mode 600) for you to see what leaked, fix the map or the scrub rule, record again. Read every new cast once. The casts of 01, 02 and 06 already exist; record them again only if you change a command. Video 05 has no casts: skip this step for it.
2. `pnpm screencast:narration-check <video>` validates the script; `pnpm screencast:dry-run <video>` runs the step file without recording and lists every selector that did not resolve. Both must be clean.
3. `pnpm screencast:record <video>` records one clip per section into `out/<video>/clips/` and the timing log.
4. `pnpm screencast:assemble <video> --timeline` prints the recorded section starts and, for each cast, `cast <name> <start>–<end>`. Move the `sections:` labels and the `[MM:SS]` cues in `script.md` to the recorded times (first cue 2 to 4 s after the card; `out/<video>/timing.json` has the captions and marks per clip). A caption lands about 2.5 s after the pointer starts towards its click, so cue a line about 2 s before the caption of the screen it talks about, one line per screen; a cue on the caption itself, or one line for two screens, makes the narration trail the picture. Casts play 25 to 30 % slower in the recording browser than the cast file says: take the times from the timeline, not from the cast.
5. `pnpm screencast:narrate <video>` speaks the script (gpt-realtime-2.1; the cost is printed, roughly a quarter dollar per video). The assembler refuses a narration whose cues differ from the script, so narrate only after the last cue alignment. `pnpm screencast:cards <video>` renders the cards (after the narration, so the outro fits the recap).
6. `pnpm screencast:assemble <video>` builds `out/<video>/<video>.mp4` with chapters, `<video>.vtt`, `chapters.txt` (paste into the YouTube description) and `poster.jpg` (taken from the intro card). Watch it once, all of it.
7. Publish on the site: copy the VTT and the poster to `docs/public/videos/`, set `vtt` and `poster` in the catalogue, run `pnpm docs:check`, commit. After the YouTube upload, set `youtubeId`.

The MP4 is never committed; `out/` is gitignored.

Order and per-video notes:

- Record 02 before 06: the 06 casts change the endpoint in the shared scratch config.
- Scratch home: run `eval "$(screencast/stack/scratch-home.sh reset)"` once in the recording shell before the 02 and 06 casts (it recreates `out/scratch-home` and exports `SAIL_DOCS_SCRATCH_HOME`, `npm_config_prefix` and `SAIL_PROXY_CONFIG_DIR`, which the cast definitions read).
- Casts that need the SAP AI Core service key (02 `configure`, 03 `setup`) run through the key wrapper, which reads the key from the gateway `.env` and passes it only to the child: `SAIL_DOCS_CREDENTIALS_ENV=<path to the gateway .env> node screencast/stack/with-service-key.mjs -- pnpm screencast:cast <video> <name>`. Without it the definition throws `SAP_AI_CORE_SERVICE_KEY is not set`.
- 03: the `setup` cast runs `setup-docker.js --ci --force` only in a `git archive` scratch copy with an npm-dist inquirer symlink, never in the live tree; the `up` cast stops and restarts the demo stack.
- 06: the claude casts patch the installed 0.10.0 launcher through `stack/patch-claude-launcher.sh` until 0.10.1 is published. Claude Code needs an explicit `--model`; pi needs `--model sail-proxy/gpt-5-mini` (the default model fails on a second turn); Gemini needs `COLORTERM=truecolor` and goes through nginx since the `x-goog-api-key` fix.
- 03: section 2 plays `videos/03-docker-compose/clips/btp-service-key.webm` (the BTP cockpit's Credentials dialog with a fake key and Copy JSON). Clips are gitignored: they come from the maintainer's own recordings. Cut it again from the 2025-09-14 "use SAP BTP service key" recording with `ffmpeg -ss 14 -to 22.5 -i <recording> -an -filter_complex "[0:v]crop=1120:630:0:0,scale=1680:945:flags=lanczos,fps=30,split[a][b];[b]crop=364:28:280:383,scale=26:2:flags=area,scale=364:28:flags=neighbor[z];[a][z]overlay=280:383" -c:v libvpx-vp9 -b:v 4M clips/btp-service-key.webm` (VP9 in WebM; the overlay pixelates the `identityzone` value, the one value of the key the recording shows unmasked).
- 06: section 8 plays `videos/06-clients/clips/claude-desktop.webm`, Claude Desktop in its third-party gateway mode, recorded by hand: the app maximised on a 1920×1080 display with the sidebar hidden (it shows the macOS account name), configured against the demo stack (`http://127.0.0.1:8080/gateway/anthropic`, `x-api-key`, the seeded user's key, the three `--deployed` Claude models), the Code tab on `/Users/Shared/demo` (a path without the account name; open it once off camera so the take never shows the file dialog). Record the display with `ffmpeg -f avfoundation -capture_cursor 1 -capture_mouse_clicks 1 -framerate 30 -pixel_format nv12 -i "Capture screen 1:none" -c:v h264_videotoolbox -b:v 14M out/06-clients/raw/claude-desktop-take1.mp4` (stop with SIGINT), then cut segments with `trim` and `setpts` (typing 3–4×, thinking 2×), crop each to 1280×720 (`crop=1280:720:320:60` for the conversation, `crop=1280:720:320:360` while the Code tab's prompt is typed), hold the chat answer and the final answer 3 s (`tpad=stop_mode=clone:stop_duration=3`), concat, scale to 1680×945 and encode VP9 like the BTP clip. Reset `/Users/Shared/demo/index.js` and delete its `.claude` folder before each take.
- 06: section 6 records Open WebUI on port 4031. Start it with the compose profile `clients` and a seeded user's key, `SAIL_DOCS_OPENWEBUI_KEY=<key from out/seed-keys.json> docker compose … --profile clients up -d openwebui`, open `http://localhost:4031/` once and close its "What's New" dialog (it is stored per user on the server, so the recording browser does not see it; recreating the container brings it back), and remove the container after the recording (`docker compose … --profile clients rm -sf openwebui`).
- 06: section 6 also generates an image: the openwebui service sets Open WebUI's image engine to the gateway's OpenAI images endpoint with `gemini-3.1-flash-image--deployed` (a deployed Gemini image model, Nano Banana; a few cents per image). Section 7 records n8n: run the container once (`docker run -d --name sail-n8n -p 127.0.0.1:5678:5678 -v sail-n8n_data:/home/node/.n8n -e N8N_SECURE_COOKIE=false docker.n8n.io/n8nio/n8n:2.44.6`), create the owner with a generated password in `out/n8n-owner.env` (`N8N_URL`, `N8N_EMAIL`, `N8N_PASSWORD`; gitignored), point its OpenAI credential "SAIL-PROXY (OpenAI)" at `http://host.docker.internal:8080/gateway/openai/v1` with a seeded user's key, and create the workflow "Ask SAIL-PROXY" (Chat Trigger, AI Agent, OpenAI Chat Model `gpt-5-mini`, Calculator). Before every take run `node screencast/stack/n8n-sign-in.mjs` with `out/n8n-owner.env` sourced: it signs `out/browser-profile` in to n8n and closes the chat panel n8n remembers; record with `SAIL_DOCS_BROWSER_PROFILE=$PWD/screencast/out/browser-profile`. The n8n shots (`--only n8n-…`) read the same env file.
- The Dex local sign-in page has the fields `#login` and `#password` and the button `#submit-login`; after the login a "Grant Access" click follows.

### GitHub sign-in clip (04 section 5, the teaser's "SSO." beat)

The Kyma test namespace is gone, so the GitHub sign-in is recorded on the demo stack (same Dex, oauth2-proxy and cockpit; no address bar on screen) and spliced into `out/04-kyma/clips/section-5.mp4`.

1. A GitHub OAuth App in the organization (here `sap-llm-gateway`) with the callback `http://localhost:8080/dex/callback`; its values in `out/github-oauth.env` (mode 600): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ORG`, `GITHUB_ADMIN_TEAM`, `GITHUB_USER_TEAM`.
2. `node screencast/stack/github-dex.mjs`, then with `SAIL_DOCS_ROLE_MAPPING` = the `ROLE_MAPPING` of `services/admin/.env` plus `"<org>:<admin team>":"admin"`: `… -f screencast/stack/compose.docs.yml -f screencast/stack/compose.github.yml up -d --no-deps dex admin`, and `docker restart sail-docs-nginx-1` (nginx keeps the old Dex address otherwise: 502).
3. `node screencast/stack/browser-login.mjs`: the maintainer signs in to GitHub in the recorder's profile (`out/browser-profile`), never approving the app. The real e-mail and name go into `redact.extra.local.json` (mapped to the demo admin).
4. Before each take, revoke the app under GitHub Settings → Applications → Authorized OAuth Apps (the Authorize page shows only until it is approved). `SAIL_DOCS_BROWSER_PROFILE=$PWD/out/browser-profile node record.js 04-kyma --steps github-sign-in --first-section 5` records up to Dex's Grant Access; sign in once more outside a recording (the Grant redirect then lands in the cockpit) and record `--steps github-cockpit` the same way.
5. GitHub's Authorize page names the redirect host (`http://localhost:8080`). Cover it with the placeholder Kyma host: render `https://sail-proxy-test.c-abc123.kyma.ondemand.com` as a 480×24 PNG (background `#0d1016`, text `#f0f6fc`, `600 12px/18px -apple-system, …` as GitHub's own CSS, line top 4 px, centred; at that offset the original line renders with a mean difference of 0.3) and overlay it at 720,629 on exactly the frames where the card is in place (`overlay=…:enable='between(n,<first>,<last>)'`, the frames found by comparing that strip with a settled frame), keeping the take as `github-sign-in/clips/section-5.orig.mp4`. `c-abc123` is the placeholder cluster: the redaction leaves it and the secret gate does not report it.
6. Splice, keeping the original as `clips/section-5.orig.mp4`: the original up to 42.0 s, `github-sign-in` 0.1–21.0 s, `github-cockpit` from 0.4 s (`ffmpeg … trim … concat`), and set section 5's `seconds` in `clips.json` to the result's length.
7. Back to the local sign-in: `… -f screencast/stack/compose.docs.yml up -d --no-deps dex admin`, restart nginx, and delete what the sign-in left in the demo database: the user's rows in `sap_llm_gateway_admin_users` and `…_userpreferences`, and Dex's `offline_session` / `auth_request` rows of connector `github`.

## Narration

`script.md` front matter: `video`, `title`, `subtitle`, `kicker`, `target_seconds`, `voice` (`marin`), `next`, `casts` (comma-separated), optionally `tighten_keep` (seconds kept at each edge of a shortened idle stretch, default 0.4; 06 keeps 0.65 so a client's answer and the generated image stay half a second longer), and `sections:` with one line `  - <n> | <MM:SS> | <title> | <outcome>` per section. Body: `## Spoken script` (paragraphs opened by `[MM:SS]`), `## On-screen cues`, `## Recap and next` (20 to 70 words, spoken over the outro) and `## Pronunciation` (`word: how to say it`, a hint in the instructions; `word = respelling`, which replaces the whole word, also inside hyphenated names, in the text the model reads, never in subtitles or cards; or `none`). The checker enforces 140 words a minute within 40 % to 110 % of the target, ascending cues, a cue in every section, every cast present and the step file agreeing on sections and casts.

Endpoints: `OPENAI_API_KEY` set → OpenAI, model `NARRATION_MODEL` or `gpt-realtime-2.1` (Realtime protocol); `NARRATION_MODEL=gpt-live-1` switches to the GPT-Live protocol (`/v1/live/sessions`, 5 cents per session minute, runs in real time). GPT-Live sounds more natural but follows pronunciation instructions less reliably (it said "Keima" for Kyma), so it is not the default. Else `SAIL_PROXY_BASE` and `SAIL_PROXY_KEY` → the gateway's realtime relay behind the TLS ingress with `gpt-realtime`. Voice `marin` on all of them; the key is read from the environment and written nowhere. On GPT-Live: it speaks injected text only while input audio flows, so the narrator streams silence as input and ends each chunk after 1.5 s of silent output; it may paraphrase, which the narrator reports per chunk as words missing from the transcript, and late in a long session it sometimes swallows the first word of a chunk. gpt-realtime-2.1 once added one ("To deploy-kyma"), so on OpenAI every chunk, on either model, is checked with gpt-4o-transcribe and spoken again (at most twice) when its first word is not heard; the gateway relay is not checked.

## Kyma video

Video 04 was recorded on 2026-10-20 with the tag `docs-800da807`. It is recorded against a disposable namespace next to production, never against production. Before anything is applied, the maintainer confirms the namespace and host (`sail-proxy-test`), the private image tag (built and pushed by the maintainer), the allowlist (the laptop's IP, typed at the setup prompt), the provider (local test accounts) and the teardown list. `GHCR_PULL_TOKEN` (a classic token with `read:packages` only) comes from the environment or `~/.config/sail-docs/secrets.env`; `SAIL_PROD_HOST` and `SAIL_DOCS_KYMA_SUBDOMAIN` are derived read-only from production's `allowlist-sail-proxy` policy; `SAIL_DOCS_KYMA_TAG` and `SAIL_DOCS_LAPTOP_CIDR` are exported in the recording shell. The `cleanup` cast is the teardown; after it, check that `kubectl get namespace sail-proxy-test` is NotFound, no object labelled `sail-proxy/namespace=sail-proxy-test` remains in `istio-system`, production's `allowlist-sail-proxy` still exists and production's `/gateway/health` answers 200. Remove `kyma/deployments/sail-proxy-test/`. The casts run with `HOME` in `out/scratch`, so link kubectl's token cache there first (`mkdir -p screencast/out/scratch/.kube/cache && ln -s ~/.kube/cache/oidc-login screencast/out/scratch/.kube/cache/oidc-login`), else every command opens a browser login. The `deploy` cast reads `KYMA_DEPLOY_CONFIG` from the environment (base64 JSON with `namespace`, `imagePullSecrets`, `containerRegistry`, `dockerUsername` and `dockerPassword`, the pull token); delete every raw log that holds it afterwards. Because the teardown is in the video, sections 1 to 5 are recorded while the namespace is up and section 6 in a second run after the teardown, the clips merged by hand.

## Casts

A cast definition is `{ cols, rows, cwd, env, setup, commands, title, timeoutMs }` (`title` is the cast header's title, default `<video>/<name>`; `timeoutMs` is the default wait for a prompt, 180000): `setup` commands run unrecorded, `commands` are typed at 12 characters a second into a clean interactive bash (`PS1='$ '`, `HOME` in a scratch directory, no profile) on a pseudo-terminal, and each waits for the prompt before the next. A command may be `{ cmd, input: [{ waitFor, send, pauseMs }], holdMs, timeoutMs }`: `waitFor` is a string or regex in the output since the previous step, matched on the raw output and on the output without its escape sequences (a full-screen client colours and positions text in pieces), `pauseMs` waits after the match before the keys go (time to read a result), `send` is typed (key names `<enter>`, `<up>`, `<down>`, `<tab>`, `<space>`, `<esc>`, `<ctrl-c>`, `<ctrl-d>`; a part `{ env: 'NAME' }` (displayed as the mask `••••••••`) is read from the environment at recording time and never written into the definition; give it `show` text, `{ env, show }`, and the cast displays `show` instead; a prompt that redraws its whole line on every key, as inquirer's input prompt does, prints every prefix of the value, so such a part also needs `redraw: true`, `{ env, show, redraw: true }`, and each echoed prefix is shown as the same share of `show`). Idle gaps play back capped at 2 s. Every cast goes through the redaction map, then the generic rules (hosts, addresses, key values, deployment ids, labelled secrets, long tokens), and is verified as one text before it is written. The recorder refuses a cast whose text still holds a real value, even wrapped at the terminal edge or redrawn with backspaces, so split long commands over lines.

The step file contract (`steps.js`) has `end()`: it closes the running clip, and later steps run unrecorded, for cleanup off camera. The `cast` step marks its timing at the player's first frame and a `cast-end` mark at its end. `play(name, { title })` plays `videos/<video>/clips/<name>.webm` in the same frame (the bar shows `title`) and is marked like a cast. `scroll(deltaY, { ms, x, y })` wheels the page under the pointer (default over the content, right of the cockpit navigation) in 100 ms steps, so the viewer sees it move; it stops wheeling where the scroll container under the pointer ends (further wheels made the 06 Models tab bounce) but still takes its full time. A caption stays on the picture when the app reloads the page itself (the language change in 05): the runner shows it again on load; `goto` clears it. `hold(ms)` waits like `wait` but the assembler never shortens it: use it for a result the viewer should read while nobody speaks (tightening otherwise cuts a silent, still stretch to 0.8 s).

## Lessons

- The `vitepress preview` file index goes stale: restart the preview after every `pnpm docs:build` (including the one `pnpm docs:check` runs), or new pages and images answer 404 and the og-image shot captures an old page.
- The API Keys Create page leaves a draft behind; the shot's `after` step discards it, otherwise the next run sees a draft row.
- The admin service reads `services/admin/.env` and then `docker/.env.auth`; the later file wins for a variable set in both, so change a sign-in or role value in `docker/.env.auth`.
- The seed moves its usage rows only once their count has been quiet for 20 seconds; moving earlier misses rows that are still being written.
- Four laptop keys calling the cheap chat model at once draw 429s from SAP AI Core; the gateway still records them as usage. Keep the seed's calls modest instead of retrying.
- The git commit guard blocks strings shaped like an AWS access key id (`AKIA` followed by 16 characters). Never write one into a doc, a test or a manifest; build such values at run time, or leave them out. The redaction rule names the pattern without containing a sample.
- The rendered `services/admin/.env` in this worktree points the admin test suites at the demo Postgres; run admin suites in another checkout while the stack exists.
- Disk: the Colima disk fills during the cold build. Free space only by removing this project's images (`docker rmi` of the three `docs-demo` images); build-cache cleanup is the maintainer's call; never `docker system prune` or a volume prune, the host holds unrelated volumes.
- The cast page keeps repainting after a cast ends so the last screen reaches the clip; `goto` runs `settled()` only on UI5 pages, and a section with no repaint gets a still clip. A typed key once wrapped and 4 characters reached an uncommitted cast, which is why the verifier unwraps and why long commands are split over lines (see Casts).
- The labelled-secret rule skips colour codes, localhost URLs and the `sail-proxy` command; widen it only with a test.
- In the install cast, `npm --version` comes before `node --version`; the other order reads as an IPv4 address.
- In long cockpit sections the picture can drift from `timing.json`: in 01 section 3 a caption logged at 81.8 s shows at 89 s of the clip, and the gap grows over heavy pages (the Deploy dialog, the tool inventory). The cause is not found yet (puppeteer's screencast keeps time on a plain 60 Hz animation). The recorder now writes each clip's wall-clock `measured` length into `clips.json` and warns when the video runs more than 3 % longer. Before cueing such a section, take the caption times from the clip itself: scene changes in the caption box, `ffmpeg -i clips/section-<n>.mp4 -vf "crop=560:44:30:1000,select='gt(scene,0.08)',showinfo" -f null -`.
- Captions that never reached the picture (after the team's Members anchor in 05, after the language reload in 05, on the cockpit after the GitHub sign-in) had one cause: `page.screencast` writes a frame only when the next one arrives, so on a page that is idle after the caption appears its frame was never written, while every probe outside a recording saw the caption. Since then a shown caption keeps an invisible pixel repainting (`lib/overlays/caption.mjs`). Setting a caption before a click that reloads still helps: the runner shows the last caption again on load.
- gpt-realtime-2.1 once opened 03's prerequisites line with "Okay, I'll read that aloud exactly as written:" and gpt-4o-transcribe dropped the phrase, so the first-word check passed. Each chunk must now also start with its first word in the model's own transcript, and the instructions forbid acknowledging the text. To audit a finished narration, transcribe the segments with `whisper-1`, which keeps such phrases.

## Teardown

When the screenshots are done and the stack is no longer needed, from the repository root with `COMPOSE_PROJECT_NAME` and `DOCKER_TAG` exported as under Stack:

1. Remove the demo records through the gateway and the admin: `node screencast/seed.js --teardown`.
2. Stop and delete the containers and this project's volumes. Read what `ps` lists before `down -v` removes it; each line runs only if the project name is `sail-docs`:

       [ "$COMPOSE_PROJECT_NAME" = sail-docs ] && dc ps
       [ "$COMPOSE_PROJECT_NAME" = sail-docs ] && dc down -v

3. If space is needed, remove only this project's images: `docker image rm ghcr.io/st-gr/sail-proxy-gateway:docs-demo ghcr.io/st-gr/sail-proxy-admin:docs-demo ghcr.io/st-gr/sail-proxy-nginx:docs-demo`. Clearing the build cache or any wider cleanup is the maintainer's call and is never run by this toolkit.
4. Stop `node screencast/proxy.js`, any `pnpm docs:preview` and any cast server (`lsof -nP -iTCP:4020 -sTCP:LISTEN` shows the PID).
5. Remove the scratch directories: `rm -rf screencast/out/scratch screencast/out/scratch-home`. The scratch home holds the CLI's `.env` with the real credentials (mode 600 under the gitignored `out/`).

## Teaser

`pnpm screencast:teaser --song "<path to Far Away - MK2.mp3>" [--version full|short|both]` cuts the recorded
tutorial clips, the logo, the architecture diagram and the end screen to the beat of "Far Away" (MK2, YouTube Audio
Library) into `out/teaser/teaser-full.mp4` and `teaser-short.mp4`, each with a poster. The song
is read from where it lies and never copied into the repository; the build refuses a file that is not 105.6 s long.

- `teaser/beats.mjs`: the grid (96 BPM, bar 2.5 s, crashes every 20 s) and the short edit (song 0–10, 50–80,
  100–105.625 s, joined with 20 ms crossfades). Cuts are placed on output frames from absolute times.
- `teaser/shots.mjs`: the shot list in song time (`at(bar, beat)`), each shot with its source (a clip of
  `out/<video>/clips`, an image, or a card: logo, tagline, diagram, end), effect (cut, push-in, pull-out, flash,
  slide-left, slide-up, glitch, wipe), optional text (punch word or title) and the versions it is in. The build
  refuses a list with gaps, overlaps, a window past its clip, or a crop that shows the tutorials' caption bar
  (x 0–1250, y 930–1080): keep clip crops above y 930 or right of x 1250.
- `teaser/layers.html`: the cards and text, rendered by the cards' browser (this ffmpeg has no drawtext).
- `teaser/qr-docs.svg`: the end screen's QR code for `https://st-gr.github.io/sail-proxy/`, made once with
  `npx qrcode@1.5.4 -t svg -e M -q 1 -d '#0B1F33' -l '#FFFFFF' -o screencast/teaser/qr-docs.svg "https://st-gr.github.io/sail-proxy/"`.
  The end screen is held 4 s past the music (`END_HOLD`), so the full cut runs 1:49.6 and the short one 49.6 s.
- `teaser/description.md`: the texts for YouTube, LinkedIn and the SAP community, with the music credit.

The clips must exist (record the six videos first). Watch both cuts once, all of it, before uploading.

