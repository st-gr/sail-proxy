---
title: SAIL-PROXY User Guide - Chapter 8
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-7-github-copilot.md) | [Content Table](README.md) | [Next Chapter >>](chapter-9-roles.md)

---

## Manage Access & Monitor Usage with Admin Cockpit

The Admin Cockpit is a web-based management interface available in Docker deployments. It covers API key administration, gateway-issued AWS SigV4 credentials, usage analytics, security notifications, and gateway configuration.

**Note**: The Admin Cockpit is only available in Docker deployments, not in the CLI version.

### Accessing the Admin Cockpit

#### Prerequisites
- **Docker deployment** of SAIL-PROXY with authentication configured
- **Valid user account** through your configured identity provider
- **`admin` role** — API key administration, credential management and configuration changes are restricted to it. A few read-only and self-service operations (such as a user's own notification state) are open to the `user` role.

#### Login Process

1. **Navigate to the Admin Cockpit**:
   - URL: `https://your-domain.example.invalid/admin/` or `http://localhost:8080/admin/`

2. **Authenticate** through your configured identity provider.

3. **Access the shell**, which hosts the individual applications.

Roles are supplied by your identity provider and evaluated as CDS `@restrict` rules on the service. The cockpit does not assign or edit roles itself — see [Chapter 9](chapter-9-roles.md).

### The Applications

The cockpit shell hosts eight applications:

| Application | Purpose |
|---|---|
| API Keys | Create, rotate, enable/disable and delete gateway API keys |
| AWS Credentials | Issue and manage SigV4 credentials for the Bedrock-compatible route |
| Usage Analytics | Request, token and latency statistics by provider and model |
| Security Notifications | Review, snooze, pin and dismiss security notifications |
| Model Library | Browse the models available through the gateway, their specifications, benchmarks and token prices; administrators maintain prices and create deployments |
| Entitlements & Quotas | Define which models a user may use (catalogs) and how much they may use (quota profiles): a default catalog for everyone, administrator catalogs and quota profiles assigned per user, and personal catalogs within the assigned one |
| Users & Quotas | Administrators constrain, deactivate and reactivate users and reset their quotas; usage per day, week and month next to the limit |
| Configuration | Versioned gateway configuration with activation and rollback |

The home page shows this month's key metrics as tiles — requests, tokens and SAP cost in the billing
currency, for your own usage or, as an administrator, for every user (plus the number of users with
usage) — each opening Usage Analytics, and a "My quota" card with the signed-in user's own
consumption against their limits.

### API Key Management

#### Creating API Keys

Create a key from the API Keys application by supplying:

```
Name:  Development Key - John Doe
Email: john.doe@example.invalid
```

The generated key is returned **once** and is not retrievable afterwards. Copy it immediately and store it in your password manager.

Key format: `sk-` followed by 48 hexadecimal characters.

Only a masked form of the key is stored for display in the list report.

#### Managing Existing Keys

Each key record carries:

```
Name:        Development Key - John Doe
Email:       john.doe@example.invalid
Masked Key:  sk-1a2b...
Status:      Active
Expires At:  2025-02-14 09:30 UTC
Last Used:   2025-01-28 14:22 UTC
Usage Count: 47
Created:     2025-01-15 09:30 UTC
```

**Key Operations**:
- **Rotate**: generate a new key value while preserving the record and its configuration
- **Update key value**: set a specific key value
- **Disable / Enable**: deactivate or reactivate a key without deleting it — administrators only
- **Delete**: soft delete — the record is marked deleted rather than removed
- **Disable by email**: deactivate every key belonging to one email address in a single action

**Expiration**: the standard period is 90 days, unless an administrator has configured a different
one. It applies to API keys and AWS credentials alike. When you start creating a key, Expires At is
already filled in with that standard period, so you can accept it as it stands or — as an
administrator — pick another date. A key past its expiration date is rejected the next time it is
presented on any route, once any cached validation for it has lapsed (a few minutes at most); an
administrator's changes to a key take effect immediately.

An expiration date can only ever be set forward: a date in the past is rejected, on creation and
when editing an existing key.

**Never Expires**: an administrator can mark a key as never expiring. A key with the flag set
ignores Expires At entirely — the date is cleared and shown read-only, the key is never rejected
for age on any route, and refreshing it leaves it without a date. Turning the flag off gives the
key the standard expiration period again: the date reappears in the form as soon as you clear the
checkbox, counted from that moment, and you can overwrite it before saving. Only an administrator can set or clear the flag; key owners see
it but cannot change it. Keys that predate this flag and carried no expiration date were migrated
to it, so they keep working exactly as before, now visibly rather than implicitly.

Refreshing a key — the Rotate operation — issues a new key value and moves the expiration date
forward by the standard period, whether the owner or an administrator does it. A key that is
already inactive or already past its expiration date cannot be refreshed by its owner; an
administrator can still refresh it, which brings it back with a fresh expiration date. (This
administrator override is specific to API keys: an inactive AWS credential cannot be rotated by
anyone, administrators included — it must be re-enabled first. See AWS Credential Management below.)

Only administrators change the Active state, the expiration date or the Never Expires flag of a
key — key owners cannot, not even on their own keys. Owners may rename, refresh and delete their
own keys.

#### Rate Limiting

Each key (and each AWS credential) carries its own requests-per-minute, -hour and -day limit,
enforced by the gateway. The owner or an administrator sets these with "Set Rate Limits" on the
key or credential; clearing a value removes that limit. A user-level requests-per-minute limit
applies in addition — see [Users & Quotas](#users--quotas) — so a request has to pass both the
key's limit and the user's.

#### Permissions

Keys carry permission entries such as `models:read` or `chat:create`, each with an optional scope restriction, recorded with who granted it and when.

### AWS Credential Management

This section covers credentials for the **Bedrock-compatible route**, which accepts AWS SigV4-signed requests.

**Important**: these credentials are **issued by the cockpit**. They are not your AWS account credentials, and the cockpit does not accept an existing AWS access key. Clients use the issued credentials to sign requests to SAIL-PROXY; SAIL-PROXY verifies the signature.

#### Issuing Credentials

Supply a name, description, expiry and permissions. As with API keys, Expires At is preset to the
standard period (90 days, unless an administrator has configured a different one); accept it as it
stands or — as an administrator — pick another date. A date in the past is rejected, on creation and
when editing an existing credential. The cockpit generates and returns:

```
Access Key ID:     AKIA... (16 characters)
Secret Access Key: [returned once only]
Region:            ...
Expires At:        ...
```

The secret is shown once at creation and once again after a rotation.

#### Credential Operations

- **Rotate**: issue a new access key ID and secret for the record, and move Expires At forward by
  the standard period, whether the owner or an administrator does it. Rotate only works on an
  active credential — an inactive one must be re-enabled first, by an administrator; this differs
  from API keys, where an administrator can refresh an inactive key directly.
- **Enable / Disable**: control whether the credential is accepted
- **Delete**: remove the credential; the usage it produced stays on record and keeps counting
  against the owner's quota
- **IP restrictions**: restrict a credential to given source addresses
- **Permissions**: restrict what the credential may do

A credential past its expiration date is rejected the next time it is presented on any route, once
any cached validation for it has lapsed (a few minutes at most); an administrator's changes take
effect immediately. Expired credentials are listed separately from active ones.

**Never Expires**: as with API keys, an administrator can mark a credential as never expiring. The
flag clears Expires At and shows it read-only, the credential is never rejected for age, a rotation
leaves it without a date, and it never appears among the expired credentials. Turning the flag off
gives the credential the standard expiration period again: the date reappears in the form as soon
as you clear the checkbox, counted from that moment, and you can overwrite it before saving. Only
an administrator can set or clear it; credential owners see it but cannot change it.

#### Security Features

**Signature verification**: the gateway implements AWS Signature Version 4 verification for inbound requests on this route.

**Encryption at rest**: the secret access key is encrypted with AES-256-CBC before storage, using a key derived from the configured encryption secret. It is decryptable by the service because signature verification requires the original secret.

**Auditing**: credential usage, rotations and security events are recorded per credential.

### Usage Analytics

The Usage Analytics application reports, broken down by provider and by model:

- Total requests
- Input tokens
- Cache-creation tokens and cache-read tokens
- Output tokens
- Average response time
- Error count
- Cost per token, where cost data is available

**Export**: the table can be exported as **CSV**.

### Security Notifications

The Security Notifications application presents security notifications raised by the system, with these operations:

- Mark seen / unseen
- Dismiss
- Snooze until a chosen time
- Pin / unpin
- Delete
- Bulk mark-seen and bulk delete across selected notifications

Each user sees their own notification state.

Each notification shows the client IP, user agent, endpoint and request ID of the event it reports.
Whether the IP is the caller's or the proxy's depends on the `trust_forwarded_for` platform setting
(Configuration Management → Platform → Security).

### Model Library and Entitlements & Quotas

**Model Library** (Models → Model Library) shows the models the gateway currently offers, as SAP AI
Core publishes them. Every user sees the models in their entitlement; administrators see all.

- **Filter pane.** Provider, capabilities (one at a time), input types, model provisioning (SAP
  Hosted, SAP Managed, Remote), access type (LLM Access, Orchestration) and the switches *Latest
  Version Only*, *Streaming Support* and *Show Deployments*. Every group has its own reset, and the
  active settings appear as removable tokens above the cards. The search box matches names and
  identifiers.
- **Card badges.** A card is marked *Deployed* when the model has a deployment of its own,
  *Deployment* when the card is that deployment's entry (visible with *Show Deployments* on), and
  *Retires <date>* when SAP has announced a retirement date for the model. A model SAP AI Core
  offers only through a deployment of its own is marked *Deployment only*: the gateway cannot call
  it by name, but once deployed it answers under its `--deployed` id. *Not callable* marks the rare
  model SAP allows neither way.
- **Modes.** *Catalog* shows one card per model; *Leaderboard* lists published benchmark scores;
  *Chart* plots two benchmarks against each other — choose the axes above the chart. Leaderboard and
  chart always list foundation models, never their deployments, which carry the same scores.
- **Model details.** Metrics (safety and quality benchmarks), Cost, Properties, Configuration (the
  model's and its provider's settings in the active gateway configuration), Deployments and Catalogs.
- **Cost.** Prices are shown in SAP capacity units per million tokens, with the published price per
  thousand tokens and the conversion factor in brackets so you can see how the figure is derived. When
  no conversion factor is configured, a warning says the SAP default is used. Administrators can *Edit
  price* to override a published price and *Revert to SAP price* at any time; the price history lists
  every change.
- **Deployments** (administrators). *Fetch Deployments* lists the model's SAP AI Core deployments.
  *Deploy* creates one: it reuses an existing configuration or creates one, starts the deployment and
  waits up to five minutes for it to run. Deployments incur cost until they are stopped in the SAP AI
  Launchpad.
- **Refresh** (administrators) re-reads the model list from the gateway.

**Entitlements & Quotas** (Models → Entitlements & Quotas) decides which models a user may call and
how much they may use. A switch at the top of the list chooses between **Catalogs** and **Quota
profiles**.

**Catalogs** decide which models a user may call through the gateway. The gateway lists only entitled
models on `/v1/models` and refuses requests for other models.

- The **Default** catalog applies to everyone without an assignment. It contains every model unless an
  administrator excludes it (*Exclusions* tab). New models published by SAP are entitled automatically
  until excluded.
- Every change to a catalog — its **name and description**, the **models** in it, the Default
  catalog's **exclusions** and the user **assignments** — is collected and written together with
  *Save*; *Discard* drops all of it. A model or user changed but not yet saved is marked as such in
  its row, the footer counts the unsaved changes, and leaving a catalog with unsaved changes asks
  before dropping them. If part of a save is refused, what was refused stays marked unsaved with the
  reason; the rest is written.
- Administrators create catalogs over all models and **assign** one to a user (*Assignments* tab);
  the assignment takes effect on *Save*. Re-assigning a user trims their personal catalogs to the new
  catalog. Select several users and use *Assign to this catalog* or *Unassign* to change them
  together; the search box narrows the list by e-mail or assigned catalog.
- Every user can create personal catalogs within their assigned catalog: *Add models* offers only
  models the assigned catalog contains. Removing a model from a parent catalog also removes it from
  the catalogs below it.
- The Default catalog cannot be deleted. A catalog that is assigned to a user or has child catalogs
  cannot be deleted until those are reassigned or removed.

**Quota profiles** decide how much a user may use. A profile is a named set of seven limits —
requests per minute; tokens per day, week and month; and spend per day, week and month — that an
administrator assigns to a user. A user's effective limit for each of the seven values is, in order:
their own constraint if one is set, else the assigned profile's value, else the platform default from
the configuration, else unlimited. An administrator can still set a user's own constraint above the
assigned profile.

- A profile carries a **name**, a **description** and the seven limits; the *Assignments* tab assigns
  it to users. As with catalogs, every change — name, limits, assignments — is collected and written
  together with *Save*, and *Discard* drops it; leaving a profile with unsaved changes asks first. An
  assignment marked **(unsaved)** does not take effect until *Save*.
- Deleting a profile that still has users assigned is refused, naming them; reassign or unassign those
  users first.
- The first time the cockpit starts with no profiles, it creates three starter profiles:

  | Profile | Requests/min | Tokens/day | Tokens/week | Tokens/month | Spend/day | Spend/week | Spend/month |
  |---|---|---|---|---|---|---|---|
  | Light | 30 | 500,000 | 2,000,000 | 5,000,000 | 25 | 75 | 150 |
  | Standard | 60 | 5,000,000 | 20,000,000 | 60,000,000 | 250 | 1,000 | 3,000 |
  | Power | 200 | 25,000,000 | 100,000,000 | 300,000,000 | 1,500 | 6,000 | 12,000 |

  Spend figures are in the billing currency shown on the page. These three are starting points
  derived from a real deployment's usage, meant to be tuned from the home tiles and Usage Analytics
  once you see your own traffic. After that first creation they are ordinary profiles like any other
  you create yourself — edit or delete them freely. If all three are ever deleted, they are created
  again the next time the cockpit starts.

### Users & Quotas

Administrators use this application to see and manage every user's quota consumption and account
status.

**List**: sorted by last seen, showing e-mail, display name, status, last seen, and tokens and spend
this month against the limit. Spend figures and spend limits carry the currency of the SAP capacity
unit price and are shown with that currency's decimals. Select one or more rows and choose
**Reset Quota** to reset them together.

A token figure or token limit on this page always means input, output and cache-write tokens.
Cache-read tokens are priced — they count toward spend — but are never counted toward a token limit
or a token usage figure. If a token figure here reads lower than it used to for the same activity,
this is why.

**Object page**:

- **Constraints** — the user's own limits, grouped as *Requests*, *Tokens* and *Spend*. Under each
  field a **Default** line shows what applies while the field above it is empty, and where that value
  comes from — for example "(Standard profile)" when the assigned quota profile supplies it,
  "(platform)" when the platform-wide default supplies it, or "unlimited" when neither applies. An
  administrator can still set a user's own value above the assigned profile. Within tokens and within
  spend the windows have to be ordered — a day's limit cannot be higher than a week's, nor a week's
  higher than a month's — and a save that breaks the order is refused with a message naming the two
  fields.
- **Usage** — used, limit and remaining for each window (requests per minute; tokens and spend per
  day, week and month), with when each window resets. The limit shown here is the same effective
  limit as under Constraints, and its source can now be the user's own constraint, an assigned quota
  profile, or the platform default. The figures are kept as running counters and update within about
  a minute of a request; "requests" counts requests served by the gateway.
- **API Keys** and **AWS Credentials** — the user's credentials, read-only here: whether each is
  active or locked because the account was deactivated, and its own rate limits.
- **Entitlement** — the quota profile and the catalog assigned to the user, both read-only here.
  Change the quota profile from Entitlements & Quotas' *Quota profiles* mode, *Assignments* tab;
  change the catalog from its *Catalogs* mode, *Assignments* tab.
- **Record** — when the user was first and last seen.

**Actions**:

- **Deactivate** asks for a reason, then locks every active credential of the user and blocks new
  credentials from being created for them.
- **Reactivate** restores exactly the credentials that Deactivate locked.
- **Reset Quota** clears the user's recorded usage.

A deactivated user cannot receive new credentials until the account is reactivated.

### Configuration Management

The Configuration application manages gateway configuration as **versioned records**:

- **Create** a new configuration version
- **Validate** a configuration before activating it
- **Activate** a version, making it the live configuration
- **Roll back** to a previous version
- **History**: review previous versions and the current activation status

#### Form View

A configuration's detail page carries a **JSON / Form** toggle in its title bar. **Form** shows the
whole `api_config` document as typed controls — six tabs, one per top-level group — instead of raw
JSON. The JSON editor is never taken away: the toggle switches back to it at any time, and it stays
the way to make a change the form does not offer.

**The gate.** Form is enabled only while the configuration's **whole document** passes the same
schema the backend enforces on save. The check runs in the browser, for **every role** — not only
admins — so an admin and a non-admin get the same verdict on the same document. While it does not
pass, the toggle is disabled and its tooltip names the failing JSON pointer, for example:

> This configuration does not pass schema validation and cannot be shown as a form. Use the JSON editor.
> Schema validation error at '/api_config/platform/timeouts/default': must be integer

The form is a faithful view or it is not offered at all — that is what the gate is for. Fix the
document in the JSON editor and the toggle enables again.

**The tabs.** Six, alphabetical: **Capabilities**, **Hooks**, **Models**, **Observability**,
**Platform**, **Providers** — the six groups the `api_config` schema allows and no others. Each tab
holds one collapsible panel per section that group declares, also alphabetical: the Platform tab,
for instance, carries Logging, Rate Limit Handling, Security and Timeouts. The tab you were last on
survives a redraw of the form.

**Sections the document does not carry.** Such a section shows the notice *Not present in this
configuration.* rather than an empty panel — showing a section's fields at their schema defaults
would invite you to read defaults as configured values. Below the notice is **Add section**, whose
tooltip reads *Add this section to the configuration, empty, so its settings can be filled in here*.
Pressing it writes the empty container — `{}`, or `[]` for a list — at that section's own place in
the document and redraws the panel with its fields, its own **[+]**, or both; a toast confirms
*Section added. It is not saved yet.* Nothing reaches the database until you save.

This is what makes the form usable on a configuration that carries only a handful of settings. Before
it, a section the document lacked was a dead end: the JSON editor was the only way to bring one into
existence.

**Fields.** Every field carries an **information icon** beside its label. Pressing it opens a popover
holding the schema's own description of that setting — what reads it, what it does, and what happens
if it is wrong. The same description remains available as the control's hover tooltip; the icon is
there because a tooltip nobody hovers is a description nobody reads. Sections carry the same icon
next to their title where the schema describes them. A field the schema requires is marked with the
standard required-field indicator. Enumerations render as dropdowns over exactly the values the
schema allows, numbers as numeric fields carrying their own minimum and maximum, booleans as
switches. A value that genuinely cannot be represented as a typed control is shown as JSON in place,
with a notice saying why, rather than being silently dropped.

**Provider panels.** Each of the six providers the gateway reads — Anthropic, AWS Bedrock, Google,
Openai, Openrouter, Perplexity — shows only the settings its own request path reads, not the union of
all six. Six settings are common to most providers: Emulate Streaming For Models, Substitute Models,
Unsupported Params, Param Renames, Supports Responses API and Supports Prompt Caching. **Google** is
the exception and the narrowest panel: it holds Substitute Models alone, because that is the only one
its route reads. Anthropic Bedrock Version,
Excluded Beta Headers and Supported Beta Headers appear on **Anthropic** and **AWS Bedrock** only,
because only the Anthropic request path reads them; Openai adds its Azure api-version, Openrouter its
fallback prices and model mappings. A setting written under a provider that does not read it is
refused by the gate rather than kept as a value that quietly does nothing — so a beta-header list
belongs under Anthropic, not under Openai. A provider key the gateway does not read yet is still
accepted, with the six common settings and no restriction on what else it carries.

**Tuning masking, under Observability → Pseudonymization.** Four fields decide precision, and each
one is also available per endpoint (**Hooks → Defaults**) and per model (**Models → Overrides**).
`min_confidence` (0 to 1, default 0.5) is how much evidence a value needs before it is masked, and
`thresholds` overrides it for one category at a time. **Leave both alone unless you have measured
the effect.** A plain name — no honorific, no mail address beside it — scores exactly 0.5, so one
step up to 0.55 stops roughly three quarters of the names in ordinary prose being masked, whether
you take that step globally or only for `profile-person`. Mail addresses, IBANs, card numbers and
credentials are unaffected up to 0.8, so raising the bar is a reasonable way to quieten one of
*those* categories and never a way to quieten names. To stop one particular value being masked,
name it in the allow-list below — that is what it is for.
`allowlist` names what must never be masked here: `terms` are literals,
compared case-sensitively against the whole detected value, and `patterns` are regular expressions
the gateway anchors to the whole value for you, so write `Z[A-Z0-9_]+` rather than `^Z[A-Z0-9_]+$`.
An entry in either list wins over every score. The allow-lists of the three layers are added
together rather than replaced, so a per-model list extends the global one and can never cancel it.
`saturation_warn` (default 40) only reports: above that many distinct masked values in one request,
the gateway logs one line with the counts per category and the value shapes — letters as `X`, digits
as `9`, never a value — and the request's usage SIEM event says `saturated: true`. The masking
itself is unchanged by it; a request that trips the number still masks everything it found.

**Keyed maps.** Twenty-two places in the schema are open-ended maps rather than a fixed set of
fields — among them the per-provider map under **Providers**, the per-model map under **Models →
Overrides**, the endpoint and subpath maps under **Hooks → Defaults**, `hooks.definitions`, each
provider's and each model override's `param_renames`, the `entities` and `thresholds` maps of every
pseudonymization block, `platform.logging.components`, and the two delay maps under **Platform →
Rate Limit Handling**. Every one of them carries the same affordances:

- **[+]** to add a key, on an editable form. The dialog rejects an empty key, a key whose spelling
  the map does not allow, and a key already present — naming the clash: *The key "anthropic" is
  already configured here. Choose a different key, or edit the existing "anthropic" panel.* Where
  the schema constrains the spelling, the dialog says so and enforces it over the **whole** key, not
  a fragment of it: `bad key` in `platform.logging.components` is refused with *The key must match
  this section's own rule: `^[a-zA-Z0-9_-]+$`*, and the dialog stays open. A new key is created with
  a schema-valid empty entry — for a map of plain values, at the value the schema defaults to, so a
  new `components` entry starts at `INFO` — and is not stored until you save;
- **[-]** to remove one key, after a confirmation that names it and says everything under it goes
  with it;
- a **filter** above the entries, which hides and reveals panels without changing the document, and
  stays usable on a read-only configuration — a two-dozen-entry override list is no easier to read
  for someone who may not edit it. A **top-level** map — Providers, Model Overrides, Hook
  Definitions, Hook Defaults — always shows its filter, so the row above the entries does not appear
  and vanish as entries are added. A map **nested inside a section** shows one only once it holds
  **more than eight** entries: a search box over two delay overrides is an affordance for a problem
  nobody has.

**Lists.** A list the form renders as panels rather than a table carries **[+]** to append an entry.
For a hook list under **Hooks → Defaults → *endpoint* → *subpath***, **[+]** appends an entry
carrying every field the schema *requires* and nothing else, so it starts valid in shape and empty in
content; a toast confirms *Entry #0 added. It is not saved yet.* Such entries are numbered `#0`,
`#1`, … and open collapsed. The SIEM sink list is the one whose entries pick their fields by their
`type`, so its **[+]** opens the sink dialog described under *SIEM Sinks and Credentials in the Form*
instead; the sink's remaining required fields are filled on its panel afterwards.

**Editability.** JSON-backed fields are editable only for an **admin** on an **inactive**
configuration — two independent conditions:

| Role | Configuration | Fields | Save / Cancel |
|---|---|---|---|
| admin | inactive | editable | shown |
| admin | **active** | read-only | hidden |
| non-admin | inactive | read-only | hidden |
| non-admin | active | read-only | hidden |

An active configuration additionally shows the same message the JSON editor already shows for one:
"This configuration is currently active and therefore read-only. Deactivate it first to make
changes." **Add section**, the map and list **[+]**/**[-]** and the SIEM sink affordances follow the
same rule and are absent altogether on a read-only configuration — the information icons stay, so the
schema's descriptions remain readable by anyone who can see the configuration at all.

**Minimal documents.** The form does not require a complete configuration. A document carrying only,
say, `platform.timeouts` and `platform.logging.defaultLevel` opens in the form like any other: every
group the schema declares gets its tab, every section it lacks gets its notice and its **Add
section**, and an edit made in it lands at that setting's own place in the document rather than at
the document root. Turning on **Platform → Rate Limit Handling → Enabled** on such a document adds
`platform.rate_limit_handling.enabled` and touches nothing else; adding `Gateway` under **Logging →
Components** adds `platform.logging.components.Gateway` at `INFO`; adding a model under **Models →
Overrides** adds that one key. Building `hooks.defaults.anthropic.invoke[0]` from an empty Hooks tab
is four presses — **Add section**, then **[+]** for the endpoint, the subpath and the entry — and
places the entry at exactly that path; the entry itself is completed by filling `callback.id` and
adding at least one `match` rule (typing a value and pressing Enter adds the token).

**Saving.**

- A save that would fail schema validation is refused **client-side**, without contacting the
  server, and the fields at fault are marked in place with the reason on the field — a value of
  `500` in `platform.timeouts.default` is refused with *must be >= 1000* on that field, while the
  neighbouring Streaming field is left alone. The whole document is checked, not only the tab you
  are on.
- A save that passes is not treated as saved until the stored configuration says so. The form sends
  the document, then **reads the configuration back** and compares it with what it sent; only then
  does it clear the unsaved state and return to the JSON editor. A save the server did not persist
  leaves the form open with your changes still in it.
- **Cancel** discards every unsaved edit in the form, after a confirmation, and returns to the
  stored configuration.
- Leaving the form with unsaved changes — switching back to the JSON editor, selecting a different
  configuration, or closing the detail column — prompts to **Save**, **Discard**, or **Cancel**. No
  route out of the form drops an edit silently.
- Fields you did not touch are written back exactly as they were: the form never materialises a
  schema default into a document that did not carry one. Saving does re-indent the stored JSON to
  two spaces, which is what the JSON editor's own save has always done — a version diff will show
  that reformatting on the first save of a configuration created before it.

**Known limitations.** Things the form shows that are worth reading with care. The first two are
settings the form renders because the schema declares them, but which the gateway does not act on;
the rest are gaps in the form itself, each with the JSON editor as its way round:

- `hooks.*.request.callback.strategy` is **inert**. The before/after phase is a property of the
  registered plugin, not of the configuration, so changing this dropdown moves nothing. It is worse
  than inert to look at: because the schema declares no default for it, the dropdown displays its
  first value (`before`) even on an entry that sets nothing. Nothing is written back unless you
  change it — a save that leaves it alone leaves the document byte-for-byte as it was — but do not
  read the displayed value as the configured one.
- The three Anthropic settings on the **AWS Bedrock** panel — Anthropic Bedrock Version, Excluded
  Beta Headers, Supported Beta Headers — are **inert there**. The Anthropic-shaped request path is
  what reads them, and it reads them from `providers.anthropic` alone, whichever of the two
  providers the request was routed to. They are shown on both panels because both are served by
  that path; set them under **Anthropic**. Each field's tooltip says so.
- `capabilities.file_search.chunking.*` and `capabilities.file_search.tool.enabled` are read but
  **not acted on** — chunk boundaries come from the vector store's own `chunking_strategy`, and
  nothing gates on the resolved `tool.enabled`. Both fields' tooltips say so.
- Per-entry panels under **Hooks** are numbered `#0`, `#1`, … rather than named, because a hook
  entry carries no name to label with. The numbering restarts within each endpoint's list, so
  several unrelated panels on the tab read `#0`.
- The **JSON / Form** toggle lives in the detail page's title bar and is not reachable below roughly
  **600 px** of viewport width — on a phone the detail page offers the JSON editor only, and no
  overflow control exposes the toggle. The form is a desktop and tablet affordance.

#### Daily Maintenance Run

Once a day the service corrects the recorded cost of recent usage, rebuilds the usage figures the
quota checks read, and refreshes every user's quota status. Left alone, that run starts five minutes
after the service starts and repeats every 24 hours from then — so a deployment at midday pins the
heaviest job of the day to the middle of the working day, until the next restart moves it again.

**Platform → Maintenance → Daily Run At (UTC)** fixes the time of day instead. Enter a 24-hour time
as `HH:MM` — `02:30`, `23:00`. The first run after a start still happens five minutes in, because
that is the pass that repairs whatever was missed while the service was down; every run after it
starts at the time you entered.

The value is UTC and is never adjusted for daylight saving. To run at midnight Pacific Time, enter
`08:00` while Pacific Standard Time is in effect (UTC-8), or `07:00` during Pacific Daylight Time
(UTC-7), and change it when the clocks change.

Leave the field empty for the default: a run five minutes after the service starts and every
24 hours from then. Activating a configuration, or rolling one back, takes a changed time into use
immediately without starting a run; clearing a previously set time starts a fresh 24-hour cadence
from that moment.

#### SIEM Event Export

The gateway can export its own security and audit events — not LLM prompts or responses, except
where explicitly opted in — to an external SIEM. The export is configured under the
configuration's `siem` section and covered in operational and security detail in
[the pseudonymization security assessment, §12](../security/pseudonymization-security-assessment.md#12-siem-event-export);
this section documents only what an operator sets and meets in the cockpit.

**The export ships available but off.** The master switch (`enabled`) and all six sink types the
shipped configuration lists — webhook, OTel, Datadog, Azure Sentinel, GCS Pub/Sub, S3 — ship with
their own `enabled: false`, and the shipped `categories` list is `["security", "audit"]`, without
`usage`. Nothing is exported until an operator turns on the master switch, turns on at least one
sink, and — for the one category that can carry conversation content — adds `usage` to
`categories`.

#### SIEM Sinks and Credentials in the Form

The Observability tab's **SIEM** section carries the sink list, with two affordances beyond the
ordinary fields:

- **[+]** on the Sinks section opens a dialog asking for a sink **type** and a **name**. The name opens preset to `<type>_<YYYYMMDD>_<HHMMSS>` (UTC) so it is unique by construction, but stays editable; the dialog rejects a name already used by another sink in the configuration, because that name is the key for the sink's delivery rows and would make the two sinks mark each other's events delivered. The type cannot be changed once the sink is created — remove the sink and add a new one to change it.
- **[-]** on a sink removes it after a confirmation. Removing a sink does **not** delete any credential stored for its slots — they stay stored against the configuration, just no longer reachable from the form; the confirmation names them if any are stored.

**SIEM sink credentials** are the deliberate exception to the editability rule above:
- An admin can **Set** or **Clear** a sink's credential even while the configuration is active — rotating a compromised key does not have to wait for a deactivate-edit-reactivate cycle. Every other field of an active configuration stays read-only.
- A non-admin gets no credential controls, on any configuration.
- A credential's value can never be read back through the cockpit — not even by an admin. The form shows only whether a value is currently stored, a masked hint once one is (e.g. `abcd…wxyz`), and who set it and when; the credential slot's name is carried in the row's tooltip rather than shown as text.
- Credentials are stored encrypted, scoped to the configuration they were set on, and deleted along with it. There is **no environment-variable fallback** — the credential store is the only source a sink resolves a credential from.
- Rotating the gateway's `SIEM_CREDENTIAL_KEY` master key makes every previously stored credential undecryptable; each one must be re-entered by hand afterward. See the security assessment, §12.5, for why.
- **Duplicating a configuration does not duplicate its credentials.** The duplicate carries the same sink definitions — including the same `*_env` slot names — but starts with no stored values for them; an admin sets each one again through the new configuration's own form.

#### SIEM Global Settings

These apply to the whole export and sit directly under `siem` in the configuration:

| Setting | What it does | If you get it wrong |
|---|---|---|
| `enabled` | Master switch. The dispatcher does not start at all while this is off, regardless of any sink's own `enabled`. | Left off, no sink ever sends anything, even if every sink is individually enabled. |
| `batch_size` | Default number of outbox rows a sink reads per dispatch tick. A sink may override it. | Too low under sustained load slows a sink's own backlog drain; the setting does not affect other sinks. |
| `interval_ms` | Default milliseconds between dispatch ticks. A sink may override it; the effective timer period is the shortest interval across every sink in play. | Too low increases dispatch overhead for no throughput benefit once a sink has nothing new to send. |
| `reconcile_lookback_ms` | Bounds the periodic repair pass that backfills a delivery row for an outbox row that is missing one, to rows that **landed in the outbox** (not the event's own timestamp) within this many milliseconds of now. Ships at `86400000` (24 hours). | A newly enabled sink only ever backfills events that landed within this window — **events that landed earlier are never backfilled to it**, silently. This is a deliberate bound (it is also what keeps the repair pass cheap as the outbox grows), but an operator relying on a new sink to pick up older history should know it will not. |
| `categories` | Which event categories are exported: `security`, `audit`, `usage`. Ships as `["security", "audit"]` — `usage` is left out deliberately, since it is the only category that can carry conversation content, so exporting it is an explicit opt-in. | Adding `usage` without also setting a sink's `include_content` exports request-completion metadata (model, endpoint, status) with no prompt or response text; content requires the separate opt-ins below as well. |
| `content_max_bytes` | Caps the prompt and the response of a `usage` event independently, in UTF-8 bytes, before it is written. Ships at `8192`. A cut event carries `content.truncated: true`. | Set high, a large conversation is exported closer to whole; set low, more of it is cut — either way a `truncated` event is flagged, never silently shortened. |

#### SIEM Sink Settings

Every sink shares these fields, plus the fields specific to its `type`.

**Common to every sink type:**

| Setting | What it does | If you get it wrong |
|---|---|---|
| `name` | Identifies the sink and keys its per-sink delivery rows and backoff state. Must be unique in the configuration — the form enforces this. | Two sinks sharing a name would mark each other's events delivered, so events meant for one sink are silently treated as sent and never actually exported there. |
| `type` | Which sink implementation this is: `webhook`, `otel`, `datadog`, `azure_sentinel`, `gcs_pubsub`, or `s3`. Fixed at creation. | Not applicable — the form does not allow setting this to the wrong thing after creation; remove and re-add the sink to change it. |
| `enabled` | Ships `false`. The sink is dispatched only when this **and** the global `enabled` are both true. | Left off, the sink is fully configured but never sends. |
| `include_content` | Opt-in: ships the prompt and response of a `usage` event to this sink, in their masked form. Ships `false`. Requires `usage` in the global `categories`. | Left off (the default), this sink never receives conversation content, regardless of `categories`. |
| `allow_unmasked_content` | **Risk.** Only has any effect when `include_content` is also on. Opts in to receiving content that pseudonymization never masked — because masking was disabled or bypassed for that request — as full, raw text: real names, addresses, anything a user pasted. Ships `false`. | Turning this on is a second, separate path for unmasked conversation content to leave the gateway to a third party — the exposure the pseudonymization guarantees exist to prevent. Left off, such a request instead ships metadata only, with `content.omitted: 'not-masked'`. |
| `include_credential_material` | Opt-in: ships the raw presented value of an unresolved credential (e.g. an invalid API key someone tried), for forensic use. Ships `false`. | Left off (the default), an unresolved credential's value is stripped before the event reaches this sink. |
| `batch_size` / `interval_ms` | Per-sink overrides of the global defaults above. | `interval_ms` should exceed this sink's own send timeout, or dispatches to it queue up behind each other. |

**Type-specific fields**, all required unless noted:

| Type | Fields |
|---|---|
| `webhook` | `url` (ingest URL, required); `token_env` (credential slot name, optional) |
| `otel` | `endpoint` (OTLP/HTTP logs endpoint, required); `headers_env` (credential slot name, optional) |
| `datadog` | `site` (host, e.g. `datadoghq.com` or `datadoghq.eu`, required); `api_key_env` (credential slot name, required) |
| `azure_sentinel` | `dcr_endpoint` (Data Collection Endpoint URL); `dcr_immutable_id` (Data Collection Rule immutable id); `stream_name` (e.g. `Custom-SailProxy_CL`); `tenant_id` and `client_id` (Entra ids); `client_secret_env` (credential slot name) — all required |
| `gcs_pubsub` | `project_id`; `topic_id`; `service_account_json_env` (credential slot name) — all required |
| `s3` | `bucket`; `region`; `access_key_id_env` and `secret_access_key_env` (credential slot names) — all required; `prefix` optional. Objects land at `<prefix>/YYYY/MM/DD/HH/<uuid>.ndjson`, in UTC |

A field named `*_env` never holds a credential value — it names a credential **slot**, constrained
to `^[A-Z][A-Z0-9_]*$`. The value itself is entered through the form's credential **Set** control,
described above, never typed into the configuration.

### Operational Actions

The service also exposes:

- **Health**: a health action reporting service status
- **Cache statistics**: current cache metrics
- **Cache invalidation**: invalidate cache entries, including clearing by key pattern
- **Security events**: query recorded security events
- **Usage statistics**: aggregate usage figures

### Audit Trail

Security and audit events are captured and persisted. The audit event history is append-only by convention: the application creates records and neither updates nor deletes them.

### What the Admin Cockpit Does Not Do

These are commonly expected but are **not** part of the cockpit today:

- **User and role administration** — there is no user directory, role assignment, bulk user import or password management in the cockpit. Roles come from your identity provider; see [Chapter 9](chapter-9-roles.md).
- **Cost management** — no budget thresholds, cost allocation, forecasting or spend alerts. Usage Analytics reports cost per token only.
- **Alerting** — no alert rules, thresholds, or notification routing for error rates, traffic anomalies or downtime.
- **Automated incident response** — no automatic account lockout, automatic key suspension, or IP blocking.
- **Scheduled reporting** — reports are exported manually as CSV; there are no scheduled or emailed reports, and no PDF or Excel output.
- **Log and database administration** — no log search or download, no log level configuration, no backup, restore or maintenance queries.

---

*Next: Understand [user roles and permissions](chapter-9-roles.md) in SAIL-PROXY.*
