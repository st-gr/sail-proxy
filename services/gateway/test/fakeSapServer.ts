/**
 * A local stand-in for SAP AI Core that misbehaves on request: each incoming request takes the
 * next behaviour from a script (the last one repeats). Bound to 127.0.0.1 on a free port.
 */
import * as http from 'http';
import { AddressInfo } from 'net';

export type FakeSapBehaviour =
  | { kind: 'stall' } // accepts the request and never answers
  | { kind: 'reset' } // destroys the socket without an answer ("socket hang up")
  | { kind: 'status'; status: number; body?: unknown }
  | { kind: 'json'; body: unknown } // 200 with a JSON body
  | { kind: 'headersThenStall'; partialBody?: string }; // 200 headers, part of a body, never ends

export interface FakeSapRequest { method: string; url: string; body: string }

export interface FakeSapServer {
  url: string;
  requests: FakeSapRequest[];
  /** Replaces the script; requests already in flight keep their behaviour. */
  script(behaviours: FakeSapBehaviour[]): void;
  close(): Promise<void>;
}

export async function startFakeSapServer(initial: FakeSapBehaviour[] = []): Promise<FakeSapServer> {
  let behaviours = [...initial];
  const requests: FakeSapRequest[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      const behaviour = behaviours.length > 1 ? behaviours.shift()! : behaviours[0] ?? { kind: 'stall' };
      switch (behaviour.kind) {
        case 'stall':
          return;
        case 'reset':
          req.socket.destroy();
          return;
        case 'status':
          res.writeHead(behaviour.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(behaviour.body ?? { error: { message: `status ${behaviour.status}` } }));
          return;
        case 'json':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(behaviour.body));
          return;
        case 'headersThenStall':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write(behaviour.partialBody ?? '{"final_result":');
          return;
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    script(next) { behaviours = [...next]; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
