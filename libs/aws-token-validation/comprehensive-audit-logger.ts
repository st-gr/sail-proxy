import { performance } from 'perf_hooks';
import crypto from 'crypto';
import { ValidationToken } from './validation-token';
import logger from '../logger';

export interface AuditEvent {
  eventId: string;
  timestamp: number;
  eventType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  actor: {
    type: 'user' | 'service' | 'system';
    id: string;
    ip?: string;
    userAgent?: string;
  };
  resource: {
    type: string;
    id: string;
    attributes?: Record<string, any>;
  };
  action: string;
  outcome: 'success' | 'failure' | 'error';
  details: Record<string, any>;
  metadata: {
    requestId?: string;
    sessionId?: string;
    traceId?: string;
    duration?: number;
    tags?: string[];
  };
  risks?: {
    score: number;
    factors: string[];
    indicators: string[];
  };
}

export interface AuditConfig {
  enableAsyncLogging: boolean;
  enableEncryption: boolean;
  enableRiskAnalysis: boolean;
  retentionDays: number;
  batchSize: number;
  flushInterval: number;
  storageBackends: ('database' | 'file' | 'elasticsearch' | 'syslog')[];
  riskThreshold: number;
}

export interface SecurityMetrics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  riskScore: number;
  anomalies: Array<{
    type: string;
    count: number;
    timeframe: string;
    severity: string;
  }>;
  trends: {
    authFailures: { rate: number; trend: 'increasing' | 'decreasing' | 'stable' };
    suspiciousActivity: { count: number; trend: 'increasing' | 'decreasing' | 'stable' };
    credentialAbuse: { count: number; trend: 'increasing' | 'decreasing' | 'stable' };
  };
}

export class ComprehensiveAuditLogger {
  private eventQueue: AuditEvent[] = [];
  private config: AuditConfig;
  private flushTimer: NodeJS.Timeout | null = null;
  private metrics: SecurityMetrics;
  private anomalyDetector: AnomalyDetector;
  private riskAnalyzer: RiskAnalyzer;

  constructor(config?: Partial<AuditConfig>) {
    this.config = {
      enableAsyncLogging: true,
      enableEncryption: process.env.NODE_ENV === 'production',
      enableRiskAnalysis: true,
      retentionDays: 90,
      batchSize: 100,
      flushInterval: 30000, // 30 seconds
      storageBackends: ['database', 'file'],
      riskThreshold: 7.0,
      ...config
    };

    this.metrics = {
      totalEvents: 0,
      eventsByType: {},
      eventsBySeverity: {},
      riskScore: 0,
      anomalies: [],
      trends: {
        authFailures: { rate: 0, trend: 'stable' },
        suspiciousActivity: { count: 0, trend: 'stable' },
        credentialAbuse: { count: 0, trend: 'stable' }
      }
    };

    this.anomalyDetector = new AnomalyDetector();
    this.riskAnalyzer = new RiskAnalyzer();

    this.startFlushTimer();
    logger.info('ComprehensiveAuditLogger', 'Audit logging system initialized');
  }

  /**
   * Log authentication events
   */
  async logAuthenticationEvent(
    eventType: 'auth_success' | 'auth_failure' | 'auth_attempt',
    details: {
      accessKeyId?: string;
      apiKey?: string;
      clientIp: string;
      userAgent?: string;
      endpoint: string;
      method: string;
      errorCode?: string;
      errorMessage?: string;
      validationTime?: number;
      cacheHit?: boolean;
    },
    requestId?: string
  ): Promise<void> {
    const severity = eventType === 'auth_failure' ? 'medium' : 'low';
    const outcome = eventType === 'auth_success' ? 'success' : 
                   eventType === 'auth_failure' ? 'failure' : 'success';

    const event: AuditEvent = {
      eventId: this.generateEventId(),
      timestamp: Date.now(),
      eventType,
      severity,
      source: 'gateway-auth',
      actor: {
        type: 'user',
        id: details.accessKeyId || details.apiKey || 'anonymous',
        ip: details.clientIp,
        userAgent: details.userAgent
      },
      resource: {
        type: 'credential',
        id: details.accessKeyId || details.apiKey || 'unknown',
        attributes: {
          endpoint: details.endpoint,
          method: details.method
        }
      },
      action: 'authenticate',
      outcome,
      details: {
        ...details,
        // Sanitize sensitive data
        accessKeyId: details.accessKeyId ? this.maskSensitiveData(details.accessKeyId) : undefined,
        apiKey: details.apiKey ? this.maskSensitiveData(details.apiKey) : undefined
      },
      metadata: {
        requestId,
        duration: details.validationTime,
        tags: ['authentication', details.cacheHit ? 'cache-hit' : 'cache-miss']
      }
    };

    // Add risk analysis
    if (this.config.enableRiskAnalysis) {
      event.risks = await this.riskAnalyzer.analyzeAuthEvent(event, details);
    }

    await this.logEvent(event);
  }

