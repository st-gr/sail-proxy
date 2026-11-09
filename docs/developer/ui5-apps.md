---
title: UI5 application development
description: How the cockpit apps are built, tested and added to the shell.
---

# UI5 Application Development

## Overview

The admin service uses a dual architecture for serving UI5/Fiori Elements applications that developers must understand to avoid deployment issues. This page explains the critical differences between Docker and local development environments and provides comprehensive guidance for adding new UI5 applications.

## The Cockpit Apps

The apps live under `services/admin/app/`, each a workspace package with its own `package.json`, `ui5.yaml` and `webapp/`:

| Folder | App |
|--------|-----|
| `shell` | The cockpit shell: navigation, home tiles, settings, notifications |
| `api-keys-app` | API keys |
| `aws-credentials-app` | AWS credentials |
| `usage-analytics-app` | Usage analytics |
| `security-notifications-app` | Security notifications |
| `model-library-app` | Model Library and entitlements |
| `grounding-app` | Grounding (`file_search`) |
| `users-app` | Users and quotas |
| `tool-policies-app` | Tool governance |
| `config-app` | Gateway configuration |
| `connections-app` | Connections (admin only) |
| `plugins-app` | Plugins |
| `sap-rates-app` | SAP Capacity Unit Prices |

Shared annotations for the Fiori Elements apps are in `app/services.cds`. What each app does for its users is described in the [Admin Cockpit overview](/guide/cockpit/overview).

## Table of Contents

