/**
 * Retention of the gateway log: by age, by count, in batches that work on SQLite and PostgreSQL, and
 * whether or not storing is switched on. Payload traces go after `payload_capture.retention_hours`,
 * raw traces after `payload_capture.raw.retention_hours`. TRACE_TEST_POSTGRES runs it against a
 * throwaway PostgreSQL (trace-test-db.ts).
 */
import { v4 as uuidv4 } from 'uuid';
import { connectTraceTestDb } from './trace-test-db';

const cds = require('@sap/cds');

import {
  sweepGatewayLog, activeRetentionSettings, startGatewayLogRetention, sweepPayloadTraces, sweepRawTraces, activePayloadCaptureRetention
} from '../../../src/services/gatewayLogRetention';

const ENTITY = 'sap.llm.gateway.admin.GatewayLogEntries';
const NOW = new Date('2026-11-11T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const insert = (ages: number[]) => cds.db.run(cds.ql.INSERT.into(ENTITY).entries(
  ages.map((h, i) => ({ ID: `${i}-0-0`, loggedAt: hoursAgo(h), seq: i, level: 'INFO', component: 'c', message: `m${i}` }))));
const left = async () => (await cds.db.run(cds.ql.SELECT.from(ENTITY).columns('ID').orderBy('loggedAt')) as any[]).map((r) => r.ID);

