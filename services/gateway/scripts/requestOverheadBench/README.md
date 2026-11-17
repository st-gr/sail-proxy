# Request overhead bench

The yardstick for changes to the gateway's logger: does a request take longer than before, beyond the
run-to-run noise? Each change that touches the logger runs it before and after and compares.

The `e2e` mode needs the CLI's compiled `dist` (it takes the gateway's settings from it): build it
once with `npm run build:local` in `npm-dist/sail-proxy`.

Run from `services/gateway`:

```
npx ts-node -r tsconfig-paths/register scripts/request-overhead-bench.ts e2e
npx ts-node -r tsconfig-paths/register scripts/request-overhead-bench.ts logger
npx ts-node -r tsconfig-paths/register scripts/request-overhead-bench.ts raw
```

Each mode sends 2,000 requests at concurrency 20, five times, after an unreported warm-up of 5,000
requests, and prints one JSON line per run on stdout (milliseconds):

```
{"mode":"e2e","variant":"baseline","run":1,"p50":7.942,"p95":9.507,"mean":8.020,"requests":2000}
```

`BENCH_VARIANT` sets the `variant` label (default `baseline`); the script does nothing else with it.
Percentiles are nearest-rank. `withinNoise` in `stats.ts` compares a candidate's five runs with the
baseline's: the noise is the spread (max minus min) of the baseline runs' p50 and of their p95, the
deltas compare the medians, and a candidate is ok when it is not slower than the noise on both. Run
both on an otherwise idle machine; a busy one widens the spread.

## `e2e`: whole requests through a standalone gateway

Starts a fake SAP AI Core on a port the OS picks (token, model list, one running deployment, and a chat
completion that answers after a fixed 5 ms) and a standalone gateway as a child process on another free
port, with the settings `sail-proxy run` uses (`buildGatewayEnv` of the CLI). It creates an API key,
then posts non-streaming chat completions to `/openai/v1/chat/completions` for the deployed model.
Everything it creates lives in a temporary folder that is removed at the end, and the child is stopped
by its PID in a `finally`.

Measures: the client-to-client time of a request through the gateway's middleware, the
pseudonymization plugin, the deployment call, usage tracking and every log line the gateway writes
for it, including its log file.

Does not measure: Valkey, the admin service, log shipping (a standalone gateway has none), streaming,
a real network or a real model.

Differences from an installed CLI: the gateway runs from source with ts-node (so the code measured is the
working tree, not a stale build), with `NODE_ENV=development` because the plugins are loaded as
`.ts` only then, and with `RATE_LIMIT_RPM` raised (the default is 100 requests a minute per key).
Node's start-up is slower this way; the measured requests are not. The child runs in `services/gateway`,
where dotenv would fill in every name of a developer's `services/gateway/.env` that is unset (the CLI's
gateway reads no such file); the bench sets those names empty, since a `.env` with the unified token
system switched on made the bench's key hit 100 requests a minute.

## `logger`: the logger path alone

An in-process Express app that uses nothing of the gateway but `@libs/logger`. Each request sets the
logger's request context (`logger.runWithRequestContext(...)`, the one call to change when the context
handling changes), writes 37 log lines at INFO with small metadata (37 is the measured production
average per request), waits 5 ms on a timer and answers. File logging is off, and `console.info`,
`console.debug`, `console.warn` and `console.error` are replaced by no-ops for the run, so the terminal
is not flooded and the timing is not the terminal's; the logger still formats every line.

Measures: the cost of formatting and routing 37 log lines inside a request, and of whatever a later
change adds to that path (the request context, a sink that queues entries). Does not measure
anything of the gateway, HTTP routing of a real request or file output. This is the mode where the
log-shipping variants are compared.

## `raw`: the raw capture path alone

An in-process Express app with the gateway's real raw capture tap (`middlewares/rawCaptureTap.ts`) and
payload logger. Each request is authenticated as one credential, passes the tap, records 6 payload
logger stages (file logging off), waits 5 ms and answers a chat completion. Valkey is a stand-in whose
XADD resolves at once. `BENCH_RAW` picks the sessions: `off` (default, none), `other` (a session for
another credential) or `own` (a session for the bench's credential: every request is collected, sealed
and handed to the stand-in). A standalone gateway never holds sessions, so these cannot run through `e2e`.

Measures: the tap's check per request, the payload logger's hand-over, and for `own` the copying,
cutting, sealing and serialising of a captured request. Does not measure Valkey or the gateway around it.

## Baseline of this commit