- [The Cockpit Apps](#the-cockpit-apps)
- [Dual Architecture Overview](#dual-architecture-overview)
- [Adding New UI5 Applications](#adding-new-ui5-applications)
- [Build Process Deep Dive](#build-process-deep-dive)
- [Integration Checklist](#integration-checklist)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)
- [Adding a Translatable Text](#adding-a-translatable-text)

## Dual Architecture Overview

### The Critical Difference

The admin service uses **fundamentally different architectures** for serving UI5 applications in Docker vs local development environments:

| Environment | Serving Method | Configuration Required |
|------------|----------------|----------------------|
| **Docker Production** | Pre-built static files | the app's `build:docker` script |
| **Local Development** | Dynamic plugin serving | `package.json` cds-plugin-ui5 config |

### Why Both Configurations Are Required

**Docker Environment:**
- `docker/admin.Dockerfile` builds every app folder that has a `ui5.yaml` with that app's `build:docker` script
- Serves pre-compiled static assets for optimal performance
- No runtime dependencies on development plugins
- **Result**: Works with any UI5 app that has a proper build process

**Local Development Environment:**
- Uses `cds-plugin-ui5` DevDependency for dynamic serving
- Requires explicit configuration in `package.json`
- Enables hot-reload and development features
- **Result**: Only works with properly configured apps

### Common Symptom: "Works in Docker but not Locally"

If you see this error in local development:
```
ModuleError: failed to load 'admin/yourapp/Component.js' from /your-app/Component.js: script load error
```

But the app works fine in Docker deployment, you have a **dual architecture configuration issue**.

## Adding New UI5 Applications

### Prerequisites

Before adding a new UI5/Fiori Elements application, ensure you understand:
- The dual architecture requirements
- CAP service integration patterns
- UI5 build tooling basics

### Step-by-Step Integration Process

#### Step 1: Create the UI5 Application

1. **Generate the app structure** (usually via Fiori Elements templates)
2. **Place in correct directory**: `services/admin/app/your-new-app/`
3. **Verify build tooling**: Ensure `package.json`, `ui5.yaml`, and proper Component.js exist

#### Step 2: Configure for Local Development

Add your app to **THREE required locations** in `services/admin/package.json`:

**A. Build Script:**
```json
{
  "scripts": {
    "build": "... && cd ../your-new-app && pnpm run build && cd ../.."
  }
}
```

**B. CDS Plugin UI5 Modules Configuration:**
```json
{
  "cds": {
    "cds-plugin-ui5": {
      "modules": {
        "your-new-app": {
          "path": "app/your-new-app",
          "configFile": "ui5.yaml",
          "mountPath": "/your-new-app",
          "versionOverride": "1.136.22"
        }
      }
    }
  }
}
```

**C. sapux Array:**
```json
{
  "sapux": [
    "app/shell",
    "app/api-keys-app",
    "app/your-new-app"
  ]
}
```

#### Step 3: Configure for Docker Deployment

`docker/admin.Dockerfile` needs no change: its `ui5` stage treats every folder under `services/admin/app/` that has a `ui5.yaml` as an app, runs each app's `build:docker` script, one app after the other, and points `index.html` and `manifest.json` at the `/admin/` paths. Add the script to your app's `package.json`; it must build the whole framework into `dist` (a test checks the form):

```json
"scripts": {
  "build": "ui5 build --dest dist",
  "build:docker": "ui5 build --all --clean-dest --dest dist"
}
```

Apps that do not need parts of the framework exclude them there, as the Fiori elements apps do with
`--exclude-dependency sap.fe.test --exclude-dependency sap.ushell --exclude-dependency themelib_sap_horizon`.
The image build fails when an app produces no `dist/index.html` loading `/admin/resources/sap-ui-core.js`.

The build alone is not enough to *serve* the
app in Docker. The app must also be registered for static file serving — see
Step 4, item 4. Skipping it produces an app that works locally but 404s in Docker.

#### Step 4: Integration with Shell (if applicable)

If your app needs to be accessible from the admin shell:

1. **Add navigation**: Update `app/shell/webapp/view/App.view.xml` (and `fragments/SideNavPopover.fragment.xml`)
2. **Add routing + app registration**: Update `app/shell/webapp/controller/App.controller.ts` — `appConfigurations`, `getComponentUrl` (both the `docker` and local path maps), and the `componentConfig` switch in `loadFioriElementsApp`
3. **Add service annotations**: Update `app/services.cds`
4. **Register static file serving (REQUIRED for Docker)**: Add the app to the `ui5Apps` array in `services/admin/src/index.ts`, mirroring the existing entries (`name`, `route`, `webappPath`, `distPath`)

> **Docker-only trap — "Content Not Available / not yet implemented".** In Docker,
> nginx proxies `/admin/app/*` to the admin service, which serves an app's static
> files **only if it is in `ui5Apps`** (`src/index.ts`). An app missing from that
> list 404s on `manifest.json` / `Component-preload.js`; the shell's
> `Component.create` then rejects and falls back to
> `loadStaticContent("error")`, rendering *"Content Not Available / The selected
> section is not yet implemented."* Local dev serves apps by a different mechanism,
> so the section renders fine there — this gap is invisible until you verify in a
> container. Every other integration point (nav, routing, `appConfigurations`,
> nginx regexes in `docker/nginx/templates/nginx.conf.tmpl`, the app's `build:docker`
> script, `services.cds`) is easy to remember; `ui5Apps` is the one that gets
> missed. This is the authoritative shell-integration checklist.

## Build Process Deep Dive

### Docker Build Process

**Location**: the UI5 build `RUN` step of the `ui5` stage in `docker/admin.Dockerfile`

- Runs `pnpm install` and then the `build:docker` script in each app folder that has a `ui5.yaml`, one
  app after the other; a failed build fails the image build

**Characteristics:**
- Builds every app with a `ui5.yaml`; the flags come from its `build:docker` script
- Creates static `dist` folders for production serving
- Uses framework caching for build performance
- Independent of local development configuration

### Local Development Build Process

**Location**: `services/admin/package.json` build script

```bash
pnpm run build
# Executes: cds build && tsc -p . && ... && cd app/your-new-app && pnpm run build && cd ../..
```

**Characteristics:**
- Only builds apps explicitly listed in the build script
- Requires cds-plugin-ui5 configuration for serving
- Enables hot-reload during development
- Integrates with CAP development workflow

### Verification Steps

**After adding a new app, verify both environments work:**

1. **Local Development Test:**
   ```bash
   cd services/admin
   pnpm run build  # Should show "Building your-new-app"
   pnpm run dev:ts:mock
   # Navigate to: http://localhost:4004/your-new-app/
   ```

2. **Docker Build Test:**
   ```bash
   # From the repository root: build the images, then start the stack
   pnpm run docker:build
   pnpm run docker:up
   # Open the app from the shell at http://localhost:8080
   ```

## Integration Checklist

Use this checklist when adding new UI5 applications:

### Pre-Integration Checklist

- [ ] App has proper UI5 build tooling (`ui5.yaml`, `package.json`)
- [ ] App compiles successfully with `pnpm run build`
- [ ] App follows standard Fiori Elements or UI5 patterns
- [ ] Understand dual architecture requirements

### Local Development Configuration

- [ ] Added to main build script in `services/admin/package.json`
- [ ] Added to `cds-plugin-ui5.modules` configuration
- [ ] Added to `sapux` array
- [ ] **Verified proper ordering** (maintain historical/semantic sequence)

### Shell Integration (if needed)

- [ ] Navigation items added to shell
- [ ] Routing configuration updated (`appConfigurations`, `getComponentUrl`, `componentConfig` switch)
- [ ] Service annotations registered
- [ ] Breadcrumb handling implemented
- [ ] **Registered in `ui5Apps` in `services/admin/src/index.ts`** (REQUIRED for Docker static serving — omitting it 404s the app in Docker while it works locally)

### Testing & Verification

- [ ] App builds successfully in local development
- [ ] App loads without Component.js errors locally
- [ ] App accessible from shell (if integrated)
- [ ] `build:docker` script added to the app's `package.json`
- [ ] Docker image built and the app checked in a container
- [ ] App works in Docker deployment

### Documentation & Maintenance

- [ ] Updated relevant developer documentation
- [ ] Added app to any deployment checklists
- [ ] Informed team of new app availability

## Troubleshooting

### Common Issue: "Works in Docker but not Locally"

**Symptoms:**
```
ModuleError: failed to load 'admin/yourapp/Component.js' from /your-app/Component.js: script load error
```

**Root Cause:** Missing local development configuration

**Solution:**
1. Add app to `package.json` build script
2. Add app to `cds-plugin-ui5.modules` configuration  
3. Add app to `sapux` array
4. Restart development server

**Example Fix:**
```json
// In services/admin/package.json
{
  "scripts": {
    "build": "... && cd ../your-missing-app && pnpm run build && cd ../.."
  },
  "cds": {
    "cds-plugin-ui5": {
      "modules": {
        "your-missing-app": {
          "path": "app/your-missing-app",
          "configFile": "ui5.yaml", 
          "mountPath": "/your-missing-app",
          "versionOverride": "1.136.22"
        }
      }
    }
  },
  "sapux": [
    "app/shell",
    "app/your-missing-app"
  ]
}
```

### Common Issue: "Works Locally but not in Docker"

**Symptoms:** App loads in local development but fails in Docker deployment

**Root Cause:** Usually build process issues, not configuration

**Solution:**
1. Verify app has proper `ui5.yaml` configuration
2. Test `pnpm run build` works in app directory
3. Test `pnpm run build:docker` works in app directory
4. Ensure no development-only dependencies

### Build Process Debugging

**Local Build Issues:**
```bash
cd services/admin
pnpm run build 2>&1 | grep -E "(error|Error|your-app)"
```

**Check cds-plugin-ui5 Configuration:**
```bash
cd services/admin  
node -e "console.log(JSON.stringify(require('./package.json')['cds']['cds-plugin-ui5'], null, 2))"
```

**Verify App Build Output:**
```bash
ls -la app/your-app/dist/  # Should contain Component.js and other built assets
```

## Best Practices

### Development Workflow

1. **Always test both environments** during development
2. **Follow the integration checklist** for every new app
3. **Maintain proper ordering** in configuration arrays
4. **Use consistent naming conventions** across all configuration points

### Configuration Management

1. **Keep configurations in sync** between Docker and local
2. **Document any app-specific requirements** 
3. **Test configuration changes** before committing
4. **Follow semantic ordering** in package.json arrays

### Error Prevention

1. **Use the integration checklist** religiously
2. **Understand the dual architecture** before starting
3. **Test in local development first**, then verify Docker works
4. **Don't assume Docker success means local development will work**

### Team Collaboration

1. **Communicate new app additions** to the team
2. **Update documentation** when adding apps
3. **Share integration lessons learned**
4. **Maintain consistent development practices**

## Adding a Translatable Text

Every user-visible string in the cockpit comes from an i18n bundle, so it can be
shown in the seven cockpit languages (English, German, French, Portuguese,
Italian, Spanish, Dutch). Do not hard-code a visible literal in a view,
controller or annotation. Where the text goes depends on which kind of app shows
it.

Two checks keep untranslated text out. The jest bundle guard
(`services/admin/test/unit/i18n/bundles.test.ts`) verifies every bundle, every
key referenced from a view, controller or manifest (<code v-pre>{{key}}</code>), and that the
English defaults of the injected translators in the `webapp/model` helpers
match the bundle byte for byte. `node ci/scripts/i18n-literals.js` inventories
hard-coded visible literals and runs in CI (Phase 4); it exits 1 on any hit not
excused in `ci/scripts/i18n-literals.allowlist.json`, so run it locally before
pushing.

### A freestyle app (views and controllers)

Each freestyle app owns a bundle under `services/admin/app/<app>/webapp/i18n/`
with eight files: `i18n.properties` (the default), `i18n_en.properties` and
`i18n_de/es/fr/it/nl/pt.properties`. Add the new key to **all eight**:

- `i18n.properties` and `i18n_en.properties` carry the English value and must be
  **byte-identical** to each other.
- `i18n_de`, `i18n_es`, `i18n_fr`, `i18n_it`, `i18n_nl`, `i18n_pt` carry the
  translation. Reuse the term the app already uses for the same thing, so one
  field reads the same everywhere.

Then reference the key so it is picked up:

- In a view or fragment: `text="{i18n>myKey}"` (likewise `title`, `placeholder`,
  `tooltip`, `label`, …).
- In a controller: through the app's `getText(key, args?)` helper or the `i18n`
  model, e.g. `this.getOwnerComponent().getModel("i18n")`.

### A Fiori Elements annotation label

Fiori Elements screens take their labels from each app's `annotations.cds`, and
the service titles from `src/srv/admin-service.cds`. These are translated from
one shared CDS bundle under `services/admin/_i18n/`: `i18n.properties` (the
default) and `i18n_de/es/fr/it/nl/pt.properties` — there is no separate `_en`
file here, the default *is* English. Keys are prefixed by app (`apiKeys.name`,
`users.resetQuota`), with shared field labels defined once (`common.name`).

- Add the key to `services/admin/_i18n/i18n.properties` and the six language
  files, then reference it in the annotation as `'{i18n>apiKeys.name}'`.
- CAP serves `$metadata` with these texts translated for the request's
  `Accept-Language`, which UI5 sends on every OData call once the shell has set
  the language.
- The bundle is shipped into the Docker image by a `COPY` of
  `services/admin/_i18n/` in `docker/admin.Dockerfile`; `cds build` merges it
  into `dist/srv/_i18n/i18n.json`, which is what the image serves. A new key
  needs no Dockerfile change, but if that folder were ever moved the `COPY` must
  follow it. The runtime stage copies `_i18n` once more, because the server
  message texts (`messages*.properties`) are read at runtime and are not merged
  by `cds build`.

### A Fiori Elements app's own texts (manifest and extension code)

Texts that do not come from an annotation — the app title, a custom action's
label, a custom section title, the messages of extension code under
`webapp/ext/` — live in the FE app's own bundle under
`services/admin/app/<app>/webapp/i18n/`. It has **seven** files:
`i18n.properties` (the default, English) and `i18n_de/es/fr/it/nl/pt.properties`.
There is no `i18n_en.properties` here; English is served from the default file.
Add the key to all seven.

- In `manifest.json`, reference the key as <code v-pre>&quot;{{myKey}}&quot;</code> (for example
  <code v-pre>&quot;title&quot;: &quot;{{appTitle}}&quot;</code> or a custom action's <code v-pre>&quot;text&quot;: &quot;{{myAction}}&quot;</code>).
- Extension code has no controller `getText` helper. Load the app's bundle once
  per module and await it inside the handler's `try`, so a failed load is caught
  like any other error:

  ```ts
  let bundlePromise: Promise<ResourceBundle> | undefined;
  function getBundle(): Promise<ResourceBundle> {
    if (!bundlePromise) {
      bundlePromise = ResourceBundle.create({
        bundleName: "admin.users.i18n.i18n", // this app's own id + .i18n.i18n
        async: true,
        supportedLocales: ["", "de", "es", "fr", "it", "nl", "pt"],
        fallbackLocale: ""
      }) as Promise<ResourceBundle>;
    }
    return bundlePromise;
  }
  ```

  Use the app's own id in `bundleName`. `supportedLocales` leaves out `en` and
  `fallbackLocale` is `""`, which is what makes English come from the default file.

### The configuration form's field texts (api_config schema)

The Configuration app's form is drawn from the api_config JSON schema, and the
schema itself stays English: `services/admin/src/schemas/api-config-schema.json`
and its byte-equal browser copy `webapp/model/apiConfigSchema.ts` are never
edited for a language. Every field label, title and description the form shows
is looked up in the config-app bundle instead (`webapp/model/schemaTexts.ts`),
with the schema's own English as the fallback:

- `schema.<path>.label` — the schema `title`, else the label derived from the
  property key (`api_key_env` → "API Key").
- `schema.<path>.description` — the schema `description`.

`<path>` is the field's document path below `api_config`, joined with `.`
(`platform.quotas.tokensPerDay`). Any key of a dynamically keyed map
(`additionalProperties`/`patternProperties`) is the fixed segment `_entry`
(`models.overrides._entry.pseudonymization.method`); any array element is
`items` (`observability.siem.sinks.items.url`). A map entry's own label is its
key, so `_entry` paths have a description key and no label key. Composed
`allOf` branches fold in the way the form folds them; a field reached through a
shared `$defs` entry (the common provider settings, pseudonymization, hook lists)
has one key per place it appears in the document.

These keys are generated, not written by hand. **When you change the schema**
(after the usual api_config steps — the gateway file is the origin, and the
schema has the byte-equal browser copy):

1. Run the generator. It writes every `schema.*` key with the exact English the
   form shows into `i18n.properties` and `i18n_en.properties`, and adds each
   missing key to the six language files with the English value as a
   placeholder; it never overwrites an existing translation and drops keys the
   schema no longer has. A placeholder that still holds the previous English of
   a reworded text moves to the new English. A second run changes nothing.

   ```bash
   node ci/scripts/schema-texts.js           # write the bundles
   node ci/scripts/schema-texts.js --check   # exit 1 if a bundle is not up to date
   ```

2. Translate the placeholders it added in `i18n_de/es/fr/it/nl/pt.properties`
   (the generated block at the end of each file; same terms as the rest of the
   app, product names untranslated). A reworded English keeps its old
   translations in the six languages — re-check and update them by hand.
   `node ci/scripts/schema-texts.js --apply <lang> <map.json>` fills a
   language's placeholders from a `{ "<English>": "<translation>" }` map.

3. Accept the texts once all six languages are checked:

   ```bash
   node ci/scripts/schema-texts.js --accept
   ```

   This rewrites `services/admin/app/config-app/test/schemaTexts.translated.json`
   (the translation lock: each key with the first 12 hex digits of the sha256 of
   its English, in generator order) from the default bundle. Running it states
   that the six languages were checked against this English; it refuses while a
   bundle is not up to date. Before writing the lock it lists, by language, every
   new or reworded key whose value still equals its English. That is a warning,
   not a refusal (a product name or a technical term is meant to stay the same),
   so read the list and translate anything that is a forgotten placeholder.

`services/admin/app/config-app/test/schemaTexts.test.ts` fails until steps 1
and 3 are done: every schema field must have its label key, and its description
key when it has a description, with the schema's English byte for byte; and
every key must be in the lock with the hash of its current English. A key the
lock lacks fails with "new field: translate in de..nl, then run --accept", a
changed hash with "English reworded: re-check the six translations, then run
--accept". The same suite
builds the whole form for the shipped configurations through the bundle and
checks the English is unchanged and that every text the form looks up is a key
the generator writes.

### The apostrophe rule

A value that is formatted **with arguments** (`getText(key, [args])`,
`formatMessage`, a value with `{0}`, `{1}`, …) goes through UI5's MessageFormat,
where a straight ASCII apostrophe `'` is an escape character and **swallows the
placeholder**. A value that is read **without arguments** (`{i18n>key}` in a view,
`getText(key)`, `getProperty(key)`) is shown as written. That means a doubled
`''` only works in the first case: in the second it shows up doubled.

Use the typographic apostrophe `’` in every value, with or without
placeholders. It is safe in both cases. Use `''` only in a value that is always
formatted with arguments.

### How the language is chosen

The shell decides the language before UI5 boots.
`app/shell/webapp/model/language.ts` (`resolveLanguage`) is the single source of
the rule — a URL `sap-language` parameter wins, then the choice stored by the
Settings dialog, then the first supported browser language, else English — and
an inline script in `app/shell/webapp/index.html` carries a dependency-free copy
of that rule which runs before the bootstrap. Keep the two in step when you
change the rule.

The choice belongs to the signed-in user: Settings saves it with
`updateUserPreference('language', code)` (the nullable `UserPreferences.language`
column) and only then writes localStorage and reloads; a failed save keeps the
current language and shows a toast. localStorage is just the pre-boot copy. After
boot the shell reads the stored value from `getCurrentUserPreferences`; when it
differs from the active one, `serverLanguageAction` decides on exactly one
reload per tab session (none while localStorage is blocked or a URL parameter is
set), so a new browser shows the account's language after one reload.

### Dates and numbers

Dates and numbers follow the cockpit language, not the browser's locale and not
a fixed `'en-US'`. Format with the UI5 language tag through `Intl` (or
`toLocale*String`), keeping the options the code already uses:

```ts
import Localization from "sap/base/i18n/Localization";
const locale = Localization.getLanguageTag().toString();
new Intl.NumberFormat(locale).format(tokens);
```

A pure helper under `webapp/model` (unit-tested with jest, no UI5 imports)
takes the locale as a parameter with an `'en-US'` default, and the controller
passes the language tag; the jest suites keep calling it without one, so their
English expectations stay as they are. A date bound with a UI5 type
(`sap.ui.model.type.DateTime`) follows the language by itself. An OData V4 value
handed to a formatter arrives already type-formatted as a display string, so bind
it with `targetType: 'any'` and let the formatter format the raw value with the
language tag; parsing the display string again reads a German date with day and
month swapped. Check a change with `?sap-language=DE`: German
groups with `.` and uses `,` as the decimal sign (`1.234`, `1,5`), and English
output must stay byte-identical.

### Verifying

Run the bundle guard before committing. For every bundle it checks that each
language file has the default's exact key set, no empty values, matching `{n}`
placeholders, no stray ASCII apostrophe in a value with `{n}`,
`i18n.properties == i18n_en.properties` where both exist, and that every key
referenced from a view, controller or `.cds` file exists:

```bash
pnpm -C services/admin exec cross-env cds.requires.db.kind=sqlite cds.requires.db.impl=@cap-js/sqlite jest --config=jest.config.js test/unit/i18n
```

To find any remaining hard-coded literals, run the inventory tool (a dev tool,
not shipped). It is clean when it reports zero non-allowlisted hits; genuinely
technical strings are excused in `ci/scripts/i18n-literals.allowlist.json` next
to it:

```bash
node ci/scripts/i18n-literals.js            # every app
node ci/scripts/i18n-literals.js app/shell  # one app
```

## Related Documentation

- [Admin service (CAP)](/developer/admin-cockpit) - Admin service overview
- [Docker Compose](/deploy/docker) - Running the images
- The Docker images page of this section - How the images are built
