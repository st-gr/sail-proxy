# 01 — The web-search system prompt never ships in the Docker image

**Status:** open · **Type:** pre-existing production defect, surfaced during phase 2 · **Impact:** medium, silent

## What is wrong

`webSearchPlugin.system-prompt.txt` exists so an operator can tune how Perplexity `sonar-pro` is instructed — it is the documented tuning knob (`webSearchPlugin.md`, "System prompt … editable without code changes"). In the Docker image it is never loaded, so every containerised search runs on the inline fallback prompt hard-coded in `searchExecutor.ts`. Editing the file changes nothing, and nothing warns you.

## Evidence

The file lives at `services/gateway/src/plugins/webSearchPlugin.system-prompt.txt`.

The build does not copy it:

```
$ node -e "console.log(require('./services/gateway/package.json').scripts.build)"
tsc -p .
```

`tsc` emits `.js` only; a `.txt` beside a source file is not an emit input.

The runtime image does not contain the source tree either — `docker/gateway.Dockerfile`'s final stage copies three directories, none of which is `src`:

```
COPY --chown=nodejs:nodejs --from=build /app/services/gateway/dist ./services/gateway/dist
COPY --chown=nodejs:nodejs --from=build /app/libs ./libs
COPY --chown=nodejs:nodejs --from=build /app/services/gateway/config ./services/gateway/config
```

So all three lookup paths in `loadSystemPrompt` (`services/gateway/src/plugins/webSearch/searchExecutor.ts`) miss:

| Path | Resolves to | Present in image? |
|---|---|---|
| `__dirname/../webSearchPlugin.system-prompt.txt` | `dist/…/plugins/webSearchPlugin.system-prompt.txt` | no — never emitted |
| six `..` then `src/plugins/…` | `/app/services/gateway/src/plugins/…` | no — `src` not copied |
| `process.cwd()/src/plugins/…` | resolves through the `/app/src` symlink back into `dist/…/plugins/` | no |

The function then logs `Failed to load system prompt from any path, using fallback` and returns the inline prompt. That warning is the only symptom, and it is easy to miss in normal log volume.

This predates all Responses work — the phase-2 review verified the *old* path set failed identically, so the extraction into `searchExecutor.ts` did not cause it.

## Fix

Add a copy step so `*.system-prompt.txt` lands beside the compiled plugins, then verify the first lookup path resolves in the image.

1. In `services/gateway/package.json`, extend `build` to copy the file into `dist` alongside the emitted plugin JS. The repo already uses `cpy` for exactly this in `services/admin`'s build script — follow that precedent rather than introducing a new tool.
2. Confirm the destination matches `loadSystemPrompt`'s first path (`__dirname/..` from `dist/services/gateway/src/plugins/webSearch/`), i.e. the file must land in `dist/services/gateway/src/plugins/`.
3. Consider promoting the fallback log from `warn` to `error` — silently running a different prompt than the operator edited is worth a louder signal.

## Verification

- `pnpm build:gateway`, then confirm the `.txt` exists under `dist/`.
- Build the image and run the gateway in it; trigger one web search and confirm the log line reads `Loaded system prompt from …` rather than the fallback warning.
- Edit the `.txt` to something distinctive, rebuild, and confirm the change reaches Perplexity (the payload log `10_perplexity_direct_response` records the query context when `DEBUG=true`).

## Files

- `services/gateway/package.json` (build script)
- `services/gateway/src/plugins/webSearch/searchExecutor.ts` (`loadSystemPrompt`, log level)
- `docker/gateway.Dockerfile` (only if the copy is done at image level instead)