Date 2026-11-11, `arm64` (Apple M2 Pro), Node v20.19.5, unchanged logger. Five runs per mode.

`e2e`

| run | p50 | p95 | mean |
|---|---|---|---|
| 1 | 7.942 | 9.507 | 8.020 |
| 2 | 8.049 | 10.144 | 8.205 |
| 3 | 8.546 | 10.159 | 8.743 |
| 4 | 8.180 | 9.806 | 8.499 |
| 5 | 8.347 | 10.352 | 8.590 |

Median p50 8.180 ms, noise 0.604 ms; median p95 10.144 ms, noise 0.845 ms.

`logger`

| run | p50 | p95 | mean |
|---|---|---|---|
| 1 | 6.723 | 7.764 | 6.571 |
| 2 | 6.771 | 8.510 | 6.706 |
| 3 | 6.635 | 8.381 | 6.701 |
| 4 | 6.521 | 8.224 | 6.641 |
| 5 | 6.882 | 9.904 | 7.467 |

Median p50 6.723 ms, noise 0.361 ms; median p95 8.381 ms, noise 2.140 ms.

Separate sessions on the same machine moved the median p50 of `e2e` between about 8.2 and 8.6 ms, so
compare runs taken close together in time, and repeat a failing comparison once before believing it.

## Task 3: request ids

Each log line carries its own request's id: the logger keeps the request context in an
`AsyncLocalStorage` (`runWithRequestContext`) instead of one field. The `logger` mode now calls
`runWithRequestContext`, around the whole request. Date 2026-11-11, same machine and Node as above;
baseline (variant `baseline-task3`) and candidate (variant `request-context`) were taken in one sitting.

`e2e`: `withinNoise` ok = true; p50 delta +0.034 ms (noise 1.083 ms), p95 delta -0.911 ms (noise 2.392 ms).

```
{"mode":"e2e","variant":"baseline-task3","run":1,"p50":8.042,"p95":10.224,"mean":8.289,"requests":2000}
{"mode":"e2e","variant":"baseline-task3","run":2,"p50":8.414,"p95":11.307,"mean":8.607,"requests":2000}
{"mode":"e2e","variant":"baseline-task3","run":3,"p50":9.125,"p95":12.616,"mean":9.933,"requests":2000}
{"mode":"e2e","variant":"baseline-task3","run":4,"p50":8.754,"p95":11.034,"mean":8.867,"requests":2000}
{"mode":"e2e","variant":"baseline-task3","run":5,"p50":8.602,"p95":10.71,"mean":8.929,"requests":2000}
{"mode":"e2e","variant":"request-context","run":1,"p50":8.576,"p95":10.927,"mean":8.827,"requests":2000}
{"mode":"e2e","variant":"request-context","run":2,"p50":8.669,"p95":10.123,"mean":8.668,"requests":2000}
{"mode":"e2e","variant":"request-context","run":3,"p50":8.759,"p95":11.949,"mean":9.137,"requests":2000}
{"mode":"e2e","variant":"request-context","run":4,"p50":8.636,"p95":10.113,"mean":8.842,"requests":2000}
{"mode":"e2e","variant":"request-context","run":5,"p50":8.277,"p95":9.739,"mean":8.327,"requests":2000}
```

`logger`, first comparison: ok = false; p50 delta +0.417 ms (noise 0.356 ms), p95 delta +0.178 ms
(noise 0.547 ms).

```
{"mode":"logger","variant":"baseline-task3","run":1,"p50":7.078,"p95":8.661,"mean":7.171,"requests":2000}
{"mode":"logger","variant":"baseline-task3","run":2,"p50":7.162,"p95":8.979,"mean":7.221,"requests":2000}
{"mode":"logger","variant":"baseline-task3","run":3,"p50":7.434,"p95":9.208,"mean":7.464,"requests":2000}
{"mode":"logger","variant":"baseline-task3","run":4,"p50":7.362,"p95":9.12,"mean":7.499,"requests":2000}
{"mode":"logger","variant":"baseline-task3","run":5,"p50":7.186,"p95":8.918,"mean":7.336,"requests":2000}
{"mode":"logger","variant":"request-context","run":1,"p50":7.86,"p95":9.66,"mean":7.977,"requests":2000}
{"mode":"logger","variant":"request-context","run":2,"p50":7.218,"p95":9.039,"mean":7.29,"requests":2000}
{"mode":"logger","variant":"request-context","run":3,"p50":7.573,"p95":9.049,"mean":7.685,"requests":2000}
{"mode":"logger","variant":"request-context","run":4,"p50":7.603,"p95":9.157,"mean":7.626,"requests":2000}
{"mode":"logger","variant":"request-context","run":5,"p50":7.76,"p95":9.435,"mean":7.891,"requests":2000}
```

