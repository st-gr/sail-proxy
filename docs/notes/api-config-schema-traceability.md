# api_config schema — field traceability

The `description` texts in `services/admin/src/schemas/api-config-schema.json` are rendered verbatim
in the admin config form's ⓘ popovers, so they are written for operators: what a setting does, what
values it takes, what happens when it is absent. They no longer carry `file.ts:line` pointers.

This note holds the developer-facing half that was removed from them: for each configuration
pointer, the gateway code that actually reads it. Line numbers are a snapshot taken when the
descriptions were rewritten (BASE `2e92411`) — treat them as a starting point for a grep, not as a
guarantee. All paths are relative to `services/gateway/`.

Fields with no consumer listed here are read by nothing today; the description says so in prose.

---

## providers

| Pointer | Consumer |
|---|---|
| `providers` (which keys the gateway reads) | `PROVIDER_KEYS` / `providerConfig()` in `src/services/configService.ts` |
| `providers.openai.openai_deployment_api_version` | `src/controllers/openaiController.ts:190`; `getOpenAIDeploymentApiVersion` hardcodes the `openai` key |
| `providers.openrouter.default_pricing` | none — only the `OpenRouterProviderConfig` type in `src/services/configService.ts:73-78` |
| `providers.openrouter.model_mappings` | `src/controllers/openRouterController.ts:66-73` (only `provider` and `max_tokens` are read) |
| `providers.openrouter.model_mappings[].default_context_length` | none |
| `providers.openrouter.model_mappings[].id_prefix` | none |
| `providers.<provider>` (five named, closed) | each names its own keys through `propertyNames`; the sets below are what that enum lists |
| `providers.<provider>` (any other key, open shape) | `ProviderConfig` in `src/services/configService.ts` — no index signature, so unknown keys are inert |
| `providers.anthropic.anthropic_bedrock_version` | `src/controllers/anthropicController.ts:336` via `getAnthropicBedrockVersion` (hardcodes the `anthropic` key) |
| `providers.anthropic.excluded_beta_headers` | `filterBetaFeatures`, `src/services/awsBedrockService.ts:194`; `getExcludedBetaHeaders` takes no provider argument |
| `providers.anthropic.supported_beta_headers` | `filterBetaFeatures`, `src/services/awsBedrockService.ts:190`; `getSupportedBetaHeaders` takes no provider argument |
| `providers.<provider>.emulate_streaming_for_models` | `shouldEmulateStreaming`, `src/services/configService.ts:1288` — provider-argument, but only two literals are ever passed: `'anthropic'` (`anthropicController.ts:340`, `:1313`) and `'openai'` (`openaiController.ts:297`, `:402`, `:708`). The shipped `aws-bedrock` list is inert |
| `providers.<provider>.substitute_models` | `getSubstitutedModel`, `src/services/configService.ts:1226` — passed `'anthropic'` (`anthropicController.ts`, `countTokensController.ts:52`, `anthropicService.ts:93`, `anthropicResponseService.ts:140`, `plugins/pseudonymization/index.ts`), `'aws-bedrock'` (`awsBedrockController.ts:71`, `:216`) and `'openrouter'` (`openRouterController.ts:123`). The shipped `openai` list is inert. `getOriginalModel` (`:1257`) is exported and has no call site |
| `providers.<provider>.substitute_models[].description` | none |
| `providers.<provider>.supports_prompt_caching` | `resolvePromptCachingSupport`, `src/utils/promptCachingSupport.ts`; read at `src/controllers/responsesController.ts:439` and `src/services/awsBedrockService.ts:231`, both with the provider taken from `modelDetails.provider`/`owned_by` |
| `providers.<provider>.unsupported_params` | the parameter-stripping step on the direct-deployment path — `getUnsupportedParams` at `src/controllers/openaiController.ts:219`, `:1134` and `src/controllers/responsesController.ts:767`, each with a provider read off the model's own metadata, so any of the five can be looked up |
| `providers.<provider>.param_renames` | the parameter-rename step on the direct-deployment path — `getParamRenames` at `src/controllers/openaiController.ts:232` and `src/controllers/responsesController.ts:771`, same model-derived provider |
| `providers.<provider>.supports_responses_api` | the `/openai/v1/responses` eligibility check (family heuristic otherwise) — `getSupportsResponsesApi` at `src/controllers/responsesController.ts:682`, `:707`, same model-derived provider |

