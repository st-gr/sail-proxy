/** Recording invoked tools from what a streaming controller writes (Bedrock, spec 2026-09-22 §4). */
import { tapStreamedTools } from '../src/toolGovernance/streamTap';
import { bedrockAdapter } from '../src/toolGovernance/adapters/bedrock';
import { evaluate } from '../src/toolGovernance/evaluate';

const governed = () => ({ toolGovernance: { result: evaluate(['function:read'], null, null, null), declared: ['function:read'], invoked: new Map(), family: 'bedrock' } }) as any;

describe('tapStreamedTools', () => {
  it('records tool starts from written frames and still writes them', () => {
    const req = governed();
    const written: string[] = [];
    const res: any = { write: (c: any) => { written.push(String(c)); return true; } };
    tapStreamedTools(req, res, bedrockAdapter);
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"read","input":{}}}\n\n');
    res.write(Buffer.from('data: {"contentBlockStart":{"start":{"toolUse":{"toolUseId":"u","name":"read"}}}}\n\n'));
    expect(req.toolGovernance.invoked.get('function:read')).toBe(2);
    expect(written).toHaveLength(2);
  });
  it('an ungoverned request is left alone, and a scan error never breaks the write', () => {
    const res: any = { write: jest.fn().mockReturnValue(true) };
    const original = res.write;
    tapStreamedTools({}, res, bedrockAdapter);
    expect(res.write).toBe(original);
    const req = governed();
    const res2: any = { write: jest.fn().mockReturnValue(true) };
    tapStreamedTools(req, res2, { ...bedrockAdapter, invokedToolsFromStream: () => { throw new Error('boom'); } });
    expect(res2.write('x')).toBe(true);
  });
  it('reassembles a native tool-start frame split mid-JSON across two writes', () => {
    const req = governed();
    const written: string[] = [];
    const res: any = { write: (c: any) => { written.push(String(c)); return true; } };
    tapStreamedTools(req, res, bedrockAdapter);
    const frame = 'data: {"contentBlockStart":{"start":{"toolUse":{"toolUseId":"u","name":"read"}}}}\n\n';
    const cut = frame.indexOf('"na') + 2;
    res.write(frame.slice(0, cut));
    res.write(frame.slice(cut));
    expect(req.toolGovernance.invoked.get('function:read')).toBe(1);
    expect(written).toEqual([frame.slice(0, cut), frame.slice(cut)]);
  });
  it('reassembles an Anthropic-shaped tool_use frame split into three writes, including a split inside the data: prefix', () => {
    const req = governed();
    const written: string[] = [];
    const res: any = { write: (c: any) => { written.push(String(c)); return true; } };
    tapStreamedTools(req, res, bedrockAdapter);
    const frame = 'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"read","input":{}}}\n\n';
    const cut1 = frame.indexOf('\ndata:') + 3; // split inside the "data:" prefix
    const cut2 = frame.indexOf('"na') + 2;
    const parts = [frame.slice(0, cut1), frame.slice(cut1, cut2), frame.slice(cut2)];
    for (const part of parts) res.write(part);
    expect(req.toolGovernance.invoked.get('function:read')).toBe(1);
    expect(written).toEqual(parts);
  });
  it('a frame that arrives whole is not double-counted when the following write starts a new line', () => {
    const req = governed();
    const res: any = { write: jest.fn().mockReturnValue(true) };
    tapStreamedTools(req, res, bedrockAdapter);
    res.write('data: {"contentBlockStart":{"start":{"toolUse":{"toolUseId":"u","name":"read"}}}}\n\n');
    res.write('event: ping\ndata: {"type":"ping"}\n\n');
    expect(req.toolGovernance.invoked.get('function:read')).toBe(1);
  });
  it('70 KiB with no newline never throws, and a following tool-start frame is still recorded', () => {
    const req = governed();
    const res: any = { write: jest.fn().mockReturnValue(true) };
    tapStreamedTools(req, res, bedrockAdapter);
    expect(() => res.write('x'.repeat(70 * 1024))).not.toThrow();
    res.write('data: {"contentBlockStart":{"start":{"toolUse":{"toolUseId":"u","name":"read"}}}}\n\n');
    expect(req.toolGovernance.invoked.get('function:read')).toBe(1);
  });
  it('scans a frame passed only to res.end, including an unterminated tail', () => {
    const req = governed();
    const ended: any[][] = [];
    const res: any = { write: jest.fn().mockReturnValue(true), end: (...args: any[]) => { ended.push(args); return res; } };
    tapStreamedTools(req, res, bedrockAdapter);
    const frame = 'data: {"contentBlockStart":{"start":{"toolUse":{"toolUseId":"u","name":"read"}}}}';
    expect(res.end(frame, 'utf8')).toBe(res);
    expect(req.toolGovernance.invoked.get('function:read')).toBe(1);
    expect(ended).toEqual([[frame, 'utf8']]);
  });
  it('res.end() with no chunk still ends the response', () => {
    const req = governed();
    const end = jest.fn().mockReturnValue('ended');
    const res: any = { write: jest.fn().mockReturnValue(true), end };
    tapStreamedTools(req, res, bedrockAdapter);
    expect(res.end()).toBe('ended');
    expect(end).toHaveBeenCalledWith();
    expect(req.toolGovernance.invoked.size).toBe(0);
  });
});
