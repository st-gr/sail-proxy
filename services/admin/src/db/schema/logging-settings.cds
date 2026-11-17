namespace sap.llm.gateway.admin;

/**
 * Logging switches and levels kept outside the configuration versions (services/loggingSettings.ts):
 * laid over the active configuration whenever it is handed to the gateway, never stored in it.
 * One row, ID 'gateway'; no row means nothing is set. A null field means "as the configuration
 * says". componentLevels is JSON { [component]: { level, until? } }; until and defaultLevelUntil are
 * the times an entry runs out. environmentFixed is the last report of the gateway's start-up request:
 * JSON of the environment variables that fix a setting, with environmentReportedAt its time.
 */
entity LoggingSettings {
  key ID                : String(20);
  logStorageEnabled     : Boolean;
  payloadCaptureEnabled : Boolean;
  defaultLevel          : String(5);
  defaultLevelUntil     : Timestamp;
  componentLevels       : LargeString;
  environmentFixed      : String(500);
  environmentReportedAt : Timestamp;
}