`logger`, repeated once as this README asks (baseline taken on the unchanged logger, candidate straight
after): ok = true; p50 delta +0.089 ms (noise 0.411 ms), p95 delta +0.261 ms (noise 0.757 ms).

```
{"mode":"logger","variant":"baseline-task3","run":1,"p50":7.414,"p95":8.936,"mean":7.513,"requests":2000}
{"mode":"logger","variant":"baseline-task3","run":2,"p50":7.54,"p95":8.917,"mean":7.569,"requests":2000}
{"mode":"logger","variant":"baseline-task3","run":3,"p50":7.528,"p95":9.519,"mean":7.7,"requests":2000}
{"mode":"logger","variant":"baseline-task3","run":4,"p50":7.129,"p95":8.762,"mean":7.106,"requests":2000}
{"mode":"logger","variant":"baseline-task3","run":5,"p50":7.211,"p95":9.016,"mean":7.318,"requests":2000}
{"mode":"logger","variant":"request-context","run":1,"p50":7.486,"p95":9.09,"mean":7.508,"requests":2000}
{"mode":"logger","variant":"request-context","run":2,"p50":7.515,"p95":9.348,"mean":7.627,"requests":2000}
{"mode":"logger","variant":"request-context","run":3,"p50":7.679,"p95":9.197,"mean":7.8,"requests":2000}
{"mode":"logger","variant":"request-context","run":4,"p50":7.503,"p95":9.427,"mean":7.558,"requests":2000}
{"mode":"logger","variant":"request-context","run":5,"p50":7.445,"p95":9.048,"mean":7.588,"requests":2000}
```

## Task 5: log shipping

The gateway's logger has a sink that queues entries in memory; a timer hands the queue to Valkey. The
`logger` mode takes the switch `BENCH_SINK`: `off` (default, no shipper), `resolve` (the real
`startLogShipper`, a `publish` that resolves at once, settings `{ enabled: true, minLevel: 'INFO' }`)
and `hang` (the same with a `publish` that never resolves, so the queue fills to its 5,000 and drops).
Date 2026-11-11, same machine and Node as above; the three variants were taken one after the other in
one sitting (`BENCH_SINK=<x> BENCH_VARIANT=sink-<x>`), `sink-off` first.

`sink-off` against `sink-resolve`: ok = true; p50 delta -0.078 ms (noise 0.805 ms), p95 delta -0.081 ms
(noise 0.130 ms).
`sink-off` against `sink-hang`: ok = true; p50 delta -0.083 ms (noise 0.805 ms), p95 delta -0.002 ms
(noise 0.130 ms).

```
{"mode":"logger","variant":"sink-off","run":1,"p50":7.461,"p95":9.094,"mean":7.436,"requests":2000}
{"mode":"logger","variant":"sink-off","run":2,"p50":8.266,"p95":9.115,"mean":7.967,"requests":2000}
{"mode":"logger","variant":"sink-off","run":3,"p50":7.588,"p95":9.224,"mean":7.64,"requests":2000}
{"mode":"logger","variant":"sink-off","run":4,"p50":7.56,"p95":9.115,"mean":7.499,"requests":2000}
{"mode":"logger","variant":"sink-off","run":5,"p50":7.607,"p95":9.137,"mean":7.85,"requests":2000}
{"mode":"logger","variant":"sink-resolve","run":1,"p50":7.471,"p95":8.893,"mean":7.428,"requests":2000}
{"mode":"logger","variant":"sink-resolve","run":2,"p50":7.51,"p95":9.004,"mean":7.392,"requests":2000}
{"mode":"logger","variant":"sink-resolve","run":3,"p50":7.516,"p95":9.034,"mean":7.461,"requests":2000}
{"mode":"logger","variant":"sink-resolve","run":4,"p50":7.634,"p95":9.082,"mean":7.751,"requests":2000}
{"mode":"logger","variant":"sink-resolve","run":5,"p50":7.51,"p95":9.075,"mean":7.582,"requests":2000}
{"mode":"logger","variant":"sink-hang","run":1,"p50":7.496,"p95":8.985,"mean":7.373,"requests":2000}
{"mode":"logger","variant":"sink-hang","run":2,"p50":7.463,"p95":9.191,"mean":7.313,"requests":2000}
{"mode":"logger","variant":"sink-hang","run":3,"p50":7.601,"p95":9.113,"mean":7.651,"requests":2000}
{"mode":"logger","variant":"sink-hang","run":4,"p50":7.618,"p95":9.18,"mean":7.747,"requests":2000}
{"mode":"logger","variant":"sink-hang","run":5,"p50":7.505,"p95":9.042,"mean":7.61,"requests":2000}
```

