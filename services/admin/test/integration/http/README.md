# HTTP and OData suites of the admin service

Suites that call the admin service over HTTP, mostly its OData endpoint `/odata/v4/admin`. They come in two kinds, and the kind decides how a suite runs.

## Suites that start the service themselves

Most suites start the admin service inside the test process with `cds.test` and an in-memory database. They need nothing running and never touch a developer's data. Examples: `connections-odata.test.ts`, `teams-odata.test.ts`, `tool-policies-odata.test.ts`, `users-odata.test.ts`, `model-library-odata.test.ts`.

## Suites that call a running admin service

Twelve suites send their requests to an admin service that is already running. They are declared with `describeLive` from `@libs/test-utils` and run only when `ADMIN_SERVICE_URL` is set; a bare run skips them:

`admin-service-actions`, `analytics-reporting-http`, `api-keys-realistic`, `aws-credentials-http`, `configuration-management-http`, `configuration-validation`, `edge-cases`, `gateway-validation`, `input-validation`, `masked-key-persistence`, `rbac-authorization`, `sap-rates-crud`.

These suites create, change and activate data in the service they call. Do not point `ADMIN_SERVICE_URL` at your own development admin. The CI pipeline (`pnpm run ci` from the repository root) starts an admin service for them and sets the variable.

## Running

From `services/admin`:

```bash
pnpm test:http             # every suite in this folder
pnpm test:http:aws         # aws-credentials-http.test.ts
pnpm test:http:config      # configuration-management-http.test.ts
pnpm test:http:analytics   # analytics-reporting-http.test.ts
pnpm test teams-odata      # one suite, by a part of its path
```

Without `ADMIN_SERVICE_URL` the twelve suites above are reported as skipped.

## Writing a suite

- Prefer `cds.test`: the suite then runs everywhere and cannot damage a running installation.
- Use `describeLive` only when the test needs a service that was started the way an installation starts it.
- Give test records unique names and remove what the suite created.
- Use invented names and values, and placeholders that are recognisably fake for keys and secrets.
