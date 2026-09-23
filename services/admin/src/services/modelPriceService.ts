/**
 * Admin-maintained model prices (spec sections 2 and 4). ModelCosts is temporal: a change closes
 * the current row (dateTo = now) and inserts a new open row (dateTo = 9999-12-31). Rows carry
 * source = 'sap' (from the gateway list) or 'manual' (set here). modelCostService.
 * updatePricingDatabase never closes a current manual row; revertToSapPrice does.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export const PRICE_SOURCE_SAP = 'sap';
export const PRICE_SOURCE_MANUAL = 'manual';
const MODEL_COSTS = 'sap.llm.gateway.admin.ModelCosts';
const LIBRARY = 'sap.llm.gateway.admin.LibraryModels';
export const OPEN_ENDED = new Date('9999-12-31T00:00:00.000Z');

export interface ManualPriceInput {
  modelId: string;
  inputCost: string | number;
  outputCost: string | number;
  cacheReadInputCost?: string | number | null;
  cacheCreationInputCost?: string | number | null;
  imageOutputCost?: string | number | null;
  audioInputCost?: string | number | null;
  audioOutputCost?: string | number | null;
  actor: string;
}

/**
 * The Cost tab's headline: SAP's page shows the per-1K cost × 1000 × cuFactor, i.e. capacity units
 * per 1M tokens (0.00079 → 1.50404 at 1.90385, captured 2026-09-05). Five decimals like SAP.
 */
export function capacityUnitsPerMillion(costPer1k: string | number | null | undefined, cuFactor: number): string | null {
  if (costPer1k === null || costPer1k === undefined || costPer1k === '') return null;
  const n = Number(costPer1k);
  if (!Number.isFinite(n) || !Number.isFinite(cuFactor)) return null;
  return (n * 1000 * cuFactor).toFixed(5);
}

function assertPrice(name: string, value: string | number | null | undefined, required: boolean): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return String(value);
}

async function currentRow(db: any, modelId: string): Promise<any | null> {
  const { SELECT } = cds.ql;
  const rows = await db.run(SELECT.from(MODEL_COSTS).where({ model: modelId, dateTo: OPEN_ENDED }));
  return rows[0] ?? null;
}

async function closeAndInsert(db: any, current: any | null, entry: Record<string, any>, now: Date): Promise<any> {
  const { UPDATE, INSERT } = cds.ql;
  if (current) {
    await db.run(UPDATE(MODEL_COSTS).set({ dateTo: now }).where({ ID: current.ID }));
  }
  const row = { ID: uuidv4(), dateFrom: now, dateTo: OPEN_ENDED, createdAt: now, ...entry };
  await db.run(INSERT.into(MODEL_COSTS).entries([row]));
  return row;
}

export async function setManualPrice(db: any, input: ManualPriceInput, now: Date = new Date()): Promise<any> {
  const inputCost = assertPrice('inputCost', input.inputCost, true)!;
  const outputCost = assertPrice('outputCost', input.outputCost, true)!;
  const cacheReadInputCost = assertPrice('cacheReadInputCost', input.cacheReadInputCost, false);
  const cacheCreationInputCost = assertPrice('cacheCreationInputCost', input.cacheCreationInputCost, false);
  const imageOutputCost = assertPrice('imageOutputCost', input.imageOutputCost, false);
  const audioInputCost = assertPrice('audioInputCost', input.audioInputCost, false);
  const audioOutputCost = assertPrice('audioOutputCost', input.audioOutputCost, false);
  const current = await currentRow(db, input.modelId);
  const row = await closeAndInsert(db, current, {
    model: input.modelId,
    displayName: current?.displayName ?? null,
    provider: current?.provider ?? null,
    version: current?.version ?? null,
    inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, imageOutputCost, audioInputCost, audioOutputCost,
    source: PRICE_SOURCE_MANUAL,
    createdBy: input.actor
  }, now);
  logger.info('ModelPriceService', `Manual price set for ${input.modelId} by ${input.actor}`);
  return row;
}

export async function revertToSapPrice(db: any, modelId: string, actor: string, now: Date = new Date()): Promise<any> {
  const { SELECT } = cds.ql;
  const current = await currentRow(db, modelId);
  if (current && current.source !== PRICE_SOURCE_MANUAL) {
    return current;
  }
  const snap = (await db.run(SELECT.from(LIBRARY).where({ modelId })))[0];
  const isMissing = (v: any) => v === null || v === undefined || v === '';
  if (!snap || isMissing(snap.sapInputCost) || isMissing(snap.sapOutputCost)) {
    throw new Error(`no SAP price recorded for ${modelId}`);
  }
  const row = await closeAndInsert(db, current, {
    model: modelId,
    displayName: snap.displayName ?? current?.displayName ?? null,
    provider: snap.provider ?? current?.provider ?? null,
    version: snap.latestVersion ?? current?.version ?? null,
    inputCost: String(snap.sapInputCost),
    outputCost: String(snap.sapOutputCost),
    cacheReadInputCost: snap.sapCacheReadCost !== null && snap.sapCacheReadCost !== undefined ? String(snap.sapCacheReadCost) : null,
    cacheCreationInputCost: snap.sapCacheCreationCost !== null && snap.sapCacheCreationCost !== undefined ? String(snap.sapCacheCreationCost) : null,
    imageOutputCost: null,
    audioInputCost: null,
    audioOutputCost: null,
    source: PRICE_SOURCE_SAP,
    createdBy: actor
  }, now);
  logger.info('ModelPriceService', `Price for ${modelId} reverted to SAP by ${actor}`);
  return row;
}
