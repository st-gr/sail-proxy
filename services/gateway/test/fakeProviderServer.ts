/**
 * A loopback stand-in for an external provider (OpenAI, Azure OpenAI, the Entra token endpoint).
 * Like fakeSapServer: each request takes the next behaviour from a script (the last one repeats),
 * per path prefix when `route` set one, otherwise from the default script. Bound to 127.0.0.1.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import { encodeEventStreamMessage, EVENT_STREAM_CONTENT_TYPE } from '../src/utils/bedrockEventStream';

export type FakeProviderBehaviour =
  | { kind: 'stall' } // accepts the request and never answers
  | { kind: 'reset' } // destroys the socket without an answer
  | { kind: 'status'; status: number; body?: unknown }
  | { kind: 'json'; body: unknown; status?: number }
  /**
   * text/event-stream: each frame written as `data: <frame>\n\n`. After `stallAfter` frames it stops
   * writing and never ends; after `resetAfter` frames it destroys the socket. With `raw` each frame
   * is written exactly as given (`event:` lines, split events, a Buffer cut inside a multi-byte character), without the `data: ` wrapper.
   */
  | { kind: 'sse'; frames: Array<string | Buffer>; delayMs?: number; stallAfter?: number; resetAfter?: number; raw?: boolean }
  /**
   * Bedrock's binary event stream: each Anthropic event object goes out as a `chunk` message whose
   * payload is `{"bytes": <base64 JSON>}`; `exception` adds a closing exception message. After
   * `resetAfter` messages it destroys the socket. `splitAt` cuts every message at those byte offsets
   * into separate writes.
   */
  | { kind: 'eventstream'; events: unknown[]; exception?: { type: string; message: string }; errorFrame?: { code: string; message: string }; partialTail?: boolean; resetAfter?: number; splitAt?: number[]; delayMs?: number };

export interface FakeProviderRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The client closed the connection before the response ended. */
  closedEarly: boolean;
}

export interface FakeProviderServer {
  url: string;
  requests: FakeProviderRequest[];
  /** Replaces the default script. */
  script(behaviours: FakeProviderBehaviour[]): void;
  /** A script for requests whose path starts with `pathPrefix`; checked before the default. */
  route(pathPrefix: string, behaviours: FakeProviderBehaviour[]): void;
  close(): Promise<void>;
}

const next = (queue: FakeProviderBehaviour[]): FakeProviderBehaviour =>
  queue.length > 1 ? queue.shift()! : queue[0] ?? { kind: 'stall' };

export async function startFakeProviderServer(initial: FakeProviderBehaviour[] = []): Promise<FakeProviderServer> {
  let behaviours = [...initial];
  const routes = new Map<string, FakeProviderBehaviour[]>();
  const requests: FakeProviderRequest[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      const record: FakeProviderRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, closedEarly: false };
      requests.push(record);
      res.on('close', () => { if (!res.writableFinished) record.closedEarly = true; });
      const prefix = [...routes.keys()].find((p) => (req.url ?? '').startsWith(p));
      const behaviour = next(prefix !== undefined ? routes.get(prefix)! : behaviours);
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
          res.writeHead(behaviour.status ?? 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(behaviour.body));
          return;
        case 'sse': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const frames = [...behaviour.frames];
          let written = 0;
          const write = () => {
            if (res.destroyed) return;
            if (behaviour.stallAfter !== undefined && written >= behaviour.stallAfter) return;
            if (behaviour.resetAfter !== undefined && written >= behaviour.resetAfter) { res.destroy(); return; }
            const frame = frames.shift();
            if (frame === undefined) { res.end(); return; }
            res.write(behaviour.raw ? frame : `data: ${frame}\n\n`);
            written++;
            setTimeout(write, behaviour.delayMs ?? 1);
          };
          write();
          return;
        }
        case 'eventstream': {
          res.writeHead(200, { 'Content-Type': EVENT_STREAM_CONTENT_TYPE });
          const messages = behaviour.events.map((event) => encodeEventStreamMessage(
            { ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' },
            Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event), 'utf8').toString('base64') }), 'utf8')));
          if (behaviour.exception) {
            messages.push(encodeEventStreamMessage(
              { ':message-type': 'exception', ':exception-type': behaviour.exception.type, ':content-type': 'application/json' },
              Buffer.from(JSON.stringify({ message: behaviour.exception.message }), 'utf8')));
          }
          if (behaviour.errorFrame) {
            messages.push(encodeEventStreamMessage(
              { ':message-type': 'error', ':error-code': behaviour.errorFrame.code, ':error-message': behaviour.errorFrame.message },
              Buffer.alloc(0)));
          }
          // The first half of one more frame; the stream then ends cleanly.
          if (behaviour.partialTail) {
            const whole = encodeEventStreamMessage({ ':event-type': 'chunk', ':message-type': 'event' }, Buffer.from('{"bytes":""}', 'utf8'));
            messages.push(whole.subarray(0, Math.floor(whole.length / 2)));
          }
          const pieces: Buffer[][] = messages.map((m) => {
            const cuts = [0, ...(behaviour.splitAt ?? []).filter((c) => c > 0 && c < m.length), m.length];
            return cuts.slice(1).map((end, i) => m.subarray(cuts[i], end));
          });
          let written = 0;
          const write = () => {
            if (res.destroyed) return;
            if (behaviour.resetAfter !== undefined && written >= behaviour.resetAfter) { res.destroy(); return; }
            const parts = pieces.shift();
            if (parts === undefined) { res.end(); return; }
            parts.forEach((part, i) => setTimeout(() => { if (!res.destroyed) res.write(part); }, i * 2));
            written++;
            setTimeout(write, (behaviour.delayMs ?? 1) + parts.length * 2);
          };
          write();
          return;
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    script(nextScript) { behaviours = [...nextScript]; },
    route(pathPrefix, script) { routes.set(pathPrefix, [...script]); },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
