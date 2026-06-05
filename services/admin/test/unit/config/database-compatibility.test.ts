import { getDatabaseCompatibilityConfig, processOrderByForCompatibility, isPostgreSQL } from '../../../src/config/database-compatibility';

describe('Database Compatibility', () => {
  const originalEnv = process.env;
  
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getDatabaseCompatibilityConfig', () => {
    it('should detect SQLite as default database', () => {
      const config = getDatabaseCompatibilityConfig();
      expect(config.isPostgreSQL).toBe(false);
      expect(config.dateFieldHandling.avoidDateFormatting).toBe(false);
    });

    it('should include all necessary date fields', () => {
      const config = getDatabaseCompatibilityConfig();
      const dateFields = config.dateFieldHandling.rawDateFields;
      
      expect(dateFields).toContain('eventDate');
      expect(dateFields).toContain('createdAt');
      expect(dateFields).toContain('modifiedAt');
      expect(dateFields).toContain('validFrom');
      expect(dateFields).toContain('validTo');
      expect(dateFields).toContain('lastUsed');
      expect(dateFields).toContain('expiresAt');
      expect(dateFields).toContain('deployedAt');
      expect(dateFields).toContain('seenAt');
      expect(dateFields).toContain('dismissedAt');
      expect(dateFields).toContain('snoozeUntil');
    });
  });

  describe('processOrderByForCompatibility', () => {
    describe('with SQLite (default)', () => {
      it('should not modify orderBy clauses', () => {
        const orderBy = [
          { ref: ['eventDate'], sort: 'desc' },
          { ref: ['name'], sort: 'asc' }
        ];
        
        const result = processOrderByForCompatibility(orderBy);
        expect(result).toBe(orderBy); // Should return same reference
      });
    });

    describe('with PostgreSQL', () => {
      const postgresConfig = {
        isPostgreSQL: true,
        dateFieldHandling: {
          avoidDateFormatting: true,
          rawDateFields: ['eventDate', 'createdAt', 'modifiedAt']
        }
      };

      it('should clean date field references', () => {
        const orderBy = [
          { ref: ['eventDate'], sort: 'desc' },
          { ref: ['name'], sort: 'asc' },
          { ref: ['createdAt'], sort: 'asc' }
        ];
        
        const result = processOrderByForCompatibility(orderBy, postgresConfig);
        
        expect(result).toEqual([
          { ref: ['eventDate'], sort: 'desc' },
          { ref: ['name'], sort: 'asc' },
          { ref: ['createdAt'], sort: 'asc' }
        ]);
        
        // Should be different object references for date fields
        expect(result[0]).not.toBe(orderBy[0]);
        expect(result[1]).toBe(orderBy[1]); // Non-date field unchanged
        expect(result[2]).not.toBe(orderBy[2]);
      });

      it('should handle complex orderBy structures', () => {
        const orderBy = [
          { ref: ['eventDate', 'formatted'], sort: 'desc' },
          { ref: ['status'] },
          { ref: ['modifiedAt'], sort: 'asc', someOtherProp: 'value' }
        ];
        
        const result = processOrderByForCompatibility(orderBy, postgresConfig);
        
        expect(result).toEqual([
          { ref: ['eventDate'], sort: 'desc' }, // Simplified
          { ref: ['status'] }, // Unchanged
          { ref: ['modifiedAt'], sort: 'asc' } // Extra props removed
        ]);
      });

      it('should handle null/undefined orderBy', () => {
        expect(processOrderByForCompatibility(null as any, postgresConfig)).toBeNull();
        expect(processOrderByForCompatibility(undefined as any, postgresConfig)).toBeUndefined();
      });

      it('should handle empty orderBy array', () => {
        const result = processOrderByForCompatibility([], postgresConfig);
        expect(result).toEqual([]);
      });

      it('should preserve sort direction or default to desc', () => {
        const orderBy = [
          { ref: ['eventDate'] },
          { ref: ['createdAt'], sort: 'asc' },
          { ref: ['modifiedAt'], sort: 'desc' }
        ];
        
        const result = processOrderByForCompatibility(orderBy, postgresConfig);
        
        expect(result[0].sort).toBe('desc'); // Default
        expect(result[1].sort).toBe('asc');
        expect(result[2].sort).toBe('desc');
      });
    });
  });

  describe('isPostgreSQL', () => {
    it('should return false for SQLite', () => {
      expect(isPostgreSQL()).toBe(false);
    });
  });
});