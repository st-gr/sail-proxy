---
title: Plugins in the cockpit
description: Install, enable and remove gateway plugins from the Admin Cockpit without rebuilding or restarting the gateway.
---

# Plugins in the cockpit

Plugins change how the gateway handles requests: they can inspect or rewrite a request before it goes to the model, and change the response or the stream on its way back. The **Plugins** application (Settings → Plugins, administrators only) installs a plugin from a zip package, enables one version of it and removes it again, without a new image and without restarting the gateway. How a package is written and built is described in the [plugin developer guide](/developer/plugins).

::: warning A plugin runs with the gateway's full access
A plugin is code that runs inside the gateway, which holds the SAP AI Core credentials and sees every request and response. Nothing restricts it. Install only packages from authors you trust. An administrator can switch installing off for the whole deployment; see [Switching installation off](#switching-installation-off).
:::

## The list

The app has two tables.

- **Installed plugins**: one row per uploaded plugin, with its enabled version, its status, the rules it registered and who uploaded it and when. Select one or more rows; the actions are above the table and apply to the selected rows, each for the version chosen in its row. An action is available when it fits at least one selected row; it acts on those, and tells you which rows it left as they are.
- **Built-in plugins**: the plugins that ship with the gateway. They are shown for information; you cannot change them here.

The status comes from the running gateways, one line per gateway instance:

| Status | Meaning |
|---|---|
| Running | The gateway loaded the plugin |
| Waiting for the gateway | The change is stored; the gateway has not picked it up yet |
| Installed, not loaded yet | The package is unpacked but the gateway has not loaded it |
| Failed | The plugin could not be loaded; the line shows the error. The other plugins keep running |
| Not compatible with gateway *x* | The package's gateway range excludes the running gateway |
| Gateway not responding | No gateway has reported recently. The change applies at the gateway's next start |
| Status unavailable | The status cannot be read. Changes still reach the gateways |

Choose **Refresh** to read the status again. A change shows as running once the gateways have loaded the plugin, which normally takes a moment.

## Install, enable and undo

1. Choose **Upload**, then pick the plugin's `.zip` file. The package is checked when you upload it: the manifest and the limits (20 MB compressed, 100 MB unpacked, 5,000 files). A refused package states the reason. A package built for a newer gateway than the one you run is stored and marked as not compatible, so you can upload it ahead of a gateway upgrade; **Enable** is refused until it is compatible. An uploaded version stays **disabled**; nothing runs yet.
2. Select the plugin's row, pick the version you want, and choose **Enable**. It replaces the version that was enabled before. The gateways fetch the package, check it again, unpack it and reload their plugins.
3. If the plugin should act on requests, add its hooks, see below.

Changes apply immediately on Docker and Kyma; the gateways also re-check once a minute, so a missed notification catches up on its own.

To undo a change:

- **Switch to this version** enables another stored version, for example the one that worked before. Keep earlier versions stored until the new one has proved itself.
- **Disable** stops the gateways from running the plugin and removes it from them. The stored versions stay.
- **Remove Version** deletes a stored version. The enabled version cannot be removed; disable the plugin or enable another version first.

Uploads, enabling, disabling and removals are recorded in the [audit trail](/guide/cockpit/operations).

A package that is damaged is skipped and reported, and the version that was running stays. A plugin that throws while loading shows as failed and does not stop the gateway.

## Hooks and settings

A plugin does nothing until a hook in the gateway configuration calls it. A package may suggest hooks; **Add Suggested Hooks** writes them into a new, stored configuration version, one for all the plugins you selected. It is not active: review it and activate it under [Configuration Management](/guide/cockpit/configuration), the same way as any other change. The hooks of a plugin that is disabled are logged and skipped.

A plugin can also bring settings. They appear in the configuration form on the **Plugins** tab, with help texts in your language (or, if the author did not provide it, in another language, which the form says). Edit them in the form or in the JSON view, then save and activate as usual. If the stored settings of an enabled plugin no longer match what the plugin accepts, the form is switched off and names the plugin: correct the values in the JSON view.

## When something goes wrong

::: danger A failing plugin does not block requests
If a plugin is missing, fails to load, or throws while handling a request, the request carries on as if the plugin were not there. A plugin you rely on as a security control, such as a content filter, therefore does not protect requests while it is missing or failing. Watch the status, and do not treat a plugin as the only safeguard for data that must never leave.
:::

- **A plugin shows as failed.** Disable it, or switch to another version. The other plugins and the gateway keep running.
- **A plugin hangs or stops the gateway while loading.** Disable it in the app, which still works because the admin service keeps running. If the gateway hung rather than crashed, restart the gateway pod or container once after disabling. A gateway that crashes in a loop comes up without the plugin at its next restart.
- **A plugin is not compatible after an upgrade.** It is not loaded and requests carry on without it. Upload a version built for the new gateway.
- **The admin service cannot be reached by the gateway.** Plugins already unpacked keep running where the gateway's filesystem survived. A gateway that starts fresh runs without the installed plugins until it reaches the admin service again, then loads them.
- **A damaged package.** A damaged plugin package in the standalone CLI's folder holds back the removal of other plugins until it is fixed or removed; see the [CLI](/deploy/cli#installing-plugins).

## Switching installation off

The administrator of the deployment decides whether plugins can be installed at all. The setting `INSTALLED_PLUGINS_ENABLED` is on by default and read by the admin service.

- While it is off, **upload and enable are refused** with a message that names the setting, and the app shows a banner. **Disable** and **Remove Version** keep working.
- The admin service stops offering installed plugins to the gateways, so they **stop running** once the gateway next hears from the admin service. Because the admin service announces itself when it starts, this is normally immediate; if it cannot be reached, plugins that are already loaded keep running until it can.
- The plugins that ship with the gateway are not affected.

The Docker and Kyma setup scripts ask whether admins may install plugins, with yes as the default; see [Docker Compose](/deploy/docker) and [SAP BTP Kyma](/deploy/kyma). To change it later, set `INSTALLED_PLUGINS_ENABLED=false` (or `true`) for the admin service: in `services/admin/.env` on Docker, in the `admin-env` Secret on Kyma, and restart the admin service. Running the setup in a non-interactive mode (`--ci` or `--config`) can write the file again without the line and so return the setting to on, so check it after those runs.

Running the setup again asks the question, with the stored answer as the default. An upgrade without re-running the setup does not ask and leaves the feature on, so upgrading to a release with this feature turns it on. If your deployment must not run installed code, set the variable to `false` as part of the upgrade.
