/**
 * The SAP settings the CI gateway gets when the run reaches SAP AI Core through the relay.
 * `base` is the relay's base URL (the SAP_RELAY_BASE secret); unset or blank means SAP is reached directly
 * and the gateway keeps the settings of its own .env. The value is never logged.
 */
function sapRelayEnv(base) {
  const root = (base || '').trim().replace(/\/+$/, '');
  if (!root) return {};
  return {
    SAP_AI_CORE_URL: `${root}/api`,
    AUTH_URL: `${root}/auth/oauth/token`,
    SAP_DEPLOYMENT_URL_BASE: `${root}/api`
  };
}

/**
 * An .env file body with the relay settings appended, for a gateway that reads its SAP settings from a file
 * rather than from the environment (the packaged CLI's ~/.sail-proxy/.env). dotenv keeps the last value of a
 * repeated key, so the appended lines win. Unset or blank `base` returns the body unchanged.
 */
function withRelayEnv(envBody, base) {
  const settings = Object.entries(sapRelayEnv(base));
  if (!settings.length) return envBody;
  const sep = envBody === '' || envBody.endsWith('\n') ? '' : '\n';
  return envBody + sep + settings.map(([k, v]) => `${k}=${v}\n`).join('');
}

module.exports = { sapRelayEnv, withRelayEnv };
