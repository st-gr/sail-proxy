/**
 * PII Pseudonymization Plugin - entry point
 *
 * This file re-exports the plugin rules from the pseudonymization subdirectory.
 * The plugin loader only discovers .ts/.js files in the plugins root directory.
 */

import pluginRules = require('./pseudonymization/index');

export = pluginRules;
