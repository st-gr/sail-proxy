import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { RELAY_HIGH_WATER_BYTES, RELAY_LOW_WATER_BYTES, relay, RelayHandle, RelayHooks } from '../../src/realtime/relay';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

type Closed = { code: number; reason: string };
const closed = (ws: WebSocket) => new Promise<Closed>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));
const nextMessage = (ws: WebSocket) => new Promise<{ data: Buffer; isBinary: boolean }>((r) => ws.once('message', (data, isBinary) => r({ data: data as Buffer, isBinary })));
const opened = (ws: WebSocket) => new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
const waitFor = async (pred: () => boolean, ms = 10000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** 1 MiB frames, enough of them to push a stalled destination past RELAY_HIGH_WATER_BYTES. */
const FLOOD_FRAME_BYTES = 1024 * 1024;
const FLOOD_FRAMES = 12;

let upstreamSrv: WebSocketServer;
let gatewaySrv: WebSocketServer;
let upstreamSockets: WebSocket[];
let handles: RelayHandle[];
let hooks: RelayHooks;

beforeEach(async () => {
  upstreamSockets = []; handles = []; hooks = {};
  upstreamSrv = new WebSocketServer({ port: 0 });
  upstreamSrv.on('connection', (s) => {
    upstreamSockets.push(s);
    s.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === 'kill') { s.terminate(); return; }
      if (!isBinary && data.toString() === 'bye') { s.close(4001, 'upstream says bye'); return; }
      if (!isBinary && data.toString() === 'flood') {
        for (let i = 0; i < FLOOD_FRAMES; i++) {
          const frame = Buffer.alloc(FLOOD_FRAME_BYTES, i % 256);
          frame.writeUInt32BE(i, 0); // sequence marker, to prove nothing was dropped or reordered
          s.send(frame, { binary: true });
        }
        return;
      }
      s.send(Buffer.concat([Buffer.from('echo:'), data as Buffer]), { binary: isBinary });
    });
  });
  await new Promise<void>((r) => upstreamSrv.once('listening', r));
  const upstreamUrl = `ws://127.0.0.1:${(upstreamSrv.address() as AddressInfo).port}`;
  gatewaySrv = new WebSocketServer({ port: 0 });
  gatewaySrv.on('connection', (client) => {
    const upstream = new WebSocket(upstreamUrl);
    upstream.once('open', () => { handles.push(relay(client, upstream, hooks)); client.send('ready'); });
  });
  await new Promise<void>((r) => gatewaySrv.once('listening', r));
});
afterEach(async () => {
  for (const s of gatewaySrv.clients) s.terminate();
  await new Promise<void>((r) => gatewaySrv.close(() => r()));
  await new Promise<void>((r) => upstreamSrv.close(() => r()));
});

