using { cuid, managed, temporal } from '@sap/cds/common';

namespace sap.llm.gateway.admin;

/**
 * Simplified API Configuration management for production
 * Uses semantic versioning only - no environment concept
 * Designed for Fiori Elements UI5 app compatibility
 */
entity ApiConfigurations : cuid, managed {
  // Basic configuration info
  name            : String(100) not null;
  version         : String(20) not null;
  description     : String(500);
  
  // Configuration data as JSON
  configData      : LargeString not null;     // Complete JSON configuration
  checksum        : String(64);               // SHA-256 checksum for integrity
  
  // Status and lifecycle
  isActive        : Boolean default false;    // Only one active configuration
  deployedAt      : Timestamp;                // When activated
  deployedBy      : String(100);              // Who activated
  rollbackReason  : String(500);              // Reason for rollback if applicable
  
  // Validation results
  isValid         : Boolean default false;
  validationErrors : LargeString;             // JSON array of validation errors
  validationWarnings : LargeString;           // JSON array of validation warnings
  lastValidated   : Timestamp;
}

// Views for Fiori Elements List Pages
@readonly
view ActiveConfiguration as select from ApiConfigurations 
  where isActive = true;

@readonly  
view ConfigurationHistory as select from ApiConfigurations {
  key ID,
  name,
  version,
  isActive,
  deployedAt,
  deployedBy,
  rollbackReason,
  createdAt,
  createdBy,
  checksum,
  isValid
} order by createdAt desc;