  /**
   * Log validation events
   */
  async logValidationEvent(
    eventType: 'validation_success' | 'validation_failure' | 'token_validation',
    details: {
      validationToken?: ValidationToken;
      credentialId?: string;
      accessKeyId?: string;
      clientIp?: string;
      errorCode?: string;
      errorMessage?: string;
      signatureValid?: boolean;
      ipAllowed?: boolean;
      expired?: boolean;
      validationTime?: number;
    },
    requestId?: string
  ): Promise<void> {
    const severity = eventType === 'validation_failure' ? 'medium' : 'low';
    const outcome = eventType === 'validation_success' ? 'success' : 'failure';

    const event: AuditEvent = {
      eventId: this.generateEventId(),
      timestamp: Date.now(),
      eventType,
      severity,
      source: 'admin-validation',
      actor: {
        type: 'service',
        id: 'gateway-service',
        ip: details.clientIp
      },
      resource: {
        type: 'aws-credential',
        id: details.credentialId || details.accessKeyId || 'unknown',
        attributes: {
          signatureValid: details.signatureValid,
          ipAllowed: details.ipAllowed,
          expired: details.expired
        }
      },
      action: 'validate_credential',
      outcome,
      details: {
        ...details,
        // Sanitize validation token
        validationToken: details.validationToken ? {
          accessKeyId: this.maskSensitiveData(details.validationToken.accessKeyId),
          challengeNonce: details.validationToken.challengeNonce.substring(0, 8) + '...',
          expiresAt: details.validationToken.expiresAt
        } : undefined
      },
      metadata: {
        requestId,
        duration: details.validationTime,
        tags: ['validation', 'token-based']
      }
    };

    // Add risk analysis for failures
    if (outcome === 'failure' && this.config.enableRiskAnalysis) {
      event.risks = await this.riskAnalyzer.analyzeValidationFailure(event, details);
    }

    await this.logEvent(event);
  }

  /**
   * Log security events
   */
  async logSecurityEvent(
    eventType: 'suspicious_activity' | 'credential_abuse' | 'rate_limit_exceeded' | 'ip_blocked' | 'brute_force_detected',
    details: {
      actorId?: string;
      clientIp?: string;
      userAgent?: string;
      attempts?: number;
      timeWindow?: number;
      blockedUntil?: Date;
      patterns?: string[];
      indicators?: string[];
    },
    requestId?: string
  ): Promise<void> {
    const severity = this.determineSeverity(eventType, details);

    const event: AuditEvent = {
      eventId: this.generateEventId(),
      timestamp: Date.now(),
      eventType,
      severity,
      source: 'security-monitor',
      actor: {
        type: details.actorId ? 'user' : 'system',
        id: details.actorId || 'anonymous',
        ip: details.clientIp,
        userAgent: details.userAgent
      },
      resource: {
        type: 'security-policy',
        id: eventType,
        attributes: {
          attempts: details.attempts,
          timeWindow: details.timeWindow,
          patterns: details.patterns
        }
      },
      action: 'security_violation',
      outcome: 'failure',
      details,
      metadata: {
        requestId,
        tags: ['security', 'threat-detection']
      }
    };

    // High priority risk analysis for security events
    if (this.config.enableRiskAnalysis) {
      event.risks = await this.riskAnalyzer.analyzeSecurityEvent(event, details);
    }

    await this.logEvent(event);

    // Immediate notification for critical events
    if (severity === 'critical') {
      await this.sendCriticalAlert(event);
    }
  }

  /**
   * Log system events
   */
  async logSystemEvent(
    eventType: 'service_start' | 'service_stop' | 'config_change' | 'cache_clear' | 'health_check',
    details: Record<string, any>,
    requestId?: string
  ): Promise<void> {
    const event: AuditEvent = {
      eventId: this.generateEventId(),
      timestamp: Date.now(),
      eventType,
      severity: 'low',
      source: 'system',
      actor: {
        type: 'system',
        id: 'gateway-system'
      },
      resource: {
        type: 'system',
        id: eventType
      },
      action: eventType,
      outcome: 'success',
      details,
      metadata: {
        requestId,
        tags: ['system', 'operational']
      }
    };

    await this.logEvent(event);
  }