async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${(gatewaySrv.address() as AddressInfo).port}`);
  await opened(ws);
  expect((await nextMessage(ws)).data.toString()).toBe('ready');
  return ws;
}

describe('relay', () => {
  it('forwards text frames both ways unchanged', async () => {
    const ws = await connect();
    ws.send('hello');
    const m = await nextMessage(ws);
    expect(m.isBinary).toBe(false);
    expect(m.data.toString()).toBe('echo:hello');
    ws.terminate();
  });
  it('forwards binary frames byte-identical with the binary flag kept', async () => {
    const ws = await connect();
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0]);
    ws.send(bytes, { binary: true });
    const m = await nextMessage(ws);
    expect(m.isBinary).toBe(true);
    expect(m.data).toEqual(Buffer.concat([Buffer.from('echo:'), bytes]));
    ws.terminate();
  });
  it('calls onUpstreamFrame after each upstream frame with the raw data and binary flag', async () => {
    const seen: Array<{ text: string; isBinary: boolean }> = [];
    hooks.onUpstreamFrame = (data, isBinary) => seen.push({ text: Buffer.from(data as Buffer).toString(), isBinary });
    const ws = await connect();
    ws.send('one');
    await nextMessage(ws);
    ws.send(Buffer.from('two'), { binary: true });
    await nextMessage(ws);
    expect(seen).toEqual([{ text: 'echo:one', isBinary: false }, { text: 'echo:two', isBinary: true }]);
    ws.terminate();
  });
  it('calls onClientFrame with the frame before forwarding it upstream; a throwing hook neither blocks the forward nor propagates', async () => {
    const seen: Array<{ text: string; isBinary: boolean }> = [];
    hooks.onClientFrame = (data, isBinary) => {
      seen.push({ text: Buffer.from(data as Buffer).toString(), isBinary });
      throw new Error('boom');
    };
    const ws = await connect();
    ws.send('one');
    const m = await nextMessage(ws);
    expect(m.data.toString()).toBe('echo:one'); // forwarded despite the hook throwing
    expect(seen).toEqual([{ text: 'one', isBinary: false }]);
    ws.terminate();
  });
  it('a client close closes the upstream with 1000', async () => {
    const ws = await connect();
    const upstreamClosed = closed(upstreamSockets[0]);
    ws.close(4000, 'client leaving');
    expect(await upstreamClosed).toEqual({ code: 1000, reason: '' });
  });
  it('an upstream close is propagated to the client with the same code and reason', async () => {
    const ws = await connect();
    const clientClosed = closed(ws);
    ws.send('bye');
    expect(await clientClosed).toEqual({ code: 4001, reason: 'upstream says bye' });
  });
  it('an abnormal upstream closure reaches the client as 1011 upstream_error', async () => {
    const ws = await connect();
    const clientClosed = closed(ws);
    ws.send('kill');
    expect(await clientClosed).toEqual({ code: 1011, reason: 'upstream_error' });
  });
  it('pauses the upstream when the client stops reading and resumes it once the buffer drains, every frame intact and in order', async () => {
    expect(RELAY_LOW_WATER_BYTES).toBeLessThan(RELAY_HIGH_WATER_BYTES);
    expect(FLOOD_FRAMES * FLOOD_FRAME_BYTES).toBeGreaterThan(RELAY_HIGH_WATER_BYTES);
    const events: Array<[string, boolean]> = [];
    hooks.onBackpressure = (side, paused) => { events.push([side, paused]); };
    const ws = await connect();
    const received: Buffer[] = [];
    ws.on('message', (data) => { received.push(data as Buffer); });
    ws.pause(); // the client stops reading: the gateway's send buffer towards it fills up
    ws.send('flood');
    await waitFor(() => events.some(([side, paused]) => side === 'upstream' && paused));
    ws.resume();
    await waitFor(() => received.length === FLOOD_FRAMES);
    await waitFor(() => events.some(([side, paused]) => side === 'upstream' && !paused));
    expect(received).toHaveLength(FLOOD_FRAMES);
    expect(received.reduce((total, b) => total + b.length, 0)).toBe(FLOOD_FRAMES * FLOOD_FRAME_BYTES);
    expect(received.map((b) => b.readUInt32BE(0))).toEqual([...Array(FLOOD_FRAMES).keys()]);
    expect(events.every(([side]) => side === 'upstream')).toBe(true);
    expect(events[0]).toEqual(['upstream', true]);
    expect(events[events.length - 1]).toEqual(['upstream', false]);
    ws.terminate();
  }, 30000);
  it('handle.close() closes both sides with the given code and reason, and reports both closes to onClosed', async () => {
    const sides: string[] = [];
    let bothReported!: () => void;
    const reported = new Promise<void>((r) => { bothReported = r; });
    hooks.onClosed = (side, code, reason) => { sides.push(`${side}:${code}:${reason}`); if (sides.length === 2) bothReported(); };
    const ws = await connect();
    const clientClosed = closed(ws);
    const upstreamClosed = closed(upstreamSockets[0]);
    handles[0].close(1008, 'quota_exceeded');
    expect(await clientClosed).toEqual({ code: 1008, reason: 'quota_exceeded' });
    expect(await upstreamClosed).toEqual({ code: 1008, reason: 'quota_exceeded' });
    await reported;
    expect(sides.sort()).toEqual(['client:1008:quota_exceeded', 'upstream:1008:quota_exceeded']);
  });
});
