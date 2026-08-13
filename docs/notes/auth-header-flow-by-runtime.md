# How identity reaches the admin service, per runtime

**Researched 2026-08-06**, prompted by a challenge to the claim that the four
`X_AUTH_REQUEST_*_HEADER` variables "were never configuration". The claim holds, but the
reasoning in the audit note was thin, and the research turned up two larger findings that have
nothing to do with those variables.

## The four runtimes

| Runtime | `DEPLOY_TARGET` | Auth mode (`authInit.ts:134`) | Admin reachable by a browser? | Reads `x-auth-request-*`? |
|---|---|---|---|---|
| npm-dist / `sail-proxy` | unset, `GATEWAY_STANDALONE=true` | n/a — no admin service | no | no |
| local dev (gateway + admin) | `development` | `mocked` | yes, direct on :4004 | no — CAP mock users |
| Docker | `docker` | `docker-jwt` | yes, via nginx | **yes** |
| Kyma | `docker` (`setup-kyma.js:2014`, `:3012`) | `docker-jwt` | **see finding 2** | in principle |

Kyma deliberately reports `DEPLOY_TARGET: docker`, so four deployments collapse to **three auth
modes**, and only `docker-jwt` involves these headers at all.

## Why the header names cannot usefully be configurable

Three layers would all have to agree, and two of them cannot be changed from configuration:

1. **oauth2-proxy** emits `X-Auth-Request-*` when `OAUTH2_PROXY_SET_XAUTHREQUEST` is on. The
   names are fixed upstream — no option renames them. Every other `OAUTH2_PROXY_*` in
   `kyma/templates/manifests/auth/oauth2-proxy.yaml` selects *what* to pass, never what to call it.
2. **nginx** hardcodes them on the forward, in both deployments:
   `docker/nginx/templates/nginx.conf.tmpl:235-238` and the Kyma ConfigMap generated at
   `kyma/scripts/setup-kyma.js:2152-2158`.
3. **admin** hardcodes them on the read: `authMiddleware.ts:79-81`, `index.ts:107-109`.

The env vars only ever reached a `logger.info` call in `server.js`. Setting one changed a line of
the startup log and nothing else.

**`debug-env.example` is not evidence to the contrary.** It lists the four commented out — but
also `DEBUG_AUTH`, `DEBUG_HEADERS`, `DEBUG_ROLES`, `LOG_FORMAT` and `DATABASE_URL`, none of which
is read anywhere in admin source either. The file documents an intended surface that was never
built; the header variables are part of that sketch, not a wired feature that was overlooked.

---

## Finding 1: docker and Kyma forward DIFFERENT header sets

| Header | Docker (`nginx.conf.tmpl:235-238`) | Kyma (`setup-kyma.js:2152-2158`) |
|---|---|---|
| `X-Auth-Request-User` | yes | yes |
| `X-Auth-Request-Groups` | yes | yes |
| `X-Auth-Request-Email` | yes | **no** |
| `X-Auth-Request-Preferred-Username` | yes | **no** |
| `X-Auth-Request-Access-Token` | no | no |

This matters because `authMiddleware.ts:115` gates the whole oauth2-proxy branch on
`if (userEmail)`. With no email header the branch is skipped entirely and the request falls
through to JWT verification via the `Authorization` header; with no bearer token either, it throws
`Missing authentication`.

So on the face of it Kyma looks broken. It is not — because of finding 2.

## Finding 2: in Kyma, nothing routes a browser to the admin service

The Kyma nginx ConfigMap has exactly one upstream. Both provider branches send `location /` to
`http://gateway:8080` (`setup-kyma.js:2138-2160`). There is no `location /admin`, no
`proxy_pass http://admin:4004`, and the APIRule that would expose admin separately is **commented
out** in `kyma/templates/manifests/networking/apirule.yaml:22-40`.

The gateway does not proxy it either: it serves `/api/admin/api-keys` and `/api/admin/api-config`
from its own routers (`services/gateway/src/index.ts:168-169`) and has no proxy to `admin:4004`.

Admin is reached in Kyma only service-to-service, by the gateway, using
`ADMIN_SERVICE_URL=http://admin:4004` — which authenticates on the JWT path
(`verifyGatewayJwt`), not the header path. So the missing email header is consistent with how the
deployment actually works, and the two findings cancel out.

**But `kyma/README.md:279` tells operators to open
`https://your-domain.kyma.ondemand.com/admin/`.** That path resolves through the APIRule to nginx
to `gateway:8080`, which has no `/admin/` route. Either the documentation is stale, or admin UI
access in Kyma is expected to come from the commented-out APIRule that no deployment enables.

**This was not verified against a running Kyma cluster** — it is read from the manifests and the
generator. Confirm against a live deployment before acting on it. If the admin cockpit genuinely
is unreachable in Kyma, that is a deployment gap worth its own investigation, and it is much more
consequential than the header variables that prompted this.

## If the headers ever should be configurable

Do it in the middleware first (`authMiddleware.ts:79-81`), then nginx in both deployments, and
accept that oauth2-proxy's own names are fixed. An env var read only by a log line is the least
useful place to start, which is presumably why it never grew past that.
