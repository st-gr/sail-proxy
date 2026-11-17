'use strict';
/**
 * Helpers for an OpenID Connect sign-in provider (SAP Cloud Identity Services), shared by
 * setup-docker.js and setup-kyma.js.
 */

/**
 * An OpenID Connect issuer as Dex needs it: the https URL the provider's discovery document
 * states, with no trailing slash and without the discovery path. Dex compares it character by
 * character with the provider's own value. Returns true or the complaint.
 */
function validateIssuerUrl(input) {
  const value = String(input || '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'Enter the full URL, for example https://my-tenant.accounts.ondemand.com';
  }
  if (url.protocol !== 'https:') return 'The issuer URL must start with https://';
  if (value.includes('/.well-known/')) return 'Enter the issuer itself, not the address of its discovery document (leave out /.well-known/openid-configuration)';
  if (value.endsWith('/')) return 'Enter the issuer without a trailing slash';
  if (url.search || url.hash) return 'Enter the issuer without a query string or fragment';
  return true;
}

/** A value as a double-quoted YAML scalar (JSON is YAML): safe for any character a secret may hold. */
function yamlQuoted(value) {
  return JSON.stringify(String(value === undefined || value === null ? '' : value));
}

/** The reverse of yamlQuoted for a scalar read back as text; an unquoted value is returned as is. */
function yamlUnquoted(text) {
  if (text === undefined) return undefined;
  const value = String(text).trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

module.exports = { validateIssuerUrl, yamlQuoted, yamlUnquoted };
