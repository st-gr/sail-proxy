/**
 * Cost Recalculation Service
 *
 * Runs daily to correct usage records that were persisted with incorrect pricing.
 * Uses a single SQL UPDATE per table joining against ModelCosts for efficiency.
 *
 * Triggered by:
 * - modelCostService not loaded at persist time
 * - Connection pool exhaustion during batch flushes
 * - New models without ModelCosts entries at time of usage
 */

import { getDefaultLogger } from '../../../../libs/logger';
const logger = getDefaultLogger();

const cds = require('@sap/cds');

export class CostRecalculationService {
  private timer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private isProcessing = false;
  private readonly intervalMs = 24 * 60 * 60 * 1000; // 24 hours
  private readonly startupDelayMs = 5 * 60 * 1000;   // 5 minutes
  private readonly lookbackDays = 30;

  /**
   * Initialize the service — schedules first run after startup delay, then daily
   */
  async initialize(): Promise<void> {
    logger.info('CostRecalculation', 'Service initializing', {
      intervalHours: this.intervalMs / 3600000,
      startupDelayMinutes: this.startupDelayMs / 60000,
      lookbackDays: this.lookbackDays
    });

    this.startupTimer = setTimeout(() => {
      this.runRecalculation();
      this.timer = setInterval(() => this.runRecalculation(), this.intervalMs);
    }, this.startupDelayMs);
  }

