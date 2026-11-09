namespace sap.llm.gateway.admin;

using { managed } from '@sap/cds/common';

/**
 * Installed gateway plugins (spec 2026-11-04 §5, §7). The store of record on Docker and Kyma:
 * one row per uploaded package version, the zip kept as base64 so that it travels with the
 * database backups. Neither entity is exposed through an OData service; they are read and
 * written by services/pluginStore.ts only.
 */
entity PluginPackages : managed {
  key pluginId  : String(64);
  key version   : String(64);
  sha256        : String(64) not null;   // of the raw zip, lower-case hex
  manifest      : LargeString;           // manifest.json as uploaded (JSON text)
  contentBase64 : LargeString;           // the zip; never selected by a list
  sizeBytes     : Integer;
}

/** The enabled version of a plugin; no row, or a null version, means disabled. */
entity PluginStates : managed {
  key pluginId   : String(64);
  enabledVersion : String(64);
}