## Task 12: the default

Whether the gateway's log ships stored by default: only if the shipper costs a request nothing
measurable. Date 2026-11-12, same machine as above, Node v20.19.5, the finished branch; the three
`logger` variants one after the other in one sitting, nothing else running
(`BENCH_SINK=<x> BENCH_VARIANT=final-sink-<x>`), `final-sink-off` first, then the `e2e` runs.

`final-sink-off` against `final-sink-resolve`: ok = true; p50 delta -0.011 ms (noise 0.309 ms), p95
delta +0.078 ms (noise 0.453 ms).
`final-sink-off` against `final-sink-hang`: ok = true; p50 delta -0.054 ms (noise 0.309 ms), p95
delta -0.010 ms (noise 0.453 ms).

Both on the first attempt, so no repeat. Decision: storing the log ships switched on
(`observability.gateway_log.enabled: true`, and `true` for a configuration without the block).

```
{"mode":"logger","variant":"final-sink-off","run":1,"p50":7.02,"p95":8.361,"mean":6.953,"requests":2000}
{"mode":"logger","variant":"final-sink-off","run":2,"p50":6.987,"p95":8.318,"mean":6.959,"requests":2000}
{"mode":"logger","variant":"final-sink-off","run":3,"p50":6.997,"p95":8.311,"mean":6.978,"requests":2000}
{"mode":"logger","variant":"final-sink-off","run":4,"p50":6.711,"p95":8.179,"mean":6.756,"requests":2000}
{"mode":"logger","variant":"final-sink-off","run":5,"p50":6.775,"p95":8.632,"mean":6.95,"requests":2000}
{"mode":"logger","variant":"final-sink-resolve","run":1,"p50":7.239,"p95":8.396,"mean":7.11,"requests":2000}
{"mode":"logger","variant":"final-sink-resolve","run":2,"p50":6.862,"p95":8.313,"mean":6.811,"requests":2000}
{"mode":"logger","variant":"final-sink-resolve","run":3,"p50":6.976,"p95":8.425,"mean":6.919,"requests":2000}
{"mode":"logger","variant":"final-sink-resolve","run":4,"p50":6.919,"p95":8.336,"mean":6.899,"requests":2000}
{"mode":"logger","variant":"final-sink-resolve","run":5,"p50":7.002,"p95":8.504,"mean":7.082,"requests":2000}
{"mode":"logger","variant":"final-sink-hang","run":1,"p50":6.933,"p95":8.308,"mean":6.862,"requests":2000}
{"mode":"logger","variant":"final-sink-hang","run":2,"p50":6.95,"p95":8.234,"mean":6.819,"requests":2000}
{"mode":"logger","variant":"final-sink-hang","run":3,"p50":6.881,"p95":8.326,"mean":6.74,"requests":2000}
{"mode":"logger","variant":"final-sink-hang","run":4,"p50":6.909,"p95":8.205,"mean":6.811,"requests":2000}
{"mode":"logger","variant":"final-sink-hang","run":5,"p50":7.006,"p95":8.547,"mean":6.951,"requests":2000}
```

`e2e` (variant `final-e2e`) against the baseline at the top of this README, for information only: the
two were taken a day apart on a shared machine, and a standalone gateway ships no log. ok = true; p50
delta +0.357 ms (noise 0.604 ms), p95 delta -0.011 ms (noise 0.845 ms).

```
{"mode":"e2e","variant":"final-e2e","run":1,"p50":8.755,"p95":10.236,"mean":8.908,"requests":2000}
{"mode":"e2e","variant":"final-e2e","run":2,"p50":8.537,"p95":9.812,"mean":8.543,"requests":2000}
{"mode":"e2e","variant":"final-e2e","run":3,"p50":8.863,"p95":10.723,"mean":9.107,"requests":2000}
{"mode":"e2e","variant":"final-e2e","run":4,"p50":8.338,"p95":10.133,"mean":8.561,"requests":2000}
{"mode":"e2e","variant":"final-e2e","run":5,"p50":8.3,"p95":9.664,"mean":8.337,"requests":2000}
```

## Part 2, Task 4: raw capture