  /**
   * Core event logging method
   */
  private async logEvent(event: AuditEvent): Promise<void> {
    try {
      // Update metrics
      this.updateMetrics(event);

      // Detect anomalies
      if (this.config.enableRiskAnalysis) {
        const anomaly = await this.anomalyDetector.detectAnomaly(event);
        if (anomaly) {
          this.metrics.anomalies.push(anomaly);
        }
      }

      // Encrypt if enabled
      if (this.config.enableEncryption) {
        event.details = await this.encryptSensitiveData(event.details);
      }

      if (this.config.enableAsyncLogging) {
        // Add to queue for batch processing
        this.eventQueue.push(event);
        
        if (this.eventQueue.length >= this.config.batchSize) {
          await this.flushEvents();
        }
      } else {
        // Immediate logging
        await this.persistEvent(event);
      }

      // Log to standard logger for immediate visibility
      this.logToStandardLogger(event);

    } catch (error) {
      logger.error('ComprehensiveAuditLogger', `Failed to log audit event: ${(error as Error).message}`);
    }
  }

  /**
   * Flush queued events to storage
   */
  private async flushEvents(): Promise<void> {
    if (this.eventQueue.length === 0) return;

    const eventsToFlush = [...this.eventQueue];
    this.eventQueue = [];

    try {
      await Promise.all([
        this.persistToDatabase(eventsToFlush),
        this.persistToFile(eventsToFlush),
        this.persistToElasticsearch(eventsToFlush),
        this.persistToSyslog(eventsToFlush)
      ]);

      logger.debug('ComprehensiveAuditLogger', `Flushed ${eventsToFlush.length} audit events`);

    } catch (error) {
      logger.error('ComprehensiveAuditLogger', `Failed to flush audit events: ${(error as Error).message}`);
      // Re-queue failed events
      this.eventQueue.unshift(...eventsToFlush);
    }
  }

  /**
   * Storage backend implementations
   */
  private async persistEvent(event: AuditEvent): Promise<void> {
    const promises = [];

    if (this.config.storageBackends.includes('database')) {
      promises.push(this.persistToDatabase([event]));
    }
    
    if (this.config.storageBackends.includes('file')) {
      promises.push(this.persistToFile([event]));
    }
    
    if (this.config.storageBackends.includes('elasticsearch')) {
      promises.push(this.persistToElasticsearch([event]));
    }
    
    if (this.config.storageBackends.includes('syslog')) {
      promises.push(this.persistToSyslog([event]));
    }

    await Promise.all(promises);
  }

  private async persistToDatabase(events: AuditEvent[]): Promise<void> {
    if (!this.config.storageBackends.includes('database')) return;

    try {
      // Implementation would depend on your database setup
      // This is a placeholder for the actual database persistence
      const cds = require('@sap/cds');
      
      const INSERT_EVENTS = events.map(event => 
        cds.ql.INSERT.into('sap.llm.gateway.admin.AuditEvents').entries({
          eventId: event.eventId,
          timestamp: new Date(event.timestamp),
          eventType: event.eventType,
          severity: event.severity,
          source: event.source,
          actorType: event.actor.type,
          actorId: event.actor.id,
          actorIp: event.actor.ip,
          resourceType: event.resource.type,
          resourceId: event.resource.id,
          action: event.action,
          outcome: event.outcome,
          details: JSON.stringify(event.details),
          metadata: JSON.stringify(event.metadata),
          risks: event.risks ? JSON.stringify(event.risks) : null
        })
      );

      await Promise.all(INSERT_EVENTS.map(query => cds.run(query)));

    } catch (error) {
      logger.error('ComprehensiveAuditLogger', `Database persistence failed: ${(error as Error).message}`);
    }
  }