The schema splits these across two `$defs`. `providerCommon` holds the six a request path resolves
for whichever provider it routed to (`emulate_streaming_for_models`, `substitute_models`,
`unsupported_params`, `param_renames`, `supports_responses_api`, `supports_prompt_caching`);
`anthropicCompatibleProvider` holds the three above it that only the Anthropic path reads, composed
by `allOf` onto `anthropic` and `aws-bedrock` alone. Two of the common six are in fact narrower than
the def they live in — `emulate_streaming_for_models` is looked up for two providers and
`substitute_models` for three, as the rows above record — and are kept common rather than split
further because the shipped `api_config.json` already carries each under a provider that does not
read it, and moving them would strand those values as undeclared keys instead of leaving them
visible and documented as inert.

## models.overrides

| Pointer | Consumer |
|---|---|
| `models.overrides.<model>` (open merge) | `src/services/modelService.ts:434-438`; `ModelOverride`'s `[key: string]: unknown` in `src/services/configService.ts` |
| `models.overrides.<model>.hooks` | `getHookConfig(modelId, subpath, endpoint)`, `src/services/configService.ts:2077-2096`; executed by `src/services/pluginExecutor.ts` |
| `models.overrides.<model>.subpaths_native` | `isSubpathNative`, `src/services/awsBedrockService.ts:354-358`; applied at `src/services/modelService.ts:427-429`, republished at `:643` |
| `models.overrides.<model>.subpaths_emulated` | applied at `src/services/modelService.ts:430-432`, republished at `:644`; nothing routes on it |
| `models.overrides.<model>.streamingSupported` | `src/services/modelService.ts:439-452`, plus the runtime `streamingSupportCache` |
| `models.overrides.<model>.supports_prompt_caching` | `resolvePromptCachingSupport`, `src/utils/promptCachingSupport.ts` |
| `models.overrides.<model>.anthropic_version` | `src/services/awsBedrockService.ts:170-172` (invoke bodies only) |
| `models.overrides.<model>.cachePricing` | `CachePricing` at `src/services/configService.ts:90-93`; pushed onto versions at `src/services/modelService.ts:467-481`; `getCachePricingForModel`, `src/services/configService.ts:2009-2026` |
| `models.overrides.<model>.inject_beta_features` | `src/services/awsBedrockService.ts:184-186`, then `filterBetaFeatures` and the runtime beta-flag quarantine |
| `models.overrides.<model>.contextLength` | `getModelContextLength`, `src/services/openRouterService.ts:338-350`; reported at `:194-210` and `:294-309` |
| `models.overrides.<model>.unsupported_params` / `.param_renames` / `.supports_responses_api` | same consumers as the provider-level fields above |
| `models.overrides.<model>.pseudonymization` | `getModelForcedConfig`, see the observability table |

## capabilities