Date 2026-11-13, same machine (`arm64`, Apple M2 Pro), Node v20.19.5, one sitting, other sessions'
processes running beside it (load average about 2 to 4). `e2e` first: the baseline on the commit
before raw capture (variant `baseline-task4`, the four changed source files put back to their state
there, the bench as here), then the candidate (variant `raw-capture-no-session`); then the three
`raw` variants (`BENCH_RAW=<x> BENCH_VARIANT=raw-<x>`), `raw-off` first.

No session (`e2e`, standalone, where no session can exist): ok = true; p50 delta +0.094 ms (noise
0.544 ms), p95 delta -0.100 ms (noise 1.034 ms).
A session for another credential (`raw-off` against `raw-other`): ok = true; p50 delta -0.060 ms (noise
0.212 ms), p95 delta -0.269 ms (noise 0.542 ms).
A session for the bench's credential (`raw-off` against `raw-own`): ok = false, as expected for a request
that is captured; p50 delta +0.570 ms (noise 0.212 ms), p95 delta +0.889 ms (noise 0.542 ms). All 15,000
requests of that run (warm-up included) were published.

```
{"mode":"e2e","variant":"baseline-task4","run":1,"p50":8.739,"p95":10.257,"mean":8.928,"requests":2000}
{"mode":"e2e","variant":"baseline-task4","run":2,"p50":8.623,"p95":9.946,"mean":8.625,"requests":2000}
{"mode":"e2e","variant":"baseline-task4","run":3,"p50":9.015,"p95":10.786,"mean":9.229,"requests":2000}
{"mode":"e2e","variant":"baseline-task4","run":4,"p50":8.558,"p95":10.108,"mean":8.755,"requests":2000}
{"mode":"e2e","variant":"baseline-task4","run":5,"p50":8.471,"p95":9.752,"mean":8.482,"requests":2000}
{"mode":"e2e","variant":"raw-capture-no-session","run":1,"p50":8.98,"p95":10.804,"mean":9.195,"requests":2000}
{"mode":"e2e","variant":"raw-capture-no-session","run":2,"p50":8.717,"p95":9.889,"mean":8.715,"requests":2000}
{"mode":"e2e","variant":"raw-capture-no-session","run":3,"p50":8.79,"p95":10.512,"mean":9.024,"requests":2000}
{"mode":"e2e","variant":"raw-capture-no-session","run":4,"p50":8.636,"p95":10.008,"mean":8.746,"requests":2000}
{"mode":"e2e","variant":"raw-capture-no-session","run":5,"p50":8.511,"p95":9.79,"mean":8.515,"requests":2000}
{"mode":"raw","variant":"raw-off","run":1,"p50":7.216,"p95":8.967,"mean":7.327,"requests":2000}
{"mode":"raw","variant":"raw-off","run":2,"p50":7.032,"p95":8.764,"mean":7.101,"requests":2000}
{"mode":"raw","variant":"raw-off","run":3,"p50":7.045,"p95":9.176,"mean":7.098,"requests":2000}
{"mode":"raw","variant":"raw-off","run":4,"p50":7.244,"p95":9.306,"mean":7.397,"requests":2000}
{"mode":"raw","variant":"raw-off","run":5,"p50":7.135,"p95":8.859,"mean":7.246,"requests":2000}
{"mode":"raw","variant":"raw-other","run":1,"p50":7.049,"p95":8.521,"mean":7.091,"requests":2000}
{"mode":"raw","variant":"raw-other","run":2,"p50":7.13,"p95":8.698,"mean":7.178,"requests":2000}
{"mode":"raw","variant":"raw-other","run":3,"p50":6.917,"p95":8.626,"mean":6.986,"requests":2000}
{"mode":"raw","variant":"raw-other","run":4,"p50":7.075,"p95":8.905,"mean":7.166,"requests":2000}
{"mode":"raw","variant":"raw-other","run":5,"p50":7.206,"p95":9.07,"mean":7.293,"requests":2000}
{"mode":"raw","variant":"raw-own","run":1,"p50":7.4,"p95":9.545,"mean":7.516,"requests":2000}
{"mode":"raw","variant":"raw-own","run":2,"p50":7.742,"p95":9.785,"mean":7.903,"requests":2000}
{"mode":"raw","variant":"raw-own","run":3,"p50":8.152,"p95":9.856,"mean":7.988,"requests":2000}
{"mode":"raw","variant":"raw-own","run":4,"p50":7.528,"p95":10.364,"mean":8.019,"requests":2000}
{"mode":"raw","variant":"raw-own","run":5,"p50":7.705,"p95":10.002,"mean":7.818,"requests":2000}
```
