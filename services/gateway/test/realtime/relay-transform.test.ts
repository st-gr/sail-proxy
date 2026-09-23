/**
 * The client hook as a transform (spec 2026-09-22 §5.1): forward a replacement, drop with a reply to
 * the client, send a gateway-originated frame upstream after the forwarded one, and fail open.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { relay, RelayHandle, RelayHooks } from '../../src/realtime/relay';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

const nextMessage = (ws: WebSocket) => new Promise<{ data: Buffer; isBinary: boolean }>((r) => ws.once('message', (data, isBinary) => r({ data: data as Buffer, isBinary })));
const opened = (ws: WebSocket) => new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
const silence = (ws: WebSocket, ms: number) => new Promise<boolean>((r) => {
  const t = setTimeout(() => { ws.off('message', on); r(true); }, ms);
  const on = () => { clearTimeout(t); r(false); };
  ws.once('message', on);
});

let upstreamSrv: WebSocketServer;
let gatewaySrv: WebSocketServer;
let handles: RelayHandle[];
let hooks: RelayHooks;

beforeEach(async () => {
  handles = []; hooks = {};
  upstreamSrv = new WebSocketServer({ port: 0 });
  upstreamSrv.on('connection', (s) => {
    s.on('message', (data, isBinary) => s.send(Buffer.concat([Buffer.from('echo:'), data as Buffer]), { binary: isBinary }));
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

const original = '{"type":"session.update","session":{"tools":[{"type":"function","name":"shell"}]}}';
const replacement = '{"type":"session.update","session":{"tools":[]}}';

describe('relay client transform', () => {
  it('forwards a replacement instead of the original', async () => {
    hooks.onClientFrame = () => ({ forward: replacement });
    const ws = await connect();
    ws.send(original);
    expect((await nextMessage(ws)).data.toString()).toBe(`echo:${replacement}`);
    ws.close();
  });
  it('drops a frame and replies to the client; nothing reaches the upstream', async () => {
    const reply = '{"type":"error","error":{"code":"tool_not_entitled"}}';
    hooks.onClientFrame = () => ({ drop: true, reply });
    const ws = await connect();
    ws.send(original);
    expect((await nextMessage(ws)).data.toString()).toBe(reply);
    expect(await silence(ws, 150)).toBe(true);
    ws.close();
  });
  it('sends thenUpstream after the forwarded frame, in order', async () => {
    const extra = '{"type":"session.update","session":{"tools":[]}}';
    hooks.onClientFrame = (data) => ({ forward: data, thenUpstream: extra });
    const ws = await connect();
    const received: string[] = [];
    ws.on('message', (d) => received.push(d.toString()));
    ws.send(original);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual([`echo:${original}`, `echo:${extra}`]);
    ws.close();
  });
  it('a throwing hook forwards the original', async () => {
    hooks.onClientFrame = () => { throw new Error('observer broke'); };
    const ws = await connect();
    ws.send(original);
    expect((await nextMessage(ws)).data.toString()).toBe(`echo:${original}`);
    ws.close();
  });
  it('binary frames pass untouched when the hook returns nothing', async () => {
    hooks.onClientFrame = () => undefined;
    const ws = await connect();
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    const got = await nextMessage(ws);
    expect(got.isBinary).toBe(true);
    expect([...got.data]).toEqual([...Buffer.from('echo:'), 1, 2, 3]);
    ws.close();
  });
  it('sendUpstream and sendClient write gateway frames', async () => {
    const ws = await connect();
    handles[0].sendClient('{"b":2}');
    expect((await nextMessage(ws)).data.toString()).toBe('{"b":2}');
    handles[0].sendUpstream('{"a":1}');
    expect((await nextMessage(ws)).data.toString()).toBe('echo:{"a":1}');
    ws.close();
  });
});
