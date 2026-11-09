/**
 * Pins that index.ts attaches the realtime upgrade handler to the listening server, and that the
 * handler admits through the same middlewares every LLM route mounts (quota-middleware-wiring
 * covers the routers; the upgrade handler is not a router, so it is pinned here).
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('realtime wiring', () => {
  it('index.ts attaches the realtime upgrade handler to the server returned by app.listen', () => {
    const index = stripComments(fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8'));
    expect(index).toContain("import { attachRealtimeUpgrade } from './realtime/realtimeUpgrade';");
    const listenAt = index.indexOf('const server = app.listen(');
    const attachAt = index.indexOf('cleanupResources.realtime = attachRealtimeUpgrade(server);');
    expect(listenAt).toBeGreaterThan(-1);
    expect(attachAt).toBeGreaterThan(listenAt);
    expect(index).toContain('/openai/v1/realtime');
  });
  it('gracefulShutdown closes the open realtime sessions before the Valkey clients are disconnected', () => {
    const index = stripComments(fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8'));
    const shutdown = index.slice(index.indexOf('function gracefulShutdown('), index.indexOf("process.on('SIGTERM'"));
    expect(shutdown).toContain('closeAll(');
    const closeAllAt = shutdown.indexOf('closeAll(');
    const valkeyAt = shutdown.indexOf('cleanupResources.valkeyClients.map(');
    const serverCloseAt = shutdown.indexOf('cleanupResources.server.close(');
    expect(closeAllAt).toBeGreaterThan(-1);
    expect(valkeyAt).toBeGreaterThan(closeAllAt);
    expect(serverCloseAt).toBeGreaterThan(closeAllAt);
  });
  it('the upgrade handler admits through unified auth, the openai service auth and quotaEnforcement', () => {
    const handler = stripComments(fs.readFileSync(path.join(SRC, 'realtime', 'realtimeUpgrade.ts'), 'utf8'));
    expect(handler).toContain("import quotaEnforcement from '../middlewares/quotaEnforcement';");
    expect(handler).toContain('createUnifiedTokenAuth()');
    expect(handler).toContain('createServiceAuthMiddleware(serviceConfigurations.openai)');
    expect(handler).toContain('quota: quotaEnforcement');
  });
});
