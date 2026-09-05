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
import { getCacheBillingFactors, isProductive, cuFactor as getConfiguredCuFactor } from './sapCapacityService';
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

      // Read the SAP-native cache factors and usage type once per run, not per row — the SQL
      // below binds them as literal values into the generated statement.
      const { read: fRead, write: fWrite } = getCacheBillingFactors('anthropic');
      const productiveType = isProductive() ? 'productive' : 'non-productive';

      // Recalculate ApiKeyUsage
      const apiKeyResult = await db.run(
        this.buildUpdateSQL('sap_llm_gateway_admin_ApiKeyUsage', 'u.model = mc.model', isPostgreSQL, fRead, fWrite, productiveType),
        [cutoffISO]
      );

      // Recalculate AwsCredentialUsage (uses modelId column)
      const awsResult = await db.run(
        this.buildUpdateSQL('sap_llm_gateway_admin_AwsCredentialUsage', 'u.modelId = mc.model', isPostgreSQL, fRead, fWrite, productiveType),
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
   * Build the UPDATE SQL for a usage table.
   *
   * Row eligibility (which rows get touched at all) is governed entirely by the pre-existing
   * ModelCosts join/drift gate below — unchanged by the SAP-native addition. The SAP-native
   * columns (genAiTokens/capacityUnits/sapCost/sapCostCurrency) ride the same ModelCosts row:
   * genAiTokens/capacityUnits fill in for every selected row (the GenAI rates come from
   * ModelCosts too, /1000, with the constant CU factor), and sapCost/sapCostCurrency also
   * require a matching SapCapacityUnitPrice row for the row's usage type and validFrom;
   * otherwise the row's prior sapCost is left untouched (never forced to NULL). A consequence
   * of riding on the unchanged ModelCosts drift gate: a row whose dollar pricing is already
   * within the 5% tolerance is not selected by this UPDATE at all, so its SAP-native fields are
   * not backfilled either — accepted rather than adding a second, independent row-selection gate.
   *
   * Both DB variants look up the SapCapacityUnitPrice via correlated scalar
   * subqueries in the SET list (never a JOIN in the PostgreSQL FROM clause): PostgreSQL forbids
   * referencing the UPDATE target alias ("u") from a JOIN...ON in UPDATE...FROM ("invalid
   * reference to FROM-clause entry for table u"), and a plain comma-join there would turn into a
   * row-dropping INNER join, regressing the dollar recompute for any model lacking a SAP rate.
   * Scalar subqueries in the SET clause may reference "u" freely (same as the existing
   * ModelCosts-driven drift expressions below already do) and keep the rate/price lookup fully
   * independent of the mc join.
   */
  private buildUpdateSQL(
    table: string,
    joinCondition: string,
    isPostgreSQL: boolean,
    fRead = 1,
    fWrite = 1,
    productiveType = 'non-productive'
  ): string {
    if (isPostgreSQL) {
      const sapPriceWhere = `p.usageType = '${productiveType}' AND p.dateFrom <= u.validFrom AND p.dateTo >= u.validFrom`;

      // GenAI conversion rates come from the already-joined ModelCosts row (mc) - the model
      // discovery data the gateway syncs from /v2 (SAP Note 3437766: "GenAI tokens per 1,000
      // model tokens"), so divide by 1000 for the per-model-token rate. The CU factor is the
      // maintained constant. No hand-kept SapCapacityRates table is involved.
      const inputRate = `(mc.inputCost::numeric / 1000)`;
      const outputRate = `COALESCE(mc.outputCost::numeric / 1000, ${inputRate})`;
      const cacheReadRate = `COALESCE(mc.cacheReadInputCost::numeric / 1000, ${inputRate})`;
      const cacheWriteRate = `COALESCE(mc.cacheCreationInputCost::numeric / 1000, ${inputRate})`;
      const imageRate = inputRate; // image GenAI rate is not published per model; fall back to input
      const cuFactor = `${getConfiguredCuFactor()}::numeric`;
      const pricePerCu = `(SELECT p.pricePerCu::numeric FROM sap_llm_gateway_admin_SapCapacityUnitPrice p WHERE ${sapPriceWhere} ORDER BY p.dateFrom DESC LIMIT 1)`;
      const currency = `(SELECT p.currency FROM sap_llm_gateway_admin_SapCapacityUnitPrice p WHERE ${sapPriceWhere} ORDER BY p.dateFrom DESC LIMIT 1)`;

      const genAiTokensExpr = `(
              (u.inputTokens::numeric) * ${inputRate}
              + (u.outputTokens::numeric) * ${outputRate}
              + (COALESCE(u.cacheReadInputTokens, 0)::numeric * ${fRead}) * ${cacheReadRate}
              + (COALESCE(u.cacheCreationInputTokens, 0)::numeric * ${fWrite}) * ${cacheWriteRate}
              + COALESCE(u.imageInputTokens, 0)::numeric * ${imageRate}
            )`;

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
          , 6),
          genAiTokens = CASE WHEN ${cuFactor} IS NOT NULL
            THEN ROUND(${genAiTokensExpr}, 4)
            ELSE u.genAiTokens END,
          capacityUnits = CASE WHEN ${cuFactor} IS NOT NULL
            THEN ROUND(${genAiTokensExpr} * ${cuFactor}, 6)
            ELSE u.capacityUnits END,
          sapCost = CASE WHEN ${cuFactor} IS NOT NULL AND ${pricePerCu} IS NOT NULL
            THEN ROUND(${genAiTokensExpr} * ${cuFactor} * ${pricePerCu}, 6)
            ELSE u.sapCost END,
          sapCostCurrency = CASE WHEN ${cuFactor} IS NOT NULL AND ${pricePerCu} IS NOT NULL
            THEN COALESCE(${currency}, u.sapCostCurrency)
            ELSE u.sapCostCurrency END
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

    // SQLite variant — no UPDATE...FROM support, so every joined value is its own correlated
    // scalar subquery (mirroring the existing per-column ModelCosts pattern above).
    const sapPriceWhere = `p.usageType = '${productiveType}' AND p.dateFrom <= ${table}.validFrom AND p.dateTo >= ${table}.validFrom`;
    const mcWhere = `${joinCondition.replace(/u\./g, `${table}.`)} AND mc.dateFrom <= ${table}.validFrom AND mc.dateTo >= ${table}.validFrom`;
    // GenAI rates from the ModelCosts /v2 discovery data (per 1,000 model tokens), divided
    // by 1000 for the per-model-token rate; the CU factor is the maintained constant.
    const mcRate = (col: string) =>
      `(SELECT mc.${col} / 1000.0 FROM sap_llm_gateway_admin_ModelCosts mc WHERE ${mcWhere} LIMIT 1)`;
    const priceField = (col: string) =>
      `(SELECT p.${col} FROM sap_llm_gateway_admin_SapCapacityUnitPrice p WHERE ${sapPriceWhere} LIMIT 1)`;

    const inputRate = mcRate('inputCost');
    const outputRate = `COALESCE(${mcRate('outputCost')}, ${inputRate})`;
    const cacheReadRate = `COALESCE(${mcRate('cacheReadInputCost')}, ${inputRate})`;
    const cacheWriteRate = `COALESCE(${mcRate('cacheCreationInputCost')}, ${inputRate})`;
    const imageRate = inputRate; // image GenAI rate not published per model; fall back to input
    const cuFactor = `${getConfiguredCuFactor()}`;
    const pricePerCu = priceField('pricePerCu');
    const currency = priceField('currency');

    const genAiTokensExpr = `(
          CAST(${table}.inputTokens AS REAL) * ${inputRate}
          + CAST(${table}.outputTokens AS REAL) * ${outputRate}
          + (CAST(COALESCE(${table}.cacheReadInputTokens, 0) AS REAL) * ${fRead}) * ${cacheReadRate}
          + (CAST(COALESCE(${table}.cacheCreationInputTokens, 0) AS REAL) * ${fWrite}) * ${cacheWriteRate}
          + CAST(COALESCE(${table}.imageInputTokens, 0) AS REAL) * ${imageRate}
        )`;

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
          ), 6),
        genAiTokens = CASE WHEN ${cuFactor} IS NOT NULL
          THEN ROUND(${genAiTokensExpr}, 4)
          ELSE ${table}.genAiTokens END,
        capacityUnits = CASE WHEN ${cuFactor} IS NOT NULL
          THEN ROUND(${genAiTokensExpr} * ${cuFactor}, 6)
          ELSE ${table}.capacityUnits END,
        sapCost = CASE WHEN ${cuFactor} IS NOT NULL AND ${pricePerCu} IS NOT NULL
          THEN ROUND(${genAiTokensExpr} * ${cuFactor} * ${pricePerCu}, 6)
          ELSE ${table}.sapCost END,
        sapCostCurrency = CASE WHEN ${cuFactor} IS NOT NULL AND ${pricePerCu} IS NOT NULL
          THEN COALESCE(${currency}, ${table}.sapCostCurrency)
          ELSE ${table}.sapCostCurrency END
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
