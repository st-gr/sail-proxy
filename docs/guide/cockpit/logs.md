---
title: Logs in the cockpit
description: Read, search, download and delete the gateway's log, and raise its log levels for a while, from the Admin Cockpit.
---

# Logs in the cockpit

The **Logs** application (Settings → Logs, administrators only) shows the gateway's log in the cockpit. You can follow it live, search it, download it and delete it, and you can change the gateway's log levels, also for a limited time, without creating a new configuration version. The page has three tabs: **Gateway log**, **Payload traces** and **Switches and levels**. The content of requests, when you choose to keep it, is on **Payload traces**.

Logs, with its payload traces, is part of the Docker and Kyma deployments. The standalone CLI has no cockpit: it writes the gateway's log to a file, which `sail-proxy logs` shows (see [Standalone CLI](/deploy/cli#logs)).

The gateway's log is stored for this page by default. To stop storing it, set **Gateway log** to **Off** under **Storage** on the **Switches and levels** tab, or set `enabled` to `false` in the configuration (see [Gateway log](/reference/configuration#gateway-log) in the configuration reference); the configuration decides only while the page's setting is **As configured**.

## The gateway log

Each row is one log entry with **Date and time**, **Level**, **Component**, **Request ID** and **Message**. Times are shown with milliseconds in your browser's time zone; the page names the zone beside the filter. When an entry carries an error, its text follows the message. The copy button beside a request ID copies it, so you can look for the same request elsewhere, for example in the gateway's own output.

### Live and the order of the entries

The page opens with **Live: on** and, unless **Newest first** was chosen before in this browser, **Newest last**: new entries appear at the bottom and the view follows them. Scroll up to read, and the following pauses; new entries are still added below, and **Go to the newest entries** takes you back. A status line above the table says what the view is doing.

- **Newest first** turns the order around: new entries appear on top. The page remembers your choice in this browser.
- **Live: on** and **Live: off** switch the following on and off. Choosing a time range switches Live off and shows that period; switching Live on again shows the newest entries.

### Filter

- **From** and **To** choose a time range; one of them may stay empty. **Last 15 minutes**, **Last hour** and **Today** fill both in.
- **Search** finds the text as you typed it, with upper and lower case treated alike, in the message, the component and the request ID. Press Enter to apply it. Matches are shown in bold.
- **Lowest level shown** hides the levels below the one you choose.
- **Refresh** reads the entries again.

The view holds the newest 2,000 entries. When more entries match, a note says how many older ones are not shown; choose a shorter time range, or export them.

### Export

**Export** downloads the entries of the current time range, search and level as a text file, one line per entry, oldest first, with the time in UTC. The file holds at most 100,000 lines; when more entries match, its last line says so. Without a time range (in Live) the export covers every stored entry and, when it is cut, holds the oldest ones: choose a time range, for example **Last hour**, to export recent entries.

The export is also part of the admin service's API, listed in the [API reference](/reference/api) that the cockpit serves. It needs the session of a signed-in administrator; there is no API key for it.

### Delete now

