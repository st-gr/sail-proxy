-- In-place migration for an EXISTING local SQLite admin database (audio token pricing, 2026-09-15).
-- Docker/Kyma (Postgres) need nothing: schema_evolution: auto adds all of it on deploy.
-- Before running: stop the admin, then
--   sqlite3 db/admin.db "PRAGMA wal_checkpoint(TRUNCATE);"
--   cp db/admin.db db/admin.db.before-audio-tokens
-- Apply with:
--   sqlite3 db/admin.db < audio-tokens-sqlite-migration.sql
-- The statements are the compiler's own (npx cds compile src/db src/srv --to sql --dialect sqlite),
-- reduced to the delta: four new columns on ApiKeyUsage and AwsCredentialUsage (audioInputTokens,
-- audioOutputTokens, audioInputCost, audioOutputCost), two new columns on ModelCosts
-- (audioInputCost, audioOutputCost), the same four columns on AwsCredentialUsage's draft table,
-- and the seven views that select the changed columns (including AdminService_ModelPrices, which
-- exposes ModelCosts.audioInputCost/audioOutputCost for the admin's manual price entry).
BEGIN;

DROP VIEW IF EXISTS AdminService_ApiKeyUsageStats;
DROP VIEW IF EXISTS AdminService_AwsCredentialUsageStats;
DROP VIEW IF EXISTS AdminService_ApiKeyUsage;
DROP VIEW IF EXISTS AdminService_AwsCredentialUsage;
DROP VIEW IF EXISTS AdminService_ModelPrices;
DROP VIEW IF EXISTS sap_llm_gateway_admin_ApiKeyUsageStats;
DROP VIEW IF EXISTS sap_llm_gateway_admin_AwsCredentialUsageStats;

ALTER TABLE sap_llm_gateway_admin_ApiKeyUsage ADD COLUMN audioInputTokens INTEGER;
ALTER TABLE sap_llm_gateway_admin_ApiKeyUsage ADD COLUMN audioOutputTokens INTEGER;
ALTER TABLE sap_llm_gateway_admin_ApiKeyUsage ADD COLUMN audioInputCost DECIMAL(10, 6);
ALTER TABLE sap_llm_gateway_admin_ApiKeyUsage ADD COLUMN audioOutputCost DECIMAL(10, 6);

ALTER TABLE sap_llm_gateway_admin_AwsCredentialUsage ADD COLUMN audioInputTokens INTEGER;
ALTER TABLE sap_llm_gateway_admin_AwsCredentialUsage ADD COLUMN audioOutputTokens INTEGER;
ALTER TABLE sap_llm_gateway_admin_AwsCredentialUsage ADD COLUMN audioInputCost DECIMAL(10, 6);
ALTER TABLE sap_llm_gateway_admin_AwsCredentialUsage ADD COLUMN audioOutputCost DECIMAL(10, 6);

ALTER TABLE sap_llm_gateway_admin_ModelCosts ADD COLUMN audioInputCost DECIMAL(10, 6);
ALTER TABLE sap_llm_gateway_admin_ModelCosts ADD COLUMN audioOutputCost DECIMAL(10, 6);

ALTER TABLE AdminService_AwsCredentialUsage_drafts ADD COLUMN audioInputTokens INTEGER NULL;
ALTER TABLE AdminService_AwsCredentialUsage_drafts ADD COLUMN audioOutputTokens INTEGER NULL;
ALTER TABLE AdminService_AwsCredentialUsage_drafts ADD COLUMN audioInputCost DECIMAL(10, 6) NULL;
ALTER TABLE AdminService_AwsCredentialUsage_drafts ADD COLUMN audioOutputCost DECIMAL(10, 6) NULL;

CREATE VIEW sap_llm_gateway_admin_ApiKeyUsageStats AS SELECT
  ApiKeyUsage_0.apiKey_ID,
  count(*) AS totalRequests,
  coalesce(sum(ApiKeyUsage_0.inputTokens), 0) AS totalInputTokens,
  coalesce(sum(ApiKeyUsage_0.outputTokens), 0) AS totalOutputTokens,
  coalesce(sum(ApiKeyUsage_0.cacheCreationInputTokens), 0) AS totalCacheCreationInputTokens,
  coalesce(sum(ApiKeyUsage_0.cacheReadInputTokens), 0) AS totalCacheReadInputTokens,
  coalesce(sum(ApiKeyUsage_0.inputCost), 0.0) AS totalInputCost,
  coalesce(sum(ApiKeyUsage_0.outputCost), 0.0) AS totalOutputCost,
  coalesce(sum(ApiKeyUsage_0.cacheCreationInputCost), 0.0) AS totalCacheCreationInputCost,
  coalesce(sum(ApiKeyUsage_0.cacheReadInputCost), 0.0) AS totalCacheReadInputCost,
  coalesce(sum(ApiKeyUsage_0.totalCost), 0.0) AS totalCost,
  coalesce(sum(ApiKeyUsage_0.imageOutputCost), 0.0) AS totalImageOutputCost,
  coalesce(sum(ApiKeyUsage_0.audioInputCost), 0.0) AS totalAudioInputCost,
  coalesce(sum(ApiKeyUsage_0.audioOutputCost), 0.0) AS totalAudioOutputCost,
  coalesce(avg(ApiKeyUsage_0.responseTime), 0) AS avgResponseTime,
  coalesce(sum(ApiKeyUsage_0.imageInputTokens), 0) AS totalImageInputTokens,
  coalesce(sum(ApiKeyUsage_0.imageOutputTokens), 0) AS totalImageOutputTokens,
  coalesce(sum(ApiKeyUsage_0.audioInputTokens), 0) AS totalAudioInputTokens,
  coalesce(sum(ApiKeyUsage_0.audioOutputTokens), 0) AS totalAudioOutputTokens,
  coalesce(sum(ApiKeyUsage_0.genAiTokens), 0) AS totalGenAiTokens,
  coalesce(sum(ApiKeyUsage_0.capacityUnits), 0) AS totalCapacityUnits
FROM sap_llm_gateway_admin_ApiKeyUsage AS ApiKeyUsage_0
WHERE (ApiKeyUsage_0.provider IS NOT NULL) AND (ApiKeyUsage_0.validFrom < session_context( '$valid.to' ) AND ApiKeyUsage_0.validTo > session_context( '$valid.from' ))
GROUP BY ApiKeyUsage_0.apiKey_ID;

CREATE VIEW sap_llm_gateway_admin_AwsCredentialUsageStats AS SELECT
  AwsCredentialUsage_0.credential_ID,
  count(*) AS totalRequests,
  coalesce(sum(AwsCredentialUsage_0.inputTokens), 0) AS totalInputTokens,
  coalesce(sum(AwsCredentialUsage_0.outputTokens), 0) AS totalOutputTokens,
  coalesce(sum(AwsCredentialUsage_0.cacheCreationInputTokens), 0) AS totalCacheCreationInputTokens,
  coalesce(sum(AwsCredentialUsage_0.cacheReadInputTokens), 0) AS totalCacheReadInputTokens,
  coalesce(sum(AwsCredentialUsage_0.imageOutputTokens), 0) AS totalImageOutputTokens,
  coalesce(sum(AwsCredentialUsage_0.audioInputTokens), 0) AS totalAudioInputTokens,
  coalesce(sum(AwsCredentialUsage_0.audioOutputTokens), 0) AS totalAudioOutputTokens,
  coalesce(sum(AwsCredentialUsage_0.inputCost), 0.0) AS totalInputCost,
  coalesce(sum(AwsCredentialUsage_0.outputCost), 0.0) AS totalOutputCost,
  coalesce(sum(AwsCredentialUsage_0.cacheCreationInputCost), 0.0) AS totalCacheCreationInputCost,
  coalesce(sum(AwsCredentialUsage_0.cacheReadInputCost), 0.0) AS totalCacheReadInputCost,
  coalesce(sum(AwsCredentialUsage_0.totalCost), 0.0) AS totalCost,
  coalesce(sum(AwsCredentialUsage_0.imageOutputCost), 0.0) AS totalImageOutputCost,
  coalesce(sum(AwsCredentialUsage_0.audioInputCost), 0.0) AS totalAudioInputCost,
  coalesce(sum(AwsCredentialUsage_0.audioOutputCost), 0.0) AS totalAudioOutputCost,
  coalesce(avg(AwsCredentialUsage_0.responseTime), 0) AS avgResponseTime,
  count(CASE WHEN AwsCredentialUsage_0.statusCode >= 400 THEN 1 END) AS errorCount
FROM sap_llm_gateway_admin_AwsCredentialUsage AS AwsCredentialUsage_0
WHERE (AwsCredentialUsage_0.provider IS NOT NULL) AND (AwsCredentialUsage_0.validFrom < session_context( '$valid.to' ) AND AwsCredentialUsage_0.validTo > session_context( '$valid.from' ))
GROUP BY AwsCredentialUsage_0.credential_ID;

CREATE VIEW AdminService_ApiKeyUsage AS SELECT
  ApiKeyUsage_0.ID,
  ApiKeyUsage_0.validFrom,
  ApiKeyUsage_0.validTo,
  ApiKeyUsage_0.apiKey_ID,
  ApiKeyUsage_0.endpoint,
  ApiKeyUsage_0.method,
  ApiKeyUsage_0.statusCode,
  ApiKeyUsage_0.responseTime,
  ApiKeyUsage_0.requestSize,
  ApiKeyUsage_0.responseSize,
  ApiKeyUsage_0.email,
  ApiKeyUsage_0.keyName,
  ApiKeyUsage_0.provider,
  ApiKeyUsage_0.model,
  ApiKeyUsage_0.inputTokens,
  ApiKeyUsage_0.outputTokens,
  ApiKeyUsage_0.cacheCreationInputTokens,
  ApiKeyUsage_0.cacheReadInputTokens,
  ApiKeyUsage_0.totalTokens,
  ApiKeyUsage_0.usageEstimated,
  ApiKeyUsage_0.inputCost,
  ApiKeyUsage_0.outputCost,
  ApiKeyUsage_0.cacheCreationInputCost,
  ApiKeyUsage_0.cacheReadInputCost,
  ApiKeyUsage_0.totalCost,
  ApiKeyUsage_0.imageInputTokens,
  ApiKeyUsage_0.imageOutputTokens,
  ApiKeyUsage_0.imageOutputCost,
  ApiKeyUsage_0.audioInputTokens,
  ApiKeyUsage_0.audioOutputTokens,
  ApiKeyUsage_0.audioInputCost,
  ApiKeyUsage_0.audioOutputCost,
  ApiKeyUsage_0.genAiTokens,
  ApiKeyUsage_0.capacityUnits,
  ApiKeyUsage_0.sapCost,
  ApiKeyUsage_0.sapCostCurrency,
  ApiKeyUsage_0.userAgent,
  ApiKeyUsage_0.clientIP,
  ApiKeyUsage_0.requestId,
  ApiKeyUsage_0.sessionId,
  ApiKeyUsage_0.errorType,
  ApiKeyUsage_0.errorMessage,
  ApiKeyUsage_0.usageSignature
FROM sap_llm_gateway_admin_ApiKeyUsage AS ApiKeyUsage_0
WHERE (ApiKeyUsage_0.validFrom < session_context( '$valid.to' ) AND ApiKeyUsage_0.validTo > session_context( '$valid.from' ));

CREATE VIEW AdminService_AwsCredentialUsage AS SELECT
  AwsCredentialUsage_0.ID,
  AwsCredentialUsage_0.validFrom,
  AwsCredentialUsage_0.validTo,
  AwsCredentialUsage_0.credential_ID,
  AwsCredentialUsage_0.requestId,
  AwsCredentialUsage_0.method,
  AwsCredentialUsage_0.endpoint,
  AwsCredentialUsage_0.service,
  AwsCredentialUsage_0.operation,
  AwsCredentialUsage_0.statusCode,
  AwsCredentialUsage_0.responseTime,
  AwsCredentialUsage_0.requestSize,
  AwsCredentialUsage_0.responseSize,
  AwsCredentialUsage_0.awsRegion,
  AwsCredentialUsage_0.signatureVersion,
  AwsCredentialUsage_0.canonicalRequest,
  AwsCredentialUsage_0.userId,
  AwsCredentialUsage_0.credentialName,
  AwsCredentialUsage_0.modelId,
  AwsCredentialUsage_0.provider,
  AwsCredentialUsage_0.inputTokens,
  AwsCredentialUsage_0.outputTokens,
  AwsCredentialUsage_0.cacheCreationInputTokens,
  AwsCredentialUsage_0.cacheReadInputTokens,
  AwsCredentialUsage_0.usageEstimated,
  AwsCredentialUsage_0.userAgent,
  AwsCredentialUsage_0.clientIP,
  AwsCredentialUsage_0.inputCost,
  AwsCredentialUsage_0.outputCost,
  AwsCredentialUsage_0.cacheCreationInputCost,
  AwsCredentialUsage_0.cacheReadInputCost,
  AwsCredentialUsage_0.totalCost,
  AwsCredentialUsage_0.billingRegion,
  AwsCredentialUsage_0.imageInputTokens,
  AwsCredentialUsage_0.imageOutputTokens,
  AwsCredentialUsage_0.imageOutputCost,
  AwsCredentialUsage_0.audioInputTokens,
  AwsCredentialUsage_0.audioOutputTokens,
  AwsCredentialUsage_0.audioInputCost,
  AwsCredentialUsage_0.audioOutputCost,
  AwsCredentialUsage_0.genAiTokens,
  AwsCredentialUsage_0.capacityUnits,
  AwsCredentialUsage_0.sapCost,
  AwsCredentialUsage_0.sapCostCurrency,
  AwsCredentialUsage_0.errorCode,
  AwsCredentialUsage_0.errorMessage,
  AwsCredentialUsage_0.errorType,
  AwsCredentialUsage_0.usageSignature
FROM sap_llm_gateway_admin_AwsCredentialUsage AS AwsCredentialUsage_0
WHERE (AwsCredentialUsage_0.validFrom < session_context( '$valid.to' ) AND AwsCredentialUsage_0.validTo > session_context( '$valid.from' ));

CREATE VIEW AdminService_ApiKeyUsageStats AS SELECT
  ApiKeyUsageStats_0.apiKey_ID,
  ApiKeyUsageStats_0.totalRequests,
  ApiKeyUsageStats_0.totalInputTokens,
  ApiKeyUsageStats_0.totalOutputTokens,
  ApiKeyUsageStats_0.totalCacheCreationInputTokens,
  ApiKeyUsageStats_0.totalCacheReadInputTokens,
  ApiKeyUsageStats_0.totalInputCost,
  ApiKeyUsageStats_0.totalOutputCost,
  ApiKeyUsageStats_0.totalCacheCreationInputCost,
  ApiKeyUsageStats_0.totalCacheReadInputCost,
  ApiKeyUsageStats_0.totalCost,
  ApiKeyUsageStats_0.totalImageOutputCost,
  ApiKeyUsageStats_0.totalAudioInputCost,
  ApiKeyUsageStats_0.totalAudioOutputCost,
  ApiKeyUsageStats_0.avgResponseTime,
  ApiKeyUsageStats_0.totalImageInputTokens,
  ApiKeyUsageStats_0.totalImageOutputTokens,
  ApiKeyUsageStats_0.totalAudioInputTokens,
  ApiKeyUsageStats_0.totalAudioOutputTokens,
  ApiKeyUsageStats_0.totalGenAiTokens,
  ApiKeyUsageStats_0.totalCapacityUnits
FROM sap_llm_gateway_admin_ApiKeyUsageStats AS ApiKeyUsageStats_0;

CREATE VIEW AdminService_AwsCredentialUsageStats AS SELECT
  AwsCredentialUsageStats_0.credential_ID,
  AwsCredentialUsageStats_0.totalRequests,
  AwsCredentialUsageStats_0.totalInputTokens,
  AwsCredentialUsageStats_0.totalOutputTokens,
  AwsCredentialUsageStats_0.totalCacheCreationInputTokens,
  AwsCredentialUsageStats_0.totalCacheReadInputTokens,
  AwsCredentialUsageStats_0.totalImageOutputTokens,
  AwsCredentialUsageStats_0.totalAudioInputTokens,
  AwsCredentialUsageStats_0.totalAudioOutputTokens,
  AwsCredentialUsageStats_0.totalInputCost,
  AwsCredentialUsageStats_0.totalOutputCost,
  AwsCredentialUsageStats_0.totalCacheCreationInputCost,
  AwsCredentialUsageStats_0.totalCacheReadInputCost,
  AwsCredentialUsageStats_0.totalCost,
  AwsCredentialUsageStats_0.totalImageOutputCost,
  AwsCredentialUsageStats_0.totalAudioInputCost,
  AwsCredentialUsageStats_0.totalAudioOutputCost,
  AwsCredentialUsageStats_0.avgResponseTime,
  AwsCredentialUsageStats_0.errorCount
FROM sap_llm_gateway_admin_AwsCredentialUsageStats AS AwsCredentialUsageStats_0;

CREATE VIEW AdminService_ModelPrices AS SELECT
  ModelCosts_0.ID,
  ModelCosts_0.model,
  ModelCosts_0.displayName,
  ModelCosts_0.dateFrom,
  ModelCosts_0.dateTo,
  ModelCosts_0.inputCost,
  ModelCosts_0.outputCost,
  ModelCosts_0.cacheReadInputCost,
  ModelCosts_0.cacheCreationInputCost,
  ModelCosts_0.imageOutputCost,
  ModelCosts_0.audioInputCost,
  ModelCosts_0.audioOutputCost,
  ModelCosts_0.provider,
  ModelCosts_0.version,
  ModelCosts_0.source,
  ModelCosts_0.createdAt,
  ModelCosts_0.createdBy
FROM sap_llm_gateway_admin_ModelCosts AS ModelCosts_0;

COMMIT;