| Pointer | Consumer |
|---|---|
| `capabilities.web_search.max_searches_per_request` | `getWebSearchMaxSearches`, `src/plugins/webSearch/searchCap.ts` |
| `capabilities.file_search` (whole block) | `getFileSearchConfig`, `src/services/configService.ts:1651`; defaults at `:1586` (`FILE_SEARCH_DEFAULTS`) |
| `capabilities.file_search.enabled` | `isFileSearchAvailable`, `src/fileSearch/db.ts:20-22`; `src/controllers/filesController.ts:502`, `src/controllers/vectorStoresController.ts:606`, `src/fileSearch/ingestWorker.ts:669`, `src/fileSearch/expirySweeper.ts:153` |
| `capabilities.file_search.embedding_model` | `src/fileSearch/embedder.ts:127`; logged at `src/fileSearch/search.ts:335` |
| `capabilities.file_search.embedding_dimensions` | `src/fileSearch/embedder.ts:130`, column build at `src/fileSearch/db.ts:204`, length guard at `src/fileSearch/embedder.ts:193-201`, `assertStoreDimension` at `src/fileSearch/repository.ts:570-579` |
| `capabilities.file_search.rewrite_query` | `src/fileSearch/queryRewriter.ts`, read at `src/fileSearch/search.ts:196`; the hosted tool passes `false` at `src/plugins/fileSearch/descriptor.ts:489` |
| `capabilities.file_search.rewrite_query_model` | `src/fileSearch/queryRewriter.ts:77` |
| `capabilities.file_search.hybrid` | `recallCandidates`, `src/fileSearch/repository.ts:239` |
| `capabilities.file_search.hybrid.rrf_k` | `fuseRrf`, `src/fileSearch/repository.ts:391`; logged at `src/fileSearch/search.ts:338` |
| `capabilities.file_search.hybrid.lexical_enabled` | `src/fileSearch/repository.ts:297,329,390` |
| `capabilities.file_search.hybrid.candidates` | `src/fileSearch/repository.ts:246`, `src/fileSearch/search.ts:227` |
| `capabilities.file_search.hybrid.rerank` | `src/fileSearch/reranker.ts` |
| `capabilities.file_search.hybrid.rerank.enabled` | `src/fileSearch/reranker.ts:30-43,119-137` |
| `capabilities.file_search.hybrid.rerank.model` | `src/fileSearch/reranker.ts:13-15`; provider fixed as `cohere` at `src/fileSearch/search.ts:322-334` |
| `capabilities.file_search.chunking` | read into `FileSearchConfig` at `src/services/configService.ts:1671-1673`; no downstream reader — `resolveChunkingStrategy`, `src/fileSearch/chunker.ts:53-92`, uses its own constants |
| `capabilities.file_search.chunking.max_chunk_size_tokens` | `estimateTokens` / `DEFAULT_MAX_CHUNK_SIZE_TOKENS`, `src/fileSearch/chunker.ts:14,44-50` |
| `capabilities.file_search.chunking.chunk_overlap_tokens` | per-store bound at `src/fileSearch/chunker.ts:79-87` (this field is not fed into it) |
| `capabilities.file_search.limits.max_file_bytes` | `src/controllers/filesController.ts:389,425,513,533` |
| `capabilities.file_search.limits.max_tokens_per_file` | `src/fileSearch/ingestWorker.ts:108,573-574` (`FileTooLargeError`) |
| `capabilities.file_search.limits.max_files_per_store` | `src/controllers/vectorStoresController.ts:263,615-616,875-876`; hard `MAX_FILE_IDS_PER_CREATE` of 500 |
| `capabilities.file_search.ingestion` | `src/fileSearch/ingestWorker.ts` |
| `capabilities.file_search.ingestion.concurrency` | `src/fileSearch/ingestWorker.ts:683-686`; pool size at `src/fileSearch/db.ts:15`; embedder fan-out is separate, `src/fileSearch/embedder.ts:20` |
| `capabilities.file_search.ingestion.extract_timeout_ms` | `extractText`, `src/fileSearch/ingestWorker.ts:570` |
| `capabilities.file_search.ingestion.max_retries` | `resolveMaxRetries`, `src/services/configService.ts:1736-1753`; `reapZombies` / `claimNext` in `src/fileSearch/repository.ts` |
| `capabilities.file_search.blob_storage` | `retainBlob` / `getBackend`, `src/fileSearch/blob/blobStore.ts` |
| `capabilities.file_search.blob_storage.backend` | `getBackend`, `src/fileSearch/blob/blobStore.ts:63-71` (`UnsupportedBlobBackendError` for `local` and `s3`) |
| `capabilities.file_search.blob_storage.local_path` | `src/fileSearch/blob/localBackend.ts:9-12` |
| `capabilities.file_search.blob_storage.s3.*` | `src/fileSearch/blob/s3Backend.ts` — host/path form `:27-33`, region `:33,58`, `keyFor` `:75` |
| `capabilities.file_search.teacher_logging` | `src/fileSearch/teacherLogger.ts`; failure path `:210-242` |
| `capabilities.file_search.teacher_logging.enabled` | `src/fileSearch/teacherLogger.ts:226` |
| `capabilities.file_search.teacher_logging.store_chunk_text` | `src/fileSearch/teacherLogger.ts:179` |
| `capabilities.file_search.teacher_logging.sample_rate` | `src/fileSearch/teacherLogger.ts:229` |
| `capabilities.file_search.teacher_logging.source` | `src/fileSearch/teacherLogger.ts:131` |
| `capabilities.file_search.teacher_logging.max_concurrent_writes` | `resolveMaxConcurrentWrites`, `src/services/configService.ts:1795`; ceiling is the pool `max: 10` in `src/fileSearch/db.ts` |
| `capabilities.file_search.tool` | `getFileSearchToolConfig`, `src/services/configService.ts:1927` |
| `capabilities.file_search.tool.enabled` | `resolveToolEnabled`, `src/services/configService.ts:1915-1917` — no reader of the resolved value; `responsesFileSearchPlugin.ts` registers the descriptor regardless |
| `capabilities.file_search.tool.max_searches_per_request` | `maxCallsPerRequest`, `src/plugins/fileSearch/descriptor.ts:688`; `resolveMaxSearchesPerRequest`, `src/services/configService.ts:1880-1893` |
| `capabilities.file_search.tool.max_num_results_default` | `src/plugins/fileSearch/descriptor.ts:413`; `resolveMaxNumResultsDefault`, `src/services/configService.ts:1902-1908`; bounds `MIN/MAX_RESULTS_DEFAULT` at `:1855-1856` |
| `capabilities.hosted_tools.*` | `getHostedToolResultCacheTtlSeconds` / `…MaxEntries`, `src/plugins/hostedTool/resultCacheConfig.ts` |
| `capabilities.namespace_tools.mode` | `getNamespaceToolMode`, `src/plugins/namespaceTools/adapter.ts` |
| `capabilities.custom_tools.mode` | the Codex freeform-`custom` tool adapter |
| `capabilities.tool_search.mode` / `.hoist_discovered_tools` | the Codex `tool_search` adapter |

