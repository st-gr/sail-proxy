/**
 * Database compatibility configuration for handling differences between SQLite and PostgreSQL
 */

import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

export interface DatabaseCompatibilityConfig {
  isPostgreSQL: boolean;
  dateFieldHandling: {
    // PostgreSQL doesn't support to_char in the same way as SQLite/Oracle
    avoidDateFormatting: boolean;
    // Date fields that should not trigger formatting functions
    rawDateFields: string[];
  };
}

/**
 * Get database compatibility configuration based on current database type
 */
export function getDatabaseCompatibilityConfig(): DatabaseCompatibilityConfig {
  const cds = require('@sap/cds');
  const dbKind = cds.env.requires?.db?.kind || 'sqlite';
  const isPostgreSQL = dbKind === 'postgres';
  
  logger.debug('DatabaseCompatibility', `Database kind detected: ${dbKind}`, {
    isPostgreSQL,
    env: process.env.NODE_ENV,
    profile: process.env.CDS_PROFILE
  });
  
  return {
    isPostgreSQL,
    dateFieldHandling: {
      avoidDateFormatting: isPostgreSQL,
      rawDateFields: [
        'eventDate',
        'createdAt',
        'modifiedAt',
        'validFrom',
        'validTo',
        'lastUsed',
        'expiresAt',
        'deployedAt',
        'rolledBackAt',
        'seenAt',
        'dismissedAt',
        'snoozeUntil'
      ]
    }
  };
}

/**
 * Process orderBy clause to ensure compatibility with current database
 */
export function processOrderByForCompatibility(orderBy: any[], config?: DatabaseCompatibilityConfig): any[] {
  if (!orderBy || !Array.isArray(orderBy)) {
    return orderBy;
  }
  
  const dbConfig = config || getDatabaseCompatibilityConfig();
  
  if (!dbConfig.dateFieldHandling.avoidDateFormatting) {
    // No processing needed for SQLite
    return orderBy;
  }
  
  // PostgreSQL: Ensure date fields don't trigger formatting functions
  return orderBy.map((item: any) => {
    if (item && typeof item === 'object' && item.ref && 
        Array.isArray(item.ref) && dbConfig.dateFieldHandling.rawDateFields.includes(item.ref[0])) {
      // Return a clean reference without any transformations
      return { 
        ref: [item.ref[0]], 
        sort: item.sort || 'desc' 
      };
    }
    return item;
  });
}

/**
 * Check if current database is PostgreSQL
 */
export function isPostgreSQL(): boolean {
  return getDatabaseCompatibilityConfig().isPostgreSQL;
}