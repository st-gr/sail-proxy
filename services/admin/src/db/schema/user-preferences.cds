namespace sap.llm.gateway.admin;

using { cuid, managed } from '@sap/cds/common';

/**
 * User preferences and settings entity
 * Stores per-user configuration, UI state, and role-based capabilities
 */
entity UserPreferences : cuid, managed {
  // User Identity
  email         : String(255) not null;  // Primary user identifier
  displayName   : String(255);           // User's display name
  roles         : String(1000);          // JSON array of user roles
  
  // Role-based capabilities (computed from roles)
  isAdmin       : Boolean default false; // Admin role flag
  isUser        : Boolean default true;  // Regular user role flag
  canDeleteOld  : Boolean default false; // Can delete old notifications
  canManageKeys : Boolean default false; // Can manage API keys
  canManageAWS  : Boolean default false; // Can manage AWS credentials
  
  // UI Preferences
  sidePanelCollapsed    : Boolean default false; // Side navigation panel
  theme                 : String(50) default 'sap_horizon'; // UI theme
  density               : String(20) default 'cozy'; // UI density (compact/cozy)
  tablePageSize         : Integer default 50; // Default table rows per page
  
  // App-specific preferences
  defaultNotificationFilter  : String(100); // Default severity filter
  showDismissedNotifications : Boolean default false; // Show dismissed items
  autoMarkAsSeenOnView      : Boolean default true;  // Auto-mark notifications as seen
  
  // Usage Analytics preferences
  analyticsTimePeriod   : String(20) default 'month'; // Default time period selection
  analyticsCustomRange  : String(50); // Custom date range (JSON: {from: 'YYYY-MM-DD', to: 'YYYY-MM-DD'})
  
  // Personalization data (JSON)
  tablePersonalization  : String(5000); // Table column/sort preferences (JSON)
  filterPresets         : String(2000); // Saved filter combinations (JSON)
}

/**
 * Index for efficient user lookup
 */
annotate UserPreferences with {
  email @Core.Description: 'User email address (unique identifier)';
}