  /**
   * Execute the recalculation — updates both ApiKeyUsage and AwsCredentialUsage
   */
  async runRecalculation(): Promise<{ apiKeyRecords: number; awsRecords: number }> {
    if (this.isProcessing) {
      logger.debug('CostRecalculation', 'Skipping — already processing');
      return { apiKeyRecords: 0, awsRecords: 0 };
    }

    this.isProcessing = true;

    try {
      const db = await cds.connect.to('db');
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.lookbackDays);
      const cutoffISO = cutoffDate.toISOString();

      const isPostgreSQL = db.options?.credentials?.kind === 'postgres' ||
        process.env.CDS_ENV === 'pg' ||
        process.env.NODE_CONFIG_ENV === 'pg';

      // Recalculate ApiKeyUsage
      const apiKeyResult = await db.run(
        this.buildUpdateSQL('sap_llm_gateway_admin_ApiKeyUsage', 'u.model = mc.model', isPostgreSQL),
        [cutoffISO]
      );

      // Recalculate AwsCredentialUsage (uses modelId column)
      const awsResult = await db.run(
        this.buildUpdateSQL('sap_llm_gateway_admin_AwsCredentialUsage', 'u.modelId = mc.model', isPostgreSQL),
        [cutoffISO]
      );

      const apiKeyRecords = apiKeyResult?.rowCount ?? apiKeyResult?.changes ?? 0;
      const awsRecords = awsResult?.rowCount ?? awsResult?.changes ?? 0;

      logger.info('CostRecalculation', 'Daily recalculation complete', {
        apiKeyRecords,
        awsRecords,
        lookbackDays: this.lookbackDays
      });

      return { apiKeyRecords, awsRecords };
    } catch (error: any) {
      logger.error('CostRecalculation', `Error during recalculation: ${error.message}`, error);
      return { apiKeyRecords: 0, awsRecords: 0 };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Build the UPDATE SQL for a usage table
   */
  private buildUpdateSQL(table: string, joinCondition: string, isPostgreSQL: boolean): string {
    if (isPostgreSQL) {
      return `
        UPDATE ${table} u
        SET
          inputCost = ROUND((u.inputTokens::numeric / 1000) * mc.inputCost::numeric, 6),
          outputCost = ROUND((u.outputTokens::numeric / 1000) * mc.outputCost::numeric, 6),
          cacheReadInputCost = ROUND((COALESCE(u.cacheReadInputTokens, 0)::numeric / 1000) * COALESCE(mc.cacheReadInputCost, mc.inputCost)::numeric, 6),
          cacheCreationInputCost = ROUND((COALESCE(u.cacheCreationInputTokens, 0)::numeric / 1000) * COALESCE(mc.cacheCreationInputCost, mc.inputCost)::numeric, 6),
          totalCost = ROUND(
            (u.inputTokens::numeric / 1000) * mc.inputCost::numeric +
            (u.outputTokens::numeric / 1000) * mc.outputCost::numeric +
            (COALESCE(u.cacheReadInputTokens, 0)::numeric / 1000) * COALESCE(mc.cacheReadInputCost, mc.inputCost)::numeric +
            (COALESCE(u.cacheCreationInputTokens, 0)::numeric / 1000) * COALESCE(mc.cacheCreationInputCost, mc.inputCost)::numeric
          , 6)
        FROM sap_llm_gateway_admin_ModelCosts mc
        WHERE ${joinCondition}
          AND u.validFrom >= $1
          AND mc.dateFrom <= u.validFrom AND mc.dateTo >= u.validFrom
          AND (u.inputTokens > 1 OR COALESCE(u.cacheReadInputTokens, 0) > 0 OR COALESCE(u.cacheCreationInputTokens, 0) > 0)
          AND (
            ABS(
              (u.inputCost::numeric / GREATEST(u.inputTokens, 1) * 1000) - mc.inputCost::numeric
            ) / GREATEST(mc.inputCost::numeric, 0.000001) > 0.05
            OR (
              COALESCE(u.cacheReadInputTokens, 0) > 0 AND (
                u.cacheReadInputCost IS NULL
                OR ABS(
                  (u.cacheReadInputCost::numeric / GREATEST(COALESCE(u.cacheReadInputTokens, 0), 1) * 1000) - COALESCE(mc.cacheReadInputCost, mc.inputCost)::numeric
                ) / GREATEST(COALESCE(mc.cacheReadInputCost, mc.inputCost)::numeric, 0.000001) > 0.05
              )
            )
            OR (
              COALESCE(u.cacheCreationInputTokens, 0) > 0 AND (
                u.cacheCreationInputCost IS NULL
                OR ABS(
                  (u.cacheCreationInputCost::numeric / GREATEST(COALESCE(u.cacheCreationInputTokens, 0), 1) * 1000) - COALESCE(mc.cacheCreationInputCost, mc.inputCost)::numeric
                ) / GREATEST(COALESCE(mc.cacheCreationInputCost, mc.inputCost)::numeric, 0.000001) > 0.05
              )
            )
          )
      `;
    }

    // SQLite variant
    return `
      UPDATE ${table}
      SET
        inputCost = ROUND(CAST(inputTokens AS REAL) / 1000 * (
          SELECT mc.inputCost FROM sap_llm_gateway_admin_ModelCosts mc
          WHERE ${joinCondition.replace(/u\./g, `${table}.`).replace('mc.model', 'mc.model')}
            AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom
          LIMIT 1
        ), 6),
        outputCost = ROUND(CAST(outputTokens AS REAL) / 1000 * (
          SELECT mc.outputCost FROM sap_llm_gateway_admin_ModelCosts mc
          WHERE ${joinCondition.replace(/u\./g, `${table}.`)}
            AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom
          LIMIT 1
        ), 6),
        cacheReadInputCost = ROUND(CAST(COALESCE(cacheReadInputTokens, 0) AS REAL) / 1000 * (
          SELECT COALESCE(mc.cacheReadInputCost, mc.inputCost) FROM sap_llm_gateway_admin_ModelCosts mc
          WHERE ${joinCondition.replace(/u\./g, `${table}.`)}
            AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom
          LIMIT 1
        ), 6),
        cacheCreationInputCost = ROUND(CAST(COALESCE(cacheCreationInputTokens, 0) AS REAL) / 1000 * (
          SELECT COALESCE(mc.cacheCreationInputCost, mc.inputCost) FROM sap_llm_gateway_admin_ModelCosts mc
          WHERE ${joinCondition.replace(/u\./g, `${table}.`)}
            AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom
          LIMIT 1
        ), 6),
        totalCost = ROUND(
          CAST(inputTokens AS REAL) / 1000 * (
            SELECT mc.inputCost FROM sap_llm_gateway_admin_ModelCosts mc
            WHERE ${joinCondition.replace(/u\./g, `${table}.`)}
              AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom
            LIMIT 1
          ) +
          CAST(outputTokens AS REAL) / 1000 * (
            SELECT mc.outputCost FROM sap_llm_gateway_admin_ModelCosts mc
            WHERE ${joinCondition.replace(/u\./g, `${table}.`)}
              AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom
            LIMIT 1
          ) +
          CAST(COALESCE(cacheReadInputTokens, 0) AS REAL) / 1000 * (
            SELECT COALESCE(mc.cacheReadInputCost, mc.inputCost) FROM sap_llm_gateway_admin_ModelCosts mc
            WHERE ${joinCondition.replace(/u\./g, `${table}.`)}
              AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom
            LIMIT 1
          ) +
          CAST(COALESCE(cacheCreationInputTokens, 0) AS REAL) / 1000 * (
            SELECT COALESCE(mc.cacheCreationInputCost, mc.inputCost) FROM sap_llm_gateway_admin_ModelCosts mc
            WHERE ${joinCondition.replace(/u\./g, `${table}.`)}
              AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom
            LIMIT 1
          ), 6)
      WHERE validFrom >= ?
        AND (inputTokens > 1 OR COALESCE(cacheReadInputTokens, 0) > 0 OR COALESCE(cacheCreationInputTokens, 0) > 0)
        AND EXISTS (
          SELECT 1 FROM sap_llm_gateway_admin_ModelCosts mc
          WHERE ${joinCondition.replace(/u\./g, `${table}.`)}
            AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom
        )
    `;
  }

  /**
   * Shutdown — clear timers
   */
  async shutdown(): Promise<void> {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export const costRecalculationService = new CostRecalculationService();
export default costRecalculationService;
