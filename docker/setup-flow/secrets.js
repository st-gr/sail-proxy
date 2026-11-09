'use strict';
/**
 * Secret steps for the setup scripts: keep, replace or generate a secret, and the warnings
 * shown before a stored key is regenerated.
 */

const { displayValue } = require('./session');

const KEEP = 'keep';
const NEW = 'new';
const GENERATE = 'generate';
const REGENERATE = 'regenerate';
const DONE = '__done__';
const KEY_REGENERATION_ID = 'key-regeneration';

/**
 * What breaks when an existing value is replaced by a freshly generated one. Each consequence
 * was confirmed in the code named in the comment above the key.
 */
const KEY_WARNINGS = {
  // services/admin/src/utils/awsSecretCrypto.ts: stored AWS secret access keys are encrypted
  // with this key (getEncryptionKey); rows written under the old key cannot be decrypted.
  AWS_SECRET_ENCRYPTION_KEY:
    'Stored AWS credentials were encrypted with the current key and become unreadable. They must be entered again.',
  // services/admin/src/siem/credentialStore.ts: SIEM sink credentials are AES-GCM encrypted under
  // a key derived from this value (getMasterKey/deriveKey); a different value cannot decrypt them.
  SIEM_CREDENTIAL_KEY:
    'Stored SIEM credentials were encrypted with the current key and become unreadable. They must be entered again.',
  // services/admin/src/services/connectionCredentialStore.ts: connection credentials are AES-GCM
  // encrypted under a key derived from this value (getMasterKey/deriveKey).
  CONNECTION_CREDENTIAL_KEY:
    'Stored connection credentials were encrypted with the current key and become unreadable. They must be entered again.',
  // services/admin/src/middleware/authMiddleware.ts + services/admin/src/utils/gatewayServiceJwt.ts:
  // gateway service tokens are signed and verified with this secret, so gateway and admin must
  // hold the same value (also libs/aws-token-validation/validation-token.ts signs validation tokens
  // with it). services/gateway/src/sap/lastKnownTarget.ts: the cached last-known SAP AI
  // Core target is encrypted under a key derived from it; a copy written under another secret is
  // discarded.
  VALIDATION_TOKEN_SECRET:
    'Gateway and admin must use the same value. Tokens already issued with the current secret stop being accepted, and the cached last-known SAP AI Core target becomes unreadable.',
  // libs/aws-token-validation/secure-metadata-exchange.ts (getEncryptionKey; falls back to
  // VALIDATION_TOKEN_SECRET when unset) encrypts and HMACs credential metadata. Its only consumer
  // is the gateway's validation cache (services/gateway/src/services/enhancedValidationCache.ts,
  // extended by unifiedValidationCache.ts): entries holding sensitive fields are stored encrypted
  // in the local and Valkey cache. A decrypt failure is logged and counted as a cache miss (get()),
  // so the entry is validated again. The admin service does not read the key; setup-docker's
  // "METADATA_ENCRYPTION_KEY matches" check only keeps the two .env files consistent.
  METADATA_ENCRYPTION_KEY:
    'The gateway encrypts cached credential validation results with this key. Entries cached under the current key can no longer be read; they count as cache misses and are validated again, so requests are briefly slower. Nothing stored is lost. Gateway and admin .env files should keep the same value (the setup checks this).',
  // docker/docker-compose.yml: the postgres service takes POSTGRES_PASSWORD only when it first
  // initialises an empty data volume; an existing volume keeps the old password.
  POSTGRES_PASSWORD:
    'An existing Postgres data volume keeps its old password. The services can no longer log in unless the volume is recreated or the password is changed in the database.',
  // setup-docker.js / setup-kyma.js create the file_search_app role with this password once
  // (migration step, CREATE ROLE ... PASSWORD); an existing database keeps the old password.
  FILE_SEARCH_RUNTIME_PASSWORD:
    'An existing Postgres database keeps the old password of its file search role. File search can no longer log in unless the volume is recreated or the password is changed in the database.',
  // docker/configs/providers/*/.env.auth: oauth2-proxy signs and encrypts its session cookie
  // with OAUTH2_PROXY_COOKIE_SECRET; cookies made with the old value are rejected.
  OAUTH2_PROXY_COOKIE_SECRET:
    'Every signed-in user is signed out and has to log in again.',
  // docker/configs/providers/ldap/dex.config.yaml: the same value is the OAuth client secret of
  // the oauth2-proxy client registered in Dex; an IdP configured outside this setup must be
  // updated to the new value, otherwise sign-in fails.
  OAUTH2_PROXY_CLIENT_SECRET:
    'The OAuth client of the identity provider must be updated to the new secret, otherwise sign-in fails until it is.'
};