## hooks

| Pointer | Consumer |
|---|---|
| hook list (`hooks.defaults.<endpoint>.<subpath>` and `models.overrides.<model>.hooks.<subpath>`) | `getHookConfig`, `src/services/configService.ts:2077-2096`; `matchAll`, `src/services/pluginLoader.ts:255-295`; `executeBeforePlugins` / `executeAfterPlugins` / `executeStreamPlugins`, `src/services/pluginExecutor.ts` |
| `…hooks.<subpath>[].request.callback.id` | `pluginLoader.getRule(id, <phase>)`, `src/services/pluginLoader.ts:224-236` |
| `…hooks.<subpath>[].request.callback.strategy` | none — the phase comes from `PluginRule.strategy`, `src/services/pluginLoader.ts:17-22` |
| `…hooks.<subpath>[].request.match` | `matchAll`, `src/services/pluginLoader.ts:277-278` |
| `hooks.definitions` | `src/services/pluginLoader.ts:277-278`; per-id cache `global.matcherCache`, cleared on `reloadAll` |
| `hooks.definitions.<id>.type` | `matchRuleOptimized`, `src/services/pluginLoader.ts:304-320` (default case logs `Unknown hook type`) |
| `hooks.definitions.<id>.name` | `matchHeader`, `src/services/pluginLoader.ts:356-357` (lowercased before lookup) |
| `hooks.definitions.<id>.path` | `src/services/pluginLoader.ts:390` (`$.` prefix stripped) |
| `hooks.definitions.<id>.equals` | `headerValueMatches`, `src/services/pluginLoader.ts:342-345` (media-type compare); strict `===` for `json-path` at `:403` |
| `hooks.definitions.<id>.from` / `.to` | the numeric-header branch of `matchHeader` |
| `hooks.definitions.<id>.regex` / `.flags` | `src/services/pluginLoader.ts:515` for `url-regex` (`req.url`); compiled-expression cache keyed by id, source and flags |
| `hooks.definitions.<id>.desc` | none — `HookDefinition` in `src/services/pluginLoader.ts` does not declare the key |
| `hooks.defaults` | `getHookConfig`, `src/services/configService.ts:2077-2096` |
| `hooks.defaults.<endpoint>.pseudonymization` | `getModelForcedConfig`, see the observability table |

## platform

| Pointer | Consumer |
|---|---|
| `platform.timeouts.default` / `.streaming` | `getTimeout`, `src/services/configService.ts` (fallbacks 120000 / 240000 ms) |
| `platform.logging.*` | the shared logger, `libs/logger`, re-initialized by `ConfigService` after a configuration change |
| `platform.logging.payload_logging_enabled` | `src/utils/payloadLogger.ts` |
| `platform.rate_limit_handling.*` | `RateLimitManager` / `getConfiguredDelay`, `src/services/rateLimitManager.ts` (fallbacks 30 s, ×1.5, 300 s) |
| `platform.security.trust_forwarded_for` | `getClientIp`, `src/utils/clientIp.ts` |
| `platform.security.credentialExpirationDays` | `credentialExpirationDays()`, `services/admin/src/services/credentialLifecycle.ts` (fallback 90 days; applies to API keys and AWS credentials, on creation and on every refresh) |

## observability

