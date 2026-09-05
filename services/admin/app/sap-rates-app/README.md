# SAP Capacity Unit Prices Fiori Elements App

A Fiori Elements app for maintaining `SapCapacityUnitPrice` - the Capacity-Unit-to-currency
prices used, together with the model GenAI rates, to compute `sapCost` in the LLM Gateway
admin service.

## What is maintained here (and what is not)

The SAP cost chain is: **model tokens → GenAI tokens → Capacity Units → currency**.

- **GenAI rates (model tokens → GenAI tokens)** are **NOT** maintained in this app. SAP
  Note 3437766 publishes them ("GenAI tokens per 1,000 model tokens") and states the
  discovery endpoint `/v2/lm/scenarios/foundation-models/models` is authoritative for them -
  exactly the data the gateway already syncs into `ModelCosts`. `sapCapacityService._lookupRate`
  reads them from there (`ModelCosts.inputCost/outputCost/cacheRead/cacheWriteCost ÷ 1000`),
  so nobody transcribes rates and they stay current automatically.
- **CU factor (GenAI tokens → Capacity Units)** is the maintained constant `SAP_CU_FACTOR =
  1.90385` in `sapCapacityService.ts` (SAP-confirmed uniform across bills; not published per
  model in the discovery data).
- **Price (Capacity Units → currency)** is what this app maintains: one `SapCapacityUnitPrice`
  row per usage type + currency, from the S-User-gated price list
  (https://www.sap.com/products/technology-platform/price-list/list.btpea.US.html).

## What to enter in each price field

One row per usage type + currency:

| Field | Value | Source |
|---|---|---|
| Usage Type | `productive` or `non-productive` (SAP classifies each subaccount; a Sandbox can be classified productive) | your subaccount classification |
| Price per CU | the currency price per Capacity Unit, Extended plan | the price list above |
| Currency | `USD` (or your billing currency) | price list |
| Valid From / Valid To | the price's validity window (`9999-12-31` = current) | price list effective date |

Each field also carries an in-app help text: open a price object page and use the
**Field Help** button in the page header.

### Validating against a real invoice

`CU Factor` and `Price per CU` both appear on the monthly SAP invoice, so you can check them:
the admin service's `reconcileInvoice` function backs out
`impliedCuFactor = invoice.capacityUnits ÷ invoice.genAiTokens` and the implied $/CU from a
real bill (`src/services/reconciliationService.ts`). If the totals line up, the price (and the
constant CU factor) are right. The per-model GenAI rates come from `/v2`, so they need no
manual validation.

## Maintaining a price change (temporal correction)

`SapCapacityUnitPrice` is temporal (`dateFrom` / `dateTo` per row), and a **validity-overlap
guard** rejects (HTTP 409) any create/edit whose `[dateFrom, dateTo)` window overlaps an
existing row with the same `usageType`. When SAP republishes a price:

1. **Close out the currently-open row**: edit its `dateTo` down to the instant the new price
   takes effect (e.g. `2026-07-01T00:00:00.000Z`).
2. **Create the new row** starting at that same instant, through `9999-12-31T00:00:00.000Z`.
   Adjacent rows that share a boundary are allowed; genuinely overlapping windows are rejected.
3. The runtime lookup picks the latest-starting row covering the requested instant, so after
   the correction every instant maps to exactly one row.

## Features

- **List Report**: view all price rows with filtering and sorting.
- **Object Page**: create and edit individual price rows (draft-enabled).
- CRUD is restricted to the `admin` role (`@(restrict: ...)` on `SapCapacityUnitPrice` in
  `src/srv/admin-service.cds`).

## Development

### Prerequisites

- Node.js (version 20 or higher)
- SAP CAP CLI
- UI5 CLI

### Running the App

#### Standalone (for development)
```bash
cd app/sap-rates-app
npm install
npm start
```

#### Integrated with Shell App
```bash
# From the services/admin directory
pnpm run watch-sap-rates
```

## Architecture

### Entity Configuration

- `SapCapacityUnitPrice` is **draft-enabled** (`@odata.draft.enabled: true` in
  `admin-service.cds`), so the object page exposes Create / Edit / Delete. A
  `before(CREATE/UPDATE)` validity-overlap guard (`beforeWriteSapCapacityUnitPrice` in
  `admin-service.ts`) rejects a row whose window overlaps an existing row with the same
  `usageType`.
- CRUD against the service view hits a `@cap-js/sqlite` limitation ("cannot modify <entity>
  because it is a view") the same way `ApiKeys`/`AwsCredentials` do; `admin-service.ts`
  redirects CREATE/UPDATE/DELETE to the base `admin.SapCapacityUnitPrice` table (see
  `onCreateSapCapacityUnitPrice` and friends).

## Shell integration & field help

- Mounted in the shell side navigation under **Settings → SAP Capacity Unit Prices**, visible
  only to `admin`-group users - the `sapRates` `NavigationListItem` in
  `app/shell/webapp/view/App.view.xml` and `fragments/SideNavPopover.fragment.xml` is bound to
  the `appView>/isAdmin` flag that `App.controller.ts` sets from the
  `whoami` / `getCurrentUserPreferences` response.
- FE V4 does not render `@Common.QuickInfo` on Object Page fields, so per-field help is
  surfaced through a header **Field Help** button that opens a dialog built at runtime from
  the QuickInfo texts in the OData metadata (`webapp/ext/FieldHelp.ts`, wired as a custom
  header action in `manifest.json`).
- Docker: the app is built and path-rewritten in `docker/admin.Dockerfile` and routed by
  `docker/nginx/templates/nginx.conf.tmpl`, alongside the other admin UI5 apps.
