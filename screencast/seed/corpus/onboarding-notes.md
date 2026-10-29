# Onboarding Notes for New Northwind Engineers

*Maintained by the Developer Experience guild. Read this in your first week; skim it again after your first month.*

## Welcome

Northwind Analytics is a small company with a large number of moving parts. We serve about two hundred retail customers from three product lines: Demand Forecast, Shelf Insights and the Supplier Data Hub. Most of our code runs in containers on a managed Kubernetes cluster, our data lives in a warehouse and a handful of operational databases, and our analysts work mainly in notebooks. These notes tell you how to find your way around without breaking anything on day one.

## Your first day

1. **Accounts.** Your manager has already requested your single sign-on account. Sign in once to the company portal, set up a second factor and accept the acceptable use policy.
2. **Laptop.** The laptop arrives with the standard developer image. Do not reinstall the operating system; the image carries the disk encryption and the device management profile that grant you access to internal systems.
3. **Chat.** Join the channels for your team, the platform channel and the incidents channel. Mute the incidents channel if you like, but read its pinned message.
4. **Buddy.** Every newcomer gets an onboarding buddy from a neighbouring team. Your buddy is your first stop for "is this normal?" questions.

## Your first week

By the end of the first week you should have:

- cloned the monorepo and run the test suite of your team's service locally;
- shipped one small change through the full review and deployment pipeline, even if it only fixes a typo in a README;
- requested a personal key for the AI gateway and made one test call with it;
- read the incident handbook and attended one incident review as an observer.

The monorepo is large. Do not try to build all of it. Each service has a short `make dev` target that starts only what that service needs, with containers for its database and cache.

## How we work

**Small changes, reviewed.** Every change goes through a pull request with at least one reviewer from the owning team. Reviews look for correctness first, then clarity. A pull request that does two unrelated things will be asked to split.

**Tests run in CI, not on trust.** If a test only passes on your laptop, it does not pass. The CI pipeline runs unit tests, integration tests against throwaway databases, and a container build for every service you touched.

**Write it down.** Decisions that outlive a sprint go into a short decision record in the repository. Meeting notes are not decision records.

**Blameless incidents.** When something breaks, we fix it, then write up what happened and what we change so it cannot happen the same way again. Nobody is punished for an honest mistake, and nobody hides one.

## Using language models at Northwind

All model calls go through the AI gateway; see the Gateway Handbook for the details. In short:

- request your own key, keep it in your password manager, and never commit it;
- start with the default chat model and move to the reasoning model only when you have to;
- use the embedding model for search features, and keep your vector stores small and focused;
- check the cockpit once a week to see what your experiments cost.

New engineers often ask whether they may use a model to help them write code. Yes, through the gateway and with the same review standards as any other code. You are the author of what you commit, whoever drafted it.

## Data you will meet

Customer sales data is aggregated per store and per day before it reaches most of our systems. Raw transaction data stays in the warehouse's restricted zone, and access needs a written reason and an approval from the data owner. Supplier records contain company names and addresses, not personal data, but some suppliers are sole traders, so treat names in that table with care.

Never copy production data to your laptop. For experiments, use the synthetic data sets in the sandbox project; they keep the shape and the statistical quirks of the real data without any real customer behind them.

## Who to ask

| Topic | Where |
| --- | --- |
| Access and accounts | IT service desk, it-help@example.com |
| Build and CI problems | Developer Experience guild channel |
| AI gateway keys and quotas | Platform Enablement team, platform@example.com |
| Security questions | Security team, security@example.com |
| Anything else | Your buddy, then your manager |

## After your first month

Book a thirty-minute conversation with your manager to talk about what surprised you. Your fresh view is valuable: if something in these notes was wrong, out of date or missing, open a pull request against this file. That is also a good first contribution.