  private async persistToFile(events: AuditEvent[]): Promise<void> {
    if (!this.config.storageBackends.includes('file')) return;

    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const logDir = process.env.AUDIT_LOG_DIR || './logs/audit';
      const logFile = path.join(logDir, `audit-${new Date().toISOString().split('T')[0]}.jsonl`);
      
      // Ensure directory exists
      await fs.mkdir(logDir, { recursive: true });
      
      const logLines = events.map(event => JSON.stringify(event)).join('\n') + '\n';
      await fs.appendFile(logFile, logLines);

    } catch (error) {
      logger.error('ComprehensiveAuditLogger', `File persistence failed: ${(error as Error).message}`);
    }
  }

  private async persistToElasticsearch(events: AuditEvent[]): Promise<void> {
    if (!this.config.storageBackends.includes('elasticsearch')) return;

    try {
      // Implementation would use Elasticsearch client
      // This is a placeholder for the actual Elasticsearch persistence
      logger.debug('ComprehensiveAuditLogger', `Would persist ${events.length} events to Elasticsearch`);

    } catch (error) {
      logger.error('ComprehensiveAuditLogger', `Elasticsearch persistence failed: ${(error as Error).message}`);
    }
  }

  private async persistToSyslog(events: AuditEvent[]): Promise<void> {
    if (!this.config.storageBackends.includes('syslog')) return;

    try {
      // Implementation would use syslog client
      // This is a placeholder for the actual syslog persistence
      events.forEach(event => {
        const syslogMessage = `${event.severity.toUpperCase()}: ${event.eventType} - ${event.action} by ${event.actor.id} on ${event.resource.type}:${event.resource.id} - ${event.outcome}`;
        logger.info('SYSLOG_AUDIT', syslogMessage);
      });

    } catch (error) {
      logger.error('ComprehensiveAuditLogger', `Syslog persistence failed: ${(error as Error).message}`);
    }
  }

  /**
   * Helper methods
   */
  private generateEventId(): string {
    return `audit_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }

  private maskSensitiveData(data: string): string {
    if (data.length <= 8) return '****';
    return data.substring(0, 4) + '****' + data.substring(data.length - 4);
  }

  private determineSeverity(eventType: string, details: any): 'low' | 'medium' | 'high' | 'critical' {
    if (eventType === 'brute_force_detected' || details.attempts > 10) return 'critical';
    if (eventType === 'suspicious_activity' || eventType === 'credential_abuse') return 'high';
    if (eventType === 'rate_limit_exceeded' || eventType === 'ip_blocked') return 'medium';
    return 'low';
  }

  private updateMetrics(event: AuditEvent): void {
    this.metrics.totalEvents++;
    this.metrics.eventsByType[event.eventType] = (this.metrics.eventsByType[event.eventType] || 0) + 1;
    this.metrics.eventsBySeverity[event.severity] = (this.metrics.eventsBySeverity[event.severity] || 0) + 1;
    
    if (event.risks) {
      this.metrics.riskScore = Math.max(this.metrics.riskScore, event.risks.score);
    }
  }

  private async encryptSensitiveData(data: any): Promise<any> {
    // Implementation would encrypt sensitive fields
    return data; // Placeholder
  }

  private logToStandardLogger(event: AuditEvent): void {
    const message = `${event.eventType}: ${event.action} by ${event.actor.id} on ${event.resource.type}:${event.resource.id} - ${event.outcome}`;
    
    switch (event.severity) {
      case 'critical':
        logger.error('AUDIT_CRITICAL', message);
        break;
      case 'high':
        logger.warn('AUDIT_HIGH', message);
        break;
      case 'medium':
        logger.warn('AUDIT_MEDIUM', message);
        break;
      default:
        logger.info('AUDIT', message);
    }
  }

  private async sendCriticalAlert(event: AuditEvent): Promise<void> {
    try {
      // Implementation would send notifications (email, Slack, PagerDuty, etc.)
      logger.error('CRITICAL_SECURITY_ALERT', `Critical security event: ${JSON.stringify(event)}`);
      
      // Example: Send to monitoring system
      // await this.sendToMonitoringSystem(event);
      
    } catch (error) {
      logger.error('ComprehensiveAuditLogger', `Failed to send critical alert: ${(error as Error).message}`);
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(async () => {
      await this.flushEvents();
    }, this.config.flushInterval);
  }

  /**
   * Public API methods
   */
  getMetrics(): SecurityMetrics {
    return { ...this.metrics };
  }

  async getAuditEvents(
    filters: {
      eventType?: string;
      severity?: string;
      actorId?: string;
      resourceId?: string;
      startTime?: number;
      endTime?: number;
      limit?: number;
    }
  ): Promise<AuditEvent[]> {
    // Implementation would query storage backends
    return []; // Placeholder
  }

  async generateSecurityReport(timeRange: { start: Date; end: Date }): Promise<{
    summary: SecurityMetrics;
    topEvents: AuditEvent[];
    recommendations: string[];
  }> {
    // Implementation would generate comprehensive security report
    return {
      summary: this.metrics,
      topEvents: [],
      recommendations: []
    };
  }

  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    await this.flushEvents();
    logger.info('ComprehensiveAuditLogger', 'Audit logger destroyed');
  }
}

// Helper classes
class AnomalyDetector {
  async detectAnomaly(event: AuditEvent): Promise<any> {
    // Implement anomaly detection logic
    return null;
  }
}

class RiskAnalyzer {
  async analyzeAuthEvent(event: AuditEvent, details: any): Promise<any> {
    // Implement risk analysis for auth events
    return {
      score: 2.0,
      factors: ['normal_usage'],
      indicators: []
    };
  }

  async analyzeValidationFailure(event: AuditEvent, details: any): Promise<any> {
    // Implement risk analysis for validation failures
    return {
      score: 5.0,
      factors: ['validation_failure'],
      indicators: ['invalid_signature']
    };
  }

  async analyzeSecurityEvent(event: AuditEvent, details: any): Promise<any> {
    // Implement risk analysis for security events
    return {
      score: 8.0,
      factors: ['security_violation'],
      indicators: ['suspicious_pattern']
    };
  }
}

// Export singleton instance
export const auditLogger = new ComprehensiveAuditLogger();

export default ComprehensiveAuditLogger;