import { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

interface NotificationClient {
  id: symbol;
  response: Response;
  userId: string;
  lastPing: number;
}

class NotificationStreamService {
  private clients = new Map<symbol, NotificationClient>();
  private pingInterval?: NodeJS.Timeout;

  constructor() {
    // Keep connections alive with periodic pings
    this.pingInterval = setInterval(() => {
      this.pingClients();
    }, 30000); // 30 seconds
  }

  /**
   * Handle SSE connection from client
   */
  public handleConnection = (req: Request, res: Response): void => {
    // Get user from request context (set by authentication middleware)
    let userId = req.user?.id;
    
    // Fallback: try to get user from session (development mode)
    if (!userId && (req as any).session?.user) {
      userId = (req as any).session.user.id;
    }
    
    // Fallback: try to get user from CAP context
    if (!userId && cds.context?.user?.id) {
      userId = cds.context.user.id;
    }
    
    logger.debug('SSE Connection', 'Authentication check', {
      hasReqUser: !!req.user,
      hasSession: !!((req as any).session?.user),
      hasCdsContext: !!(cds.context?.user),
      resolvedUserId: userId
    });
    
    if (!userId) {
      logger.warn('SSE Connection', 'No authenticated user found for SSE connection');
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    
    res.flushHeaders();

    const clientId = Symbol();
    const client: NotificationClient = {
      id: clientId,
      response: res,
      userId,
      lastPing: Date.now()
    };

    this.clients.set(clientId, client);
    logger.info('NotificationStream', `SSE client connected: ${userId} (${this.clients.size} total clients)`);

    // Send initial connection confirmation
    this.sendEvent(res, 'connected', { userId, timestamp: new Date().toISOString() });

    // Handle client disconnect
    req.on('close', () => {
      this.clients.delete(clientId);
      logger.info('NotificationStream', `SSE client disconnected: ${userId} (${this.clients.size} remaining clients)`);
    });

    req.on('error', (error) => {
      logger.error('NotificationStream', `SSE client error for ${userId}:`, error as Error);
      this.clients.delete(clientId);
    });
  };

  /**
   * Notify specific user about notification changes
   */
  public notifyUser(userId: string, eventType: string, data: any): void {
    let notifiedCount = 0;
    
    for (const client of this.clients.values()) {
      if (client.userId === userId) {
        try {
          this.sendEvent(client.response, eventType, data);
          notifiedCount++;
        } catch (error) {
          logger.error('NotificationStream', `Failed to send event to ${userId}:`, error as Error);
          this.clients.delete(client.id);
        }
      }
    }

    if (notifiedCount > 0) {
      logger.info('NotificationStream', `Notified ${notifiedCount} clients for user ${userId} about ${eventType}`);
    }
  }

  /**
   * Notify all connected clients (admin broadcast, etc.)
   */
  public notifyAll(eventType: string, data: any): void {
    let notifiedCount = 0;

    for (const client of this.clients.values()) {
      try {
        this.sendEvent(client.response, eventType, data);
        notifiedCount++;
      } catch (error) {
        logger.error('NotificationStream', `Failed to broadcast to ${client.userId}:`, error as Error);
        this.clients.delete(client.id);
      }
    }

    logger.info('NotificationStream', `Broadcasted ${eventType} to ${notifiedCount} clients`);
  }

  /**
   * Send SSE event to client
   */
  private sendEvent(res: Response, eventType: string, data: any): void {
    const eventData = JSON.stringify(data);
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${eventData}\n\n`);
  }

  /**
   * Send ping to all clients to keep connections alive
   */
  private pingClients(): void {
    const now = Date.now();
    const expiredClients: symbol[] = [];

    for (const [clientId, client] of this.clients.entries()) {
      try {
        this.sendEvent(client.response, 'ping', { timestamp: now });
        client.lastPing = now;
      } catch (error) {
        logger.warn('NotificationStream', `Client ${client.userId} appears disconnected, removing`);
        expiredClients.push(clientId);
      }
    }

    // Clean up expired clients
    expiredClients.forEach(clientId => this.clients.delete(clientId));
  }

  /**
   * Get connection statistics
   */
  public getStats() {
    const userCounts: Record<string, number> = {};
    
    for (const client of this.clients.values()) {
      userCounts[client.userId] = (userCounts[client.userId] || 0) + 1;
    }

    return {
      totalClients: this.clients.size,
      userCounts
    };
  }

  /**
   * Cleanup on service shutdown
   */
  public shutdown(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      try {
        client.response.end();
      } catch (error) {
        // Ignore errors when closing
      }
    }

    this.clients.clear();
    logger.info('NotificationStream', 'Notification stream service shut down');
  }
}

// Singleton instance
export const notificationStreamService = new NotificationStreamService();

// Graceful shutdown
process.on('SIGTERM', () => notificationStreamService.shutdown());
process.on('SIGINT', () => notificationStreamService.shutdown());