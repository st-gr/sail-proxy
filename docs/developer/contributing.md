---
title: Contributing
description: How to ask, report, propose and submit changes, and the conventions every commit follows.
---

# Contributing

<!--@include: ../.generated/CONTRIBUTING.md{2,}-->

## Conventions specific to this repository

Where the general guidelines above and this section differ (commit messages in particular), this section applies.

### TypeScript and code style

There is no repository-wide lint script, and the CI pipeline does not run ESLint. The root `eslint.config.mjs` applies CAP's recommended rules (`@sap/cds/eslint.config.mjs`); run it on the files you changed:

```shell
npx eslint services/admin/src/srv/admin-service.ts
npx eslint --fix services/admin/src/srv/admin-service.ts
```

The `config-app` and `usage-analytics-app` cockpit apps have their own `pnpm lint` (`eslint webapp/`). The TypeScript compilers (`pnpm build`), the UI5 type check (`pnpm typecheck:ui5`) and the test suites are what CI enforces.

### Testing

Add or change tests for the code you contribute. The suites use [Jest](https://jestjs.io/docs/getting-started):

```shell
pnpm test          # the gateway suites
pnpm test:all      # every package's tests
pnpm run ci        # the full pipeline, as CI runs it
```

`pnpm test` alone runs only the gateway's suites. Which suites exist, which need the CI environment, and how to write a test are described in [Testing strategy](/developer/testing-strategy).

### Internationalization (i18n)

Messages and texts that are visible to the user and required to interact with or use the product must be translatable. This includes dialogs, button texts, questions, labels and messages. It does not include technical log messages, tracing information or exception texts that are not shown to the user.

Every new cockpit text ships in all seven languages of the bundles (English, German, Spanish, French, Italian, Dutch and Portuguese); how to add one is described in [Adding a translatable text](/developer/ui5-apps#adding-a-translatable-text).

### Documentation

Pages of the documentation site live in `docs/`; preview them with `pnpm docs:dev` and run `pnpm docs:check`, the gate CI runs, before you push.
How the site is built, checked and deployed is described in [Documentation site](/developer/release#documentation-site).

### Git guidelines

This repository uses the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification for every commit. The structured format keeps the history easy to scan and makes the type of each change visible when the changelog is written; `CHANGELOG.md` itself is maintained by hand (see [Release procedure](/developer/release#what-reaches-users-when)). All pull requests must follow the format; non-compliant commits are rejected in review.

A commit message has three parts: a header, an optional body and an optional footer.

#### Header

The header is the first line. It consists of a type, an optional scope and a description: `type(scope): description`.

The type is one of:

- `fix` — a bug fix
- `feat` — a new feature
- `docs` — documentation only
- `style` — changes that do not affect the meaning of the code
- `refactor` — a code change that neither fixes a bug nor adds a feature
- `perf` — a code change that improves performance
- `test` — adding or correcting tests
- `build` — the build system or dependencies
- `ci` — the CI pipeline and its scripts
- `chore` — other changes to tooling and auxiliary files
- `revert` — reverts an earlier commit

The scope names the part of the repository that changed, for example `gateway`, `admin`, `file-search` or `docs`.

The description uses the **imperative present tense** ("Add feature xy", not "Added feature xy" or "Adding feature xy") and is at most **100 characters** long.

#### Body

After the header, an empty line, then the optional body: the intention and reasoning of the change.

#### Footer

After the body, an empty line, then the optional footer:

- A breaking change starts the footer with **BREAKING CHANGE:** followed by a description, for example `BREAKING CHANGE: remove the legacy top-level logging block`.
- A change that fixes a GitHub issue adds `Fixes #<issueNumber>`, for example `Fixes #42`.

#### Example

```
fix(gateway): keep the charset when matching the content type of a hook rule

A client that sends "application/json; charset=utf-8" did not match the
contentTypeJson rule, so pseudonymization did not run for it.

Fixes #42
```

### Pull requests

Fix one issue per pull request and keep pull requests as small as possible. A single, clear fix is much easier to understand and review, and focused pull requests give users of the project more control over which fixes and features each release contains.

### Versioning

The project follows [Semantic Versioning](https://semver.org/):

> Given a version number MAJOR.MINOR.PATCH, increment the:
> 1. MAJOR version when you make incompatible API changes,
> 1. MINOR version when you add functionality in a backwards compatible manner, and
> 1. PATCH version when you make backwards compatible bug fixes.
>
> https://semver.org/#summary

All workspace packages carry the root version; `cli-tools/sync-version.js` keeps them in line (see [Release procedure](/developer/release)).