/**
 * Asks for one secret.
 * - no current value: a password question, as before;
 * - with one: Keep current / Enter new / Generate new (only with `generate`).
 * The secret is never shown; the review shows set / new / generated.
 * @returns {Promise<{ value: string, origin: 'kept'|'new'|'generated' }>}
 */
async function askSecret(session, { name, message, current, generate, validate }) {
  const hasCurrent = current !== undefined && current !== null && current !== '';
  const question = { type: 'password', name, message, secret: true, mask: '*', validate };

  if (!hasCurrent) {
    const answers = await session.ask({ ...question, id: name });
    return { value: answers[name], origin: 'new' };
  }

  const choices = [
    { name: 'Keep current (set)', value: KEEP },
    { name: 'Enter new', value: NEW }
  ];
  if (generate) choices.push({ name: 'Generate new', value: GENERATE });
  const picked = await session.ask({
    type: 'list',
    name,
    id: name,
    message: `${message.replace(/\s*:\s*$/, '')} is set`,
    choices,
    default: KEEP,
    review: false
  });
  const action = picked[name];

  let value;
  let origin;
  if (action === KEEP) {
    value = current;
    origin = 'kept';
  } else if (action === NEW) {
    // An empty answer would otherwise mean "keep" on the password prompt; here it is not a value.
    const newValue = {
      ...question,
      name: `${name}:new`,
      id: `${name}:new`,
      review: false,
      validate: validate || ((v) => (v ? true : 'A value is required'))
    };
    value = (await session.ask(newValue))[`${name}:new`];
    origin = 'new';
  } else {
    if (!session.generated.has(name)) session.generated.set(name, generate());
    value = session.generated.get(name);
    origin = 'generated';
  }
  session.record({
    id: name,
    label: String(message).replace(/\s*:\s*$/, ''),
    value,
    display: displayValue(question, value, {}, origin),
    secret: true,
    changed: origin !== 'kept'
  });
  return { value, origin };
}

/**
 * Re-run only: asks whether any generated key should be regenerated, each behind its warning.
 * @param {string[]} keys  the keys present in the existing configuration
 * @returns {Promise<string[]>} the keys to regenerate
 */
async function askKeyRegeneration(session, keys) {
  const picked = await session.ask({
    type: 'list',
    name: KEY_REGENERATION_ID,
    id: KEY_REGENERATION_ID,
    message: 'Generated keys',
    choices: [
      { name: 'Keep all generated keys', value: KEEP },
      { name: 'Regenerate a key…', value: REGENERATE }
    ],
    default: KEEP,
    review: false
  });
  const selected = [];
  if (picked[KEY_REGENERATION_ID] === REGENERATE) {
    for (;;) {
      const choice = (
        await session.ask({
          type: 'list',
          name: 'regenerate-key',
          message: 'Which key do you want to regenerate?',
          choices: [...keys.map((key) => ({ name: key, value: key })), { name: 'Done', value: DONE }],
          default: DONE,
          review: false
        })
      )['regenerate-key'];
      if (choice === DONE) break;
      const confirmed = (
        await session.ask({
          type: 'confirm',
          name: 'regenerate-confirm',
          message: `Regenerate ${choice}? ${KEY_WARNINGS[choice] || 'Anything encrypted or signed with the current value stops working.'}`,
          default: false,
          review: false
        })
      )['regenerate-confirm'];
      if (confirmed && !selected.includes(choice)) selected.push(choice);
    }
  }
  session.record({
    id: KEY_REGENERATION_ID,
    label: 'Regenerated keys',
    value: selected,
    display: selected.length ? selected.join(', ') : 'none',
    changed: selected.length > 0
  });
  return selected;
}

/**
 * The keys to regenerate once the login provider is known. oauth2-proxy accepts a session cookie
 * for as long as it can decrypt it (cookie expiry 168 h, no refresh against Dex), so a carried
 * cookie key would keep sessions made through the previous provider valid after a switch, with the
 * groups that provider sent (sail-proxy-test 2026-11-06: a GitHub session outlived the switch to
 * Okta). A changed provider therefore adds OAUTH2_PROXY_COOKIE_SECRET when it is carried.
 * @param {string[]} regenerateKeys  the keys already picked
 * @param {{ previous?: string, provider: string, carried: string[] }} change
 * @returns {string[]}
 */
function keysForProviderChange(regenerateKeys, { previous, provider, carried }) {
  const key = 'OAUTH2_PROXY_COOKIE_SECRET';
  if (!previous || previous === provider || !carried.includes(key) || regenerateKeys.includes(key)) {
    return regenerateKeys;
  }
  return [...regenerateKeys, key];
}

/** '********' when a value is set, '(not set)' otherwise; never the value. */
function mask(value) {
  return value === undefined || value === null || value === '' ? '(not set)' : '********';
}

module.exports = { KEY_WARNINGS, KEY_REGENERATION_ID, KEEP, DONE, askSecret, askKeyRegeneration, keysForProviderChange, mask };
