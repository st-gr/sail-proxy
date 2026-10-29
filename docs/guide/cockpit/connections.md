---
title: Connections
description: Define external provider accounts, store their credentials, test them and publish priced models in the Admin Cockpit.
---

# Connections

Connections is the Admin Cockpit app for external provider accounts: Azure OpenAI, AWS Bedrock, the OpenAI API and the Anthropic API. It also holds the SAP AI Core tenant the gateway uses (see [SAP AI Core](#sap-ai-core)). A connection holds the account's address and sign-in settings, its credential, and the models you publish from it. Only administrators see the app; it does not appear in a user's navigation.

Azure OpenAI, OpenAI API, Anthropic API and AWS Bedrock connections are served by the gateway. Claude models from an Anthropic API or AWS Bedrock connection are used through the gateway's Anthropic route, the way Claude Code and the Anthropic SDKs call it. Web search is not available for models from a connection.

AWS Bedrock connections serve Claude models only. They sign in with an access key (optionally with a session token) or with a Bedrock API key. Newer Claude models need the inference-profile id, for example `us.anthropic.claude-haiku-4-5-20251001-v1:0`; **Fetch models** lists these ids.

On the AWS side, the credential's identity needs permission to invoke models (`bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`; for a cross-region inference profile such as `us.` or `eu.`, in every region the profile routes to) and, for **Fetch models**, to list them (`bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles`). Access to the Claude models must also be enabled in the AWS account. **Test Connection** checks the credential against the model catalogue only, so **Fetch models** can still fail when the inference-profile listing is not allowed.

The standalone command-line gateway (`sail-proxy`) has no Admin Cockpit. It manages the same kinds of connections with the `sail-proxy connection` commands, without prices; see [Standalone CLI](/deploy/cli#connections).

## The List

The list shows one row per connection: its title, name, provider type, whether it is active, the credential hint, the result of the last test and the number of published models. Use **Create** to add a connection. A dialog asks for the name and the provider type; both are fixed once the connection exists, because the name becomes part of every model id the connection serves.

Edits happen in a draft: choose **Edit** on a connection's page, change what you need and choose **Save** or discard. Deleting a connection also deletes its models, closes their open prices and removes its stored credential.

## A Connection's Page

The page has these sections:

- **General**: title, name, provider type and whether the connection is active.
- **Endpoint & authentication**: only the settings that apply to the provider type, for example the endpoint and API version for Azure OpenAI, the region for AWS Bedrock, or the base URL for the OpenAI API. Defaults are filled in where the provider has a standard value.
- **Credential**: the masked hint of the stored credential and the date it was set.
- **Status**: the time and result of the last test.
- **Models**: the models of this connection.
- **Record Information**: who created and last changed the connection, and when.

The header holds **Edit**, **Delete**, **Test Connection**, **Set credential**, **Clear credential** and **Add model**. The credential, test and model actions work on the saved connection, so they are not offered while you are editing a draft.

## Credentials

**Set credential** opens a dialog with masked fields; which fields appear depends on the provider type (an API key, a client secret, an access key pair with an optional session token, or a Bedrock API key). The credential is stored encrypted and never shown again; only a masked hint and the date remain. Setting a new credential replaces the old one, and **Clear credential** removes it.

## Models and Prices

**Add model** opens a picker filled from the provider's own model list. If the list cannot be fetched, or the model is not in it, type the model or deployment name instead.

The Models table lets you select several rows. Its toolbar offers:

- **Set price**: for one model at a time. Prices are entered per 1K tokens in the installation currency. The dialog starts with the model's current price. For an installation that bills in USD and a model without a price, it starts with a suggestion from [LiteLLM's public price list](https://github.com/BerriAI/litellm); you confirm or change every value. Installations in another currency get no suggestion.
- **Publish** and **Unpublish**: a published model appears in the gateway's model lists as `<model>--<connection>` for the users who are entitled to it. Publishing needs a price, so set one first. Users see a published model only after an administrator adds it to an entitlement catalog: the Default catalog never grants Connection models (see [Entitlements & Quotas](/guide/cockpit/model-library#entitlements-quotas)).
- **Remove**: deletes the selected models after a confirmation.

Connection models are priced here, not in the [Model Library](/guide/cockpit/model-library), which shows where each model comes from (SAP AI Core or a connection). Their spend is shown separately from SAP cost in [Usage analytics](/guide/cockpit/usage-analytics), and the average cost per request counts SAP requests only.

## Testing a Connection

**Test Connection** makes the gateway call the provider with the stored credential and reports the outcome in a message: the connection works, no credential is set, the provider rejected the credential or denied access, the endpoint or deployment was not found, the provider could not be reached or did not answer in time, the provider reported an error, or the provider type is not served by this version yet. Where the provider answered, the message names its HTTP status, never its own text. The time and result are kept in the Status section and in the list.

## SAP AI Core

A connection of the type **SAP AI Core** replaces the installation's SAP AI Core service key with one you manage in the cockpit. By default the gateway signs in with the key from its environment (set during installation). While a SAP AI Core connection is active, the cockpit's key takes precedence; deactivating it returns to the environment key. The npm command-line installation (`sail-proxy`) is unchanged: it keeps using the key from its own configuration.

### Setting the Service Key

Create a connection of the type SAP AI Core, then choose **Set Service Key**. Upload the service key's `.json` file or paste its content; the same format as during installation is accepted. The key is stored encrypted and never shown again; only a masked hint and the date remain. Besides the key the page has:

- **Resource group**: the SAP AI Core resource group the gateway uses. The default is `default`.
- **Productive**: whether this tenant is a productive one. It is prefilled from the installation's billing classification.
- **Price region**: the region whose SAP prices apply to this tenant. Set it to the region of the SAP price list that applies (for example EU); its value help lists the regions of the SAP prices. Left empty, the newest price of any region applies; a region without a matching price falls back to it as well.

A SAP AI Core connection has no models section: the models come from the tenant itself.

### Test, Activate, Deactivate

**Test Connection** requests a token with the key and reads the tenant's foundation-model list, and reports whether both worked.

**Activate** asks for confirmation ("All gateways switch to this SAP AI Core tenant") and needs a passing test. At most one SAP AI Core connection is active, so activating one deactivates the other. **Deactivate** returns to the installation's environment key. The active connection cannot be deleted, and its credential cannot be cleared; deactivate it first. Its resource group cannot be changed, and a new service key for it must belong to the same tenant (a rotated key, which needs a new test); for another resource group or tenant, create another connection, test it and activate it. Changing the resource group of an inactive connection also asks for a new test.

### What a Switch Changes

- The gateways switch without a restart. Requests already running finish on the tenant they started on.
- If a gateway already serves a cockpit key and a new key cannot get a token, it does not switch and keeps the previous key. A gateway still on the environment key installs the new key anyway, so its SAP calls fail until the key is fixed; the environment key never serves the new tenant by mistake. Test before you activate (the cockpit requires a passing test).
- A gateway that restarts while the admin is down continues with the last tenant it was told to use. This needs Valkey and the installation's validation token secret set to your own value; otherwise a gateway that starts while the admin is unavailable uses the environment key until the admin is back.
- The [Model Library](/guide/cockpit/model-library) and the catalogs follow the new tenant. Deployed models of the old tenant become absent. Catalog entries that name them stay until you edit them.
- New [AWS credentials](/guide/cockpit/aws-credentials) take the active SAP AI Core region.
- A deployment id fixed in the installation's environment (`SAP_AI_DEPLOYMENT_ID`) belongs to the environment tenant: while a SAP AI Core connection is active, the gateway finds the tenant's orchestration deployment itself.

### Billing per Tenant

Each usage row records the SAP tenant it ran on. The productive flag and the price region belong to the tenant; correcting the flag reprices that tenant's last 62 days. Usage recorded before this feature is assigned to the environment tenant. [Usage analytics](/guide/cockpit/usage-analytics#sap-tenant) can filter by tenant.