| Pointer | Consumer |
|---|---|
| `observability.pseudonymization` | `pseudonymizationPlugin`, `src/plugins/pseudonymization/index.ts` |
| `<pseudonymization>.method` | `afterHandler`, `src/plugins/pseudonymization/index.ts`; SIEM content gate in `src/…/siemUsageEvent.ts`; only read from a force-activation block (`getModelForcedConfig`) |
| `<pseudonymization>.allow_user_bypass` | `isBypassRequested`, `src/plugins/pseudonymization/index.ts:384-426`; resolved at `:351` / `:364` (`=== true`); unmasked-content gate in `siemUsageEvent.ts` |
| `<pseudonymization>.entities` | `applyEntityToggles` / `KNOWN_ENTITY_TYPES` / `DEFAULT_MASKING_CONFIG`, `src/plugins/pseudonymization/entityToggles.ts` |
| `<pseudonymization>.org_suffixes` | `detectOrgs`, `src/plugins/pseudonymization/orgLocationDetector.ts`; `resolveMaskingLists`, `index.ts` |
| `<pseudonymization>.location_gazetteer` | `detectLocations`, `src/plugins/pseudonymization/orgLocationDetector.ts`; `resolveMaskingLists`, `index.ts`; ships empty by policy (`types.ts`) |
| `<pseudonymization>.min_confidence` | `resolveThresholds`, `src/plugins/pseudonymization/detectors/confidence.ts`, applied as the gate in `detectEntities` (`detectors/index.ts`); resolved per request by `resolveConfidenceConfig`, `index.ts`. Default 0.5 (`DEFAULT_MIN_CONFIDENCE`); a value outside 0-1 is dropped rather than clamped. The score it is compared against comes from `scoreMatch` — bases in `confidenceScores.ts`, adjustments in `confidence.ts` — and no NEGATIVE adjustment reaches a type in `EXEMPT_FROM_SUPPRESSION` |
| `<pseudonymization>.thresholds` | same pair — `resolveThresholds` builds the per-category map and `thresholdFor` prefers it over `min_confidence`; merged PER CATEGORY across the three layers by `resolveConfidenceConfig`, unlike `org_suffixes`/`location_gazetteer`, which the last layer replaces outright |
| `<pseudonymization>.allowlist` | `compileAllowlist` / `isAllowlisted`, `src/plugins/pseudonymization/detectors/allowlist.ts`, applied in `detectEntities` (`detectors/index.ts`) AFTER the technical veto and BEFORE scoring; resolved per request by `resolveReportingConfig`, `index.ts`. `terms` are case-sensitive literals; `patterns` are regex sources the compiler anchors as `^(?:…)$`. An entry that does not compile is skipped with one WARN per process naming it; an entry that DOES compile but also matches a frozen sample of ordinary personal data (name, mail address, phone number, IBAN) is applied with one WARN per process naming it — the allow-list is a masking OFF switch and `warnIfOverBroad` is the only signal that one was thrown. Distinct from the older `MaskingConfig.allow_list`, a flat case-INSENSITIVE list applied before the veto |
| `<pseudonymization>.saturation_warn` | `resolveSaturationWarn` / `buildSaturationReport` / `formatSaturationWarning`, `src/plugins/pseudonymization/saturationReport.ts`; read once per request in the plugin's before handler and left on `req.__pseudonymizationSaturation`, from where `siemUsageEvent.ts` attaches the `pseudonymization` block (counts only, so gated by `emit` alone and NOT by the content gates). REPORT-ONLY: no detector and no scorer reads it. Default 40; a value that is not an integer ≥ 1 is ignored rather than coerced |
| `observability.siem.*` | the SIEM outbox dispatcher and its sinks; per-sink `validateConfig()` |
| `observability.siem.sinks[].include_content` / `.allow_unmasked_content` | the dispatcher's content gate, together with `siemUsageEvent.ts` |

The force-activation shape (`<pseudonymization>` above) appears at three pointers and is one
definition: `observability.pseudonymization`, `hooks.defaults.<endpoint>.pseudonymization` and
`models.overrides.<model>.pseudonymization`. Only the latter two force activation.

All seven non-activation keys are layered by one walker, `pseudonymizationLayers` in
`src/plugins/pseudonymization/index.ts`, in that same order — global, per-endpoint, per-model —
with later layers winning. `entities` is the exception only in mechanism: it predates the walker
and merges through `applyEntityToggles` per layer.

How a later layer wins differs per key, and the difference is deliberate:

| Key | Later layer |
|---|---|
| `min_confidence`, `saturation_warn` | replaces (scalar) |
| `org_suffixes`, `location_gazetteer` | replaces the whole list — each defines a detector's entire vocabulary |
| `entities`, `thresholds` | merges per category |
| `allowlist` | CONCATENATES — a lower layer can only add an exemption, never drop one made above it |
