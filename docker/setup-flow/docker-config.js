'use strict';
/**
 * Reads back the configuration docker/setup-docker.js wrote under docker/: docker/.env,
 * .env.docker, .env.nginx, .env.auth and dex.config.yaml. Raw and Docker-shaped - placeholders
 * are returned as found; each script maps the values onto its own questions (setup-docker's
 * re-run, setup-kyma's values shared with Docker). Read-only; values are never printed.
 */

const fs = require('fs');
const path = require('path');

/** KEY=VALUE lines, as setup-docker.js parses them (trimmed, no quote handling). */
function parseEnvText(content) {
  const envVars = {};
  for (const line of content.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;
    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex > 0) {
      envVars[trimmedLine.substring(0, separatorIndex).trim()] = trimmedLine.substring(separatorIndex + 1).trim();
    }
  }
  return envVars;
}

function readText(dockerDir, name) {
  const filePath = path.join(dockerDir, name);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

/**
 * @param {string} dockerDir  the docker/ directory
 * @returns {object} POSTGRES_USER, IDENTITY_PROVIDER, groups ({ admin, user }: the first group
 *   ROLE_MAPPING maps to each role), LOGOUT_REDIRECT_URL, BASE_URL, GITHUB_CLIENT_ID,
 *   GITHUB_CLIENT_SECRET, GITHUB_ORG, OKTA_SSO_URL, LDAP_HOST, LDAP_BIND_DN, LDAP_BIND_PASSWORD,
 *   LDAP_USER_BASE_DN, LDAP_GROUP_BASE_DN, DOCKER_REGISTRY, DOCKER_ORGANIZATION,
 *   DOCKER_IMAGE_MODE; undefined where a file or key is missing
 */
function readDockerConfigValues(dockerDir) {
  const dockerEnv = parseEnvText(readText(dockerDir, '.env'));
  const imageEnv = parseEnvText(readText(dockerDir, '.env.docker'));
  const nginxEnv = parseEnvText(readText(dockerDir, '.env.nginx'));
  const authEnv = parseEnvText(readText(dockerDir, '.env.auth'));
  const dex = readText(dockerDir, 'dex.config.yaml');
  // A scalar after `key:`, without a trailing ` # comment` and surrounding quotes.
  const yamlValue = (key) => {
    const match = dex.match(new RegExp(`^\\s*${key}:[ \\t]*(.*)$`, 'm'));
    if (!match) return undefined;
    const value = match[1].replace(/\s+#.*$/, '').trim();
    const quoted = value.match(/^(["'])(.*)\1$/);
    return quoted ? quoted[2] : value;
  };

  const groups = {};
  try {
    for (const [group, role] of Object.entries(JSON.parse(authEnv.ROLE_MAPPING || '{}'))) {
      if (!groups[role]) groups[role] = group;
    }
  } catch {
    // An unreadable mapping yields no groups.
  }
  // The GitHub organization is the only `- name:` entry (under connectors → config → orgs).
  const org = (dex.match(/^\s*- name:[ \t]*(.*)$/m) || [])[1];

  return {
    POSTGRES_USER: dockerEnv.POSTGRES_USER,
    IDENTITY_PROVIDER: authEnv.IDENTITY_PROVIDER,
    groups: { admin: groups.admin, user: groups.user },
    LOGOUT_REDIRECT_URL: nginxEnv.LOGOUT_REDIRECT_URL,
    BASE_URL: nginxEnv.BASE_URL,
    GITHUB_CLIENT_ID: yamlValue('clientID'),
    GITHUB_CLIENT_SECRET: yamlValue('clientSecret'),
    GITHUB_ORG: org === undefined ? undefined : org.trim(),
    OKTA_SSO_URL: yamlValue('ssoURL'),
    LDAP_HOST: authEnv.LDAP_HOST,
    LDAP_BIND_DN: authEnv.LDAP_BIND_DN,
    LDAP_BIND_PASSWORD: authEnv.LDAP_BIND_PASSWORD,
    LDAP_USER_BASE_DN: authEnv.LDAP_USER_BASE_DN,
    LDAP_GROUP_BASE_DN: authEnv.LDAP_GROUP_BASE_DN,
    DOCKER_REGISTRY: imageEnv.DOCKER_REGISTRY,
    DOCKER_ORGANIZATION: imageEnv.DOCKER_ORGANIZATION,
    DOCKER_IMAGE_MODE: imageEnv.DOCKER_IMAGE_MODE
  };
}

/** Whether ldap .env.auth names an external server (a local one keeps the LDAP_HOST placeholder). */
function isExternalLdap(values) {
  return Boolean(values.LDAP_HOST) && values.LDAP_HOST !== 'LDAP_HOST';
}

/** Docker pulls from a registry: the explicit marker, or anything but the local-build default. */
function usesImageRegistry(values) {
  return values.DOCKER_IMAGE_MODE === 'registry' ||
    values.DOCKER_REGISTRY !== 'ghcr.io' || values.DOCKER_ORGANIZATION !== 'st-gr';
}

/** The team part of a GitHub "<org>:<team>" group, or undefined. */
function githubTeam(org, group) {
  return group && group.startsWith(`${org}:`) ? group.slice(org.length + 1) : undefined;
}

module.exports = { readDockerConfigValues, parseEnvText, isExternalLdap, usesImageRegistry, githubTeam };