**Delete now** asks what to delete: **Delete the log** (every stored entry of the gateway log), **Delete the traces** (every stored payload trace with its raw stages, see [Payload traces](#payload-traces)) or **Delete both**. It cannot be undone. The gateway's own output and any log system outside sail-proxy are not touched, and the entries and traces the gateway sends afterwards are stored again. Each deletion is recorded in the [audit trail](/guide/cockpit/operations#audit-trail), with who did it and how many entries went.

## Payload traces

The gateway's log never holds the content of requests. The **Payload traces** tab is where an administrator can look at content, on purpose and with a record of who looked. It has two parts: payload capture, which leaves a light trace of every request, and raw capture, which keeps every stage of the requests of chosen keys and users for a short time. A bar at the top of the tab says what the capture keeps right now.

### Payload capture

**Payload capture** is the **Payload traces** setting under **Storage** on the **Switches and levels** tab: **As configured**, **On** or **Off**. It is off by default; the configuration decides (`observability.payload_capture.enabled`, see [Payload capture](/reference/configuration#payload-capture)) only while the setting is **As configured**.

### Payload files

Separately from payload traces, the gateway has a debug switch that writes the content of requests to files: `PAYLOAD_LOGGING_ENABLED=true` in the gateway's environment, or `platform.logging.payload_logging_enabled` in the configuration. These files are not masked in every stage, and nobody's reading them is recorded. While the switch is on, the **Payload traces** and **Switches and levels** tabs show a warning. Payload traces and raw capture are the audited way to look at content: switch the files off unless you are debugging. Where the files go is described for [Docker](/deploy/docker#payload-files), [Kyma](/deploy/kyma#payload-files) and the [standalone CLI](/deploy/cli#payload-files).

While payload capture is on, every request leaves a light trace with its facts (time, route, model, API key and user, status, duration and tokens) and:

- for a request that is masked by pseudonymization: the masked prompt and the masked answer, which hold placeholders instead of personal data;
- for a request that is not masked: its prompt, stored encrypted. Opening it with **Show content** is recorded in the [audit trail](/guide/cockpit/operations#audit-trail) under your name. Its answer is not stored;
- for a request masked by anonymization: the masked prompt, and no answer.

The table lists the traces of a time range, which you choose with the quick buttons or **From** and **To**; the filter finds text in the masked prompt and answer, the request ID, the model, the route, the API key and the user. Choose a row to open the request: its **General** tab shows the facts and the content, which **Download trace** saves as a file; a request captured raw also has a **Raw capture** tab with its stages, which you open when you want to see them. A request ID in the **Gateway log** links to its trace, and back.

Light traces are kept for 48 hours (`retention_hours`).

### Raw capture

Raw capture is for finding out what exactly happened to a request: it keeps the content as it was, not masked.

**Start raw capture** asks for:

- the **API keys** (and AWS credentials) to capture, and/or the **E-mail addresses of users**, separated by commas or line breaks, for example `jane.roe@example.org`;
- the time: **15 minutes**, **1 hour** or **4 hours**, within `raw.max_duration_minutes`;
- a **Reason**, for example a ticket number.

The session ends by itself at its end time, or sooner with **Stop**; the running sessions are listed with their end. A user's e-mail address is turned into the user's keys and credentials when the session starts: keys created afterwards are not included.

Each captured request keeps its stages:

- the request as it arrived;
- every stage the gateway records on the way: what was sent to SAP AI Core, its answer, the answer after the gateway transformed it, the stages of a streamed answer, and errors;
- what the client received.

Credentials in headers and URLs are blanked. A request that is refused at sign-in is not captured; one that is refused later (quota, policy, model access) is.

Stages are stored encrypted for 24 hours (`raw.retention_hours`). On the **Raw capture** tab of a request each stage can be viewed with **View** and saved with its download icon, and **Download all stages** saves all of them in one file. Every view and download is recorded in the audit trail under your name. A stage larger than 256 KB is cut, as are the stages beyond the 40th and those beyond 2 MB for one request, of which room is kept for what the client received; the table marks them **Cut**. These limits are settings of the configuration.

While a raw capture runs, an orange bar on every page of the cockpit tells administrators which keys and users are captured, who started it and when it ends. With payload capture off, a request of a raw capture still leaves a light trace, with its facts only and no prompt or answer.

### The key

Stages and unmasked prompts are encrypted with a key derived from the `METADATA_ENCRYPTION_KEY` of the gateway and the admin service. Both services must hold the same value; the Docker and Kyma setups see to it. If the value is missing, shorter than 32 characters or one that is published with the product, capture still works, but anyone who knows the value can decrypt what was captured. The gateway's console, the **Payload traces** tab and the start dialog then warn; set a long random value.

Payload traces and raw capture are not part of the standalone CLI.

## What is stored and what is not

The page stores the entries at or above the stored level, which is INFO unless the configuration says otherwise (`min_level`). An entry must also pass the gateway's own log level: with **Default level** at WARN, INFO entries are neither written nor stored. An entry keeps its time, level, component, request ID, message and the error's name and text. A long message is cut at 2,000 characters, an error at 500.

Not stored:

- the access lines of the gateway's health check;
- the details the gateway prints after a message in its own output;
- DEBUG and TRACE lines, unless the stored level is lowered. They can contain parts of requests and answers, so lower it only while you look into a problem;
- anything that is printed outside the gateway's log, such as warnings of Node.js itself.

The content of requests and answers, and the bodies of upstream answers, are kept out of the stored messages. Where an upstream refused a request, the entry names its status, its short error code when it gives one, and the upstream's own error message, cut at 300 characters; that message can quote a few words of the request. The full text stays in the gateway's own output: `docker compose -f docker/docker-compose.yml logs gateway` on Docker, `kubectl logs` on Kyma.

Entries are kept for 48 hours, and at most 2,000,000 of them; the oldest go first. Both limits are settings of the configuration (`retention_hours`, `max_entries`), described in [Gateway log](/reference/configuration#gateway-log). The entries take space in the admin service's database: on a small database, lower `max_entries`.

If the admin service is not available, the gateway keeps answering requests. Its entries wait for the admin service, for about five minutes, and are stored when it is back; during a longer absence the oldest waiting entries are lost, without a count. If the gateway cannot hand its entries over at all, it keeps up to 5,000 of them, drops the rest and says in its own output how many it dropped. The gateway's own output is always complete.

## Switches and levels

| Section | Setting | Choices |
|---|---|---|
| **Storage** | **Gateway log** | **As configured (…)**, **On** or **Off**: whether this page stores the gateway's log |
| **Storage** | **Payload traces** | **As configured (…)**, **On** or **Off**: see [Payload capture](#payload-capture) |
| **Log levels** | **Default level** | **As configured (…)**, or **ERROR**, **WARN**, **INFO**, **DEBUG**, **TRACE**, for the time chosen under **Applies for** |
| **Log levels** | **Component levels** | A level for one component, by its name as the **Component** column of the **Gateway log** tab shows it, for the time chosen under **Applies for**. The list offers the names of the stored log and the configured ones; you can also type a name. The name must match exactly, including upper and lower case: the field warns about a name no stored log line has |

The first choice of each list shows what the configuration says in brackets, for example **As configured (On)**: with it, the setting follows the configuration, also when another configuration is activated later. The **Configured** column shows each component's level from the configuration.

**Applies for** appears once you choose a level yourself: **Until changed**, **15 minutes**, **1 hour**, **4 hours** or **24 hours**, and, while a time limit runs, **Keep the current end**. The page shows when a limit ends; within about a minute after that, the level falls back by itself, as long as the admin service is running.

A higher level makes the gateway write more to its own output. When a level writes lines below the stored level, the page says so: those lines do not reach the **Gateway log** tab. See [What is stored and what is not](#what-is-stored-and-what-is-not).

**Save**, **Reset to configuration** and **Cancel** are at the bottom of the tab. **Save** and **Cancel** become available once you change something; **Cancel** brings back what is saved. **Save** asks first; the gateways apply the settings within seconds, without a restart. No configuration version is created: the values of this page are laid over the active configuration and stay in force when another configuration is activated. Saving replaces what was set on this tab before; **Reset to configuration** clears it, also after asking first. Configuration Management keeps showing each configuration's own values. Every change is recorded in the [audit trail](/guide/cockpit/operations#audit-trail).

If the gateway cannot be told at once, the page says so: the settings are saved, and the gateway gets them the next time it loads its configuration. In a local development setup without Valkey, a level with a time limit is saved but not passed to the gateway, because the gateway could not be told when it ends; the page says that too. Choose **Until changed** there.

### Settings fixed by the gateway's environment

An environment variable of the gateway has the last word. A setting it fixes shows its value and the variable instead of a list, for example **DEBUG – set by LOG_LEVEL on the gateway**:

- `LOG_LEVEL` fixes the default level. Component levels still work.
- `GATEWAY_LOG_SHIPPING=off` keeps storing off.

Until a gateway has reported its environment for the first time, the page says that it cannot show these yet. To give a setting back to this page, remove the variable from the gateway's environment and start the gateway again:

- Docker: an installation set up with 0.12.1 or earlier keeps `LOG_LEVEL=INFO` in `services/gateway/.env` through the upgrade. Delete the line, then run `docker compose -f docker/docker-compose.yml up -d gateway` (a plain `restart` keeps the old environment).
- Kyma: the setup no longer sets these variables, and `sail-proxy upgrade kyma` removes them. Only a value added to the `gateway-config` ConfigMap by hand stays; remove it there, then run `kubectl -n sail-proxy rollout restart deployment/gateway`.