describe('gateway log retention', () => {
  beforeAll(async () => { await connectTraceTestDb(); });
  beforeEach(async () => { await cds.db.run(cds.ql.DELETE.from(ENTITY)); });

  it('deletes rows older than the retention time', async () => {
    await insert([60, 49, 47, 1]);
    const r = await sweepGatewayLog(NOW, { retentionHours: 48, maxEntries: 1000 });
    expect(r).toEqual({ byAge: 2, byCount: 0 });
    expect(await left()).toEqual(['2-0-0', '3-0-0']);
  });

  it('deletes the oldest rows beyond maxEntries', async () => {
    await insert([8, 7, 6, 5, 4, 3, 2, 1]);
    const r = await sweepGatewayLog(NOW, { retentionHours: 48, maxEntries: 5 });
    expect(r).toEqual({ byAge: 0, byCount: 3 });
    expect(await left()).toEqual(['3-0-0', '4-0-0', '5-0-0', '6-0-0', '7-0-0']);
  });

  it('deletes nothing by age with retentionHours 0, nothing by count with maxEntries 0', async () => {
    await insert([5000, 4000, 1]);
    expect(await sweepGatewayLog(NOW, { retentionHours: 0, maxEntries: 0 })).toEqual({ byAge: 0, byCount: 0 });
    expect(await left()).toHaveLength(3);
  });

  it('deletes in batches until done (more rows than one batch)', async () => {
    await insert(Array.from({ length: 12 }, (_, i) => 100 + i));
    const r = await sweepGatewayLog(NOW, { retentionHours: 48, maxEntries: 0 }, 5);
    expect(r.byAge).toBe(12);
    expect(await left()).toHaveLength(0);
    await insert(Array.from({ length: 12 }, (_, i) => 1 + i / 100));
    expect((await sweepGatewayLog(NOW, { retentionHours: 48, maxEntries: 4 }, 5)).byCount).toBe(8);
    expect(await left()).toHaveLength(4);
  });

  it('reads the settings of the ACTIVE configuration, enabled or not', async () => {
    await cds.db.run(cds.ql.DELETE.from('sap.llm.gateway.admin.ApiConfigurations'));
    expect(await activeRetentionSettings()).toMatchObject({ retentionHours: 48, maxEntries: 2000000 });
    const configData = (block: any) => JSON.stringify({ api_config: { observability: { gateway_log: block } } });
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.ApiConfigurations').entries([
      { ID: uuidv4(), name: 'old', version: '1.0.0', isActive: false, configData: configData({ retention_hours: 1 }) },
      { ID: uuidv4(), name: 'now', version: '2.0.0', isActive: true, configData: configData({ enabled: false, retention_hours: 6, max_entries: 10 }) }
    ]));
    expect(await activeRetentionSettings()).toEqual({ enabled: false, retentionHours: 6, maxEntries: 10, minLevel: 'INFO' });
  });

  it('does not start a timer in a test process', () => {
    expect(startGatewayLogRetention()).toBeNull();
  });

  it('starts an unref-ed timer when asked to, and stops it', async () => {
    const handle = startGatewayLogRetention({ allowInTest: true, intervalMs: 600_000, firstRunMs: 600_000 });
    expect(handle).not.toBeNull();
    expect((handle as any).timers.every((t: any) => t.hasRef() === false)).toBe(true);
    handle!.stop();
  });

  describe('payload traces and raw traces', () => {
    const TRACES = 'sap.llm.gateway.admin.PayloadTraces';
    const RAW = 'sap.llm.gateway.admin.RawTraces';
    const CONFIGS = 'sap.llm.gateway.admin.ApiConfigurations';
    const insertTraces = (ages: number[]) => cds.db.run(cds.ql.INSERT.into(TRACES).entries(
      ages.map((h, i) => ({ ID: `t-${i}`, requestId: `req-${i}`, capturedAt: hoursAgo(h), model: 'gpt-5', masked: true }))));
    const insertRaw = (ages: number[]) => cds.db.run(cds.ql.INSERT.into(RAW).entries(
      ages.map((h, i) => ({ ID: `r-${i}`, requestId: `req-${i}`, sessionId: 's-1', capturedAt: hoursAgo(h), stageIndex: '[]', stages: '{}' }))));
    const ids = async (entity: string) => (await cds.db.run(cds.ql.SELECT.from(entity).columns('ID').orderBy('ID')) as any[]).map((r) => r.ID);
    const activate = async (block: any) => {
      await cds.db.run(cds.ql.DELETE.from(CONFIGS));
      if (block !== undefined) await cds.db.run(cds.ql.INSERT.into(CONFIGS).entries([
        { ID: uuidv4(), name: 'now', version: '3.0.0', isActive: true, configData: JSON.stringify({ api_config: { observability: { payload_capture: block } } }) }]));
    };

    beforeEach(async () => {
      await cds.db.run(cds.ql.DELETE.from(TRACES));
      await cds.db.run(cds.ql.DELETE.from(RAW));
    });

    it('deletes light traces older than their retention time and raw traces older than theirs', async () => {
      await insertTraces([60, 47, 1]);
      await insertRaw([30, 23, 1]);
      expect(await sweepPayloadTraces(NOW, 48)).toBe(1);
      expect(await sweepRawTraces(NOW, 24)).toBe(1);
      expect(await ids(TRACES)).toEqual(['t-1', 't-2']);
      expect(await ids(RAW)).toEqual(['r-1', 'r-2']);
    });

    it('deletes none with a retention time of 0', async () => {
      await insertTraces([5000, 1]);
      await insertRaw([5000, 1]);
      expect(await sweepPayloadTraces(NOW, 0)).toBe(0);
      expect(await sweepRawTraces(NOW, 0)).toBe(0);
      expect((await ids(TRACES)).length + (await ids(RAW)).length).toBe(4);
    });

    it('deletes in batches until done', async () => {
      await insertTraces(Array.from({ length: 12 }, (_, i) => 100 + i));
      await insertRaw(Array.from({ length: 7 }, (_, i) => 100 + i));
      expect(await sweepPayloadTraces(NOW, 48, 5)).toBe(12);
      expect(await sweepRawTraces(NOW, 24, 5)).toBe(7);
      expect((await ids(TRACES)).length + (await ids(RAW)).length).toBe(0);
    });

    it('reads both retention times of the ACTIVE configuration, with the defaults 48 and 24 hours', async () => {
      await activate(undefined);
      expect(await activePayloadCaptureRetention()).toEqual({ retentionHours: 48, rawRetentionHours: 24 });
      await activate({ retention_hours: 6, raw: { retention_hours: 0 } });
      expect(await activePayloadCaptureRetention()).toEqual({ retentionHours: 6, rawRetentionHours: 0 });
    });

    it('the retention run sweeps the traces by the active configuration', async () => {
      await activate({ retention_hours: 2, raw: { retention_hours: 1 } });
      const now = Date.now();
      const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
      await cds.db.run(cds.ql.INSERT.into(TRACES).entries([
        { ID: 't-old', requestId: 'a', capturedAt: ago(3), model: 'm', masked: true }, { ID: 't-new', requestId: 'b', capturedAt: ago(1), model: 'm', masked: true }]));
      await cds.db.run(cds.ql.INSERT.into(RAW).entries([
        { ID: 'r-old', requestId: 'a', sessionId: 's', capturedAt: ago(2), stageIndex: '[]', stages: '{}' }, { ID: 'r-new', requestId: 'b', sessionId: 's', capturedAt: ago(0.5), stageIndex: '[]', stages: '{}' }]));
      const handle = startGatewayLogRetention({ allowInTest: true, firstRunMs: 1, intervalMs: 600_000 });
      try {
        for (let i = 0; i < 100 && ((await ids(TRACES)).length > 1 || (await ids(RAW)).length > 1); i++) await new Promise((r) => setTimeout(r, 20));
      } finally { handle!.stop(); }
      expect(await ids(TRACES)).toEqual(['t-new']);
      expect(await ids(RAW)).toEqual(['r-new']);
      await activate(undefined);
    });
  });
});
