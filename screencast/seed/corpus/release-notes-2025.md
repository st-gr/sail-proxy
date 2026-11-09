# Northwind Analytics Platform: Release Notes 2025

*Compiled by the Platform Enablement team. One entry per quarter; minor fixes are listed in the changelog of each service.*

## Q1 2025: The gateway goes live

**Highlights**

- The AI gateway replaced direct vendor accounts for all production workloads. Seventeen services and about forty notebooks moved over in six weeks.
- Personal keys became the default. Shared team keys were disabled at the end of the quarter after a two-week grace period.
- The cockpit shipped with the key list, a usage dashboard and per-key request limits.

**Breaking changes**

- Direct vendor credentials were rotated and removed from the shared secret store. Any job still using them failed with an authentication error on March 31. Three nightly jobs were caught this way and moved to the gateway the same day.

**Lessons**

The migration went faster than planned because the gateway accepts the request formats our client libraries already used. The one real surprise was cost: once every call was counted, the summary feature of Shelf Insights turned out to be responsible for half of the monthly spend. Switching it to the default chat model cut that by eighty percent with no measurable drop in quality.

## Q2 2025: Quotas and cost visibility

**Highlights**

- Quota profiles let us cap requests and daily spend per person. The "Standard team" profile became the default for developers; batch jobs get a dedicated profile with a higher ceiling and a narrower time window.
- The usage dashboard gained per-model and per-day charts, and a monthly export for finance.
- Manual price overrides arrived for models whose provider price list lags behind, so the cost estimate no longer reports zero for newly added models.

**Fixes**

- Requests that were aborted by the client mid-stream are now counted with estimated token numbers instead of being dropped from the statistics.
- Daily totals no longer shift by a few hours for teams in other time zones; all charts use UTC days.

## Q3 2025: Grounding and tools

**Highlights**

- Vector stores and file search arrived. Teams upload documents through the files API, the gateway chunks and embeds them, and models can search the store as a tool. The first store, "Team handbook", holds the documents you are reading now.
- Tool policies made tool use visible. Every policy starts in monitor mode; the security team can switch individual patterns to enforce.
- The cockpit's Grounding app shows stores, files and indexing jobs, including the reason when a file fails to index.

**Known limitations**

- Scanned PDFs without a text layer are indexed only when optical character recognition is enabled for the store. It is off by default because it is slow and costs extra.
- Very large spreadsheets are split by sheet; formulas are indexed as their last computed values.

**Lessons**

Our first stores were too big. A single store with every wiki page in the company gave noticeably worse answers than three small stores, each owned by a team that knows its content. We now recommend one store per product area and a named owner for each.

## Q4 2025: Security notifications and housekeeping

**Highlights**

- Security notifications collect failed sign-ins, disabled or expired keys being used, quota breaches and tool policy violations in one place. Owners see the notifications for their own keys; administrators see all of them.
- Keys can carry an expiry date. Trial keys for workshops now expire automatically at the end of the day.
- The cockpit is available in seven languages and offers light and dark themes.

**Deprecations**

- The legacy per-team usage report e-mail was retired in favour of the dashboard export.
- Two older chat models were removed from the curated list after their providers announced retirement. Requests naming them are rejected with a clear error message that suggests the successor.

**Fixes**

- A disabled key used from a forgotten CI runner now raises a single notification per hour instead of one per request, which kept the notification list readable during the November clean-up.
- Embedding requests with an empty input answer with status 400 instead of an empty result.

## Looking ahead

For 2026 we plan per-team budgets with alerts, a self-service flow for temporary quota increases, and better support for long documents in grounding. Feedback on any of these is welcome in the platform channel or at platform@example.com.
