/**
 * Test servers that ask for an ephemeral port bind 127.0.0.1, and `localhost` resolves to
 * 127.0.0.1 first, so a test's client and its server always meet on the same address.
 *
 * `app.listen(0)` — what supertest's `request(app)`, cds.test (`listen('0')`, a string) and
 * `new WebSocketServer({ port: 0 })` do — binds the dual-stack wildcard `::`. macOS then hands out a port that another process
 * already holds on a SPECIFIC address (Colima's port forwarders on 127.0.0.1 / 0.0.0.0, a
 * `cds watch` livereload on [::1]); the more specific listener wins, so the test client —
 * supertest dials 127.0.0.1, cds.test dials localhost — reaches that process instead of the test
 * server: "Parse Error: Expected HTTP/", "socket hang up" or a foreign 404, in whichever suite
 * happened to draw that port. A socket bound to 127.0.0.1 is never handed a port another IPv4
 * listener holds.
 *
 * Fixed ports, explicit hosts, pipes and handles are left alone.
 *
 * `localhost` then still resolves to 127.0.0.1 AND ::1, and Node's dual-stack dialling gives each
 * address 250 ms before trying the next. cds.test serves in the test's own process, and its first
 * request compiles the service synchronously: when that blocks the process past 250 ms right after
 * the client dialled, the 127.0.0.1 attempt is abandoned as timed out and ::1 is refused
 * ("connect ETIMEDOUT 127.0.0.1:…; connect ECONNREFUSED ::1:…", private CI 2026-10-07). Test
 * processes therefore dial the first address only.
 */
import * as net from 'net';
// The module object itself, not an interop copy: listen() reads dns.lookup from it at call time.
import dns = require('dns');

export const TEST_LOOPBACK_HOST = '127.0.0.1';

const ORIGINAL_LISTEN = Symbol.for('sail-proxy.test-utils.originalListen');

// Node reads a numeric string as a port (cds.server passes '0'); any other string is a pipe name.
const isEphemeral = (port: unknown): boolean =>
  port === undefined || port === null || port === 0 || (typeof port === 'string' && Number(port) === 0);

/** The listen() arguments with TEST_LOOPBACK_HOST added when they ask for an ephemeral port without a host. */
export const withLoopbackHost = (args: unknown[]): unknown[] => {
  const [first, second, ...rest] = args;

  if (args.length === 0) return [0, TEST_LOOPBACK_HOST];
  if (typeof first === 'function') return [0, TEST_LOOPBACK_HOST, ...args];

  if (first !== null && typeof first === 'object') {
    const options = first as Record<string, unknown>;
    // Only a plain options object: spreading a handle would drop its prototype.
    const pinnable = Object.getPrototypeOf(options) === Object.prototype && isEphemeral(options.port) && options.host === undefined
      && options.path === undefined && options.fd === undefined && options.handle === undefined
      && !('_handle' in options);
    return pinnable ? [{ ...options, host: TEST_LOOPBACK_HOST }, ...args.slice(1)] : args;
  }

  if (!isEphemeral(first)) return args;
  if (typeof second === 'string') return args;
  if (second === undefined || second === null) return args.length < 2 ? [first, TEST_LOOPBACK_HOST] : [first, TEST_LOOPBACK_HOST, ...rest];
  return [first, TEST_LOOPBACK_HOST, second, ...rest];
};

/**
 * dns.lookup for listen(): answers TEST_LOOPBACK_HOST synchronously and hands any other host to `lookup`.
 * Node 20's listen() asks for one address, Node 22+ for all of them ({ all: true }) and binds each.
 */
export const loopbackLookup = (lookup: Function, hostname: string, options: unknown, callback?: Function): unknown => {
  if (hostname !== TEST_LOOPBACK_HOST) return lookup(hostname, options, callback);
  const done = (typeof options === 'function' ? options : callback) as Function;
  if (options !== null && typeof options === 'object' && (options as { all?: boolean }).all) {
    return done(null, [{ address: TEST_LOOPBACK_HOST, family: 4 }]);
  }
  return done(null, TEST_LOOPBACK_HOST, 4);
};

/**
 * Pins every ephemeral-port server of this process to 127.0.0.1, makes `localhost` resolve to
 * 127.0.0.1 first and turns off dual-stack dialling, so a localhost client dials 127.0.0.1 only.
 * Call once from a jest setup file; repeated calls are no-ops.
 */
export const pinEphemeralServersToLoopback = (): void => {
  dns.setDefaultResultOrder('ipv4first');
  // Node >= 20 has it; the @types/node in use predates its declaration.
  (net as unknown as { setDefaultAutoSelectFamily?: (value: boolean) => void }).setDefaultAutoSelectFamily?.(false);

  const proto = net.Server.prototype as any;
  if (proto[ORIGINAL_LISTEN]) return;
  const original = proto.listen;
  proto[ORIGINAL_LISTEN] = original;
  proto.listen = function listen(this: net.Server, ...args: unknown[]) {
    const pinned = withLoopbackHost(args);
    if (pinned === args) return original.apply(this, args);
    // With a host, listen() resolves it through dns.lookup and binds a tick later, while without
    // one it binds at once — and supertest reads address() right after app.listen(0). Answering
    // the literal synchronously keeps the bind synchronous.
    const lookup = dns.lookup;
    (dns as any).lookup = (hostname: string, options: unknown, callback?: Function) =>
      loopbackLookup(lookup, hostname, options, callback);
    try {
      return original.apply(this, pinned);
    } finally {
      (dns as any).lookup = lookup;
    }
  };
};
