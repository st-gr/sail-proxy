'use strict';
/**
 * An installation that uses a PostgreSQL outside the cluster (setup-kyma.js --external-database
 * <secret>): SAP BTP "PostgreSQL, hyperscaler option", or any PostgreSQL the Secret describes.
 *
 * The Secret is what a service binding of that service creates in the namespace: hostname, port,
 * dbname, username, password and sslrootcert (the server CA, PEM). The service refuses
 * unencrypted connections, so the CA is required.
 *
 * The connections are encrypted and the server certificate must chain to that CA. The host name
 * is not compared (verify-ca in libpq terms): the binding's hostname is an IP address while the
 * certificate names a host. The setup hands the CA to both database clients, which do the check:
 * the gateway's file search connections (services/gateway/src/fileSearch/dbTls.ts,
 * FILE_SEARCH_DATABASE_CA) and the admin service's CAP connection (services/admin/.cdsrc.js,
 * cds.requires.db.credentials.sslrootcert).
 */
const https = require('https');
const { readResourceData } = require('./kubectl-read');

/** The first of `keys` the Secret holds a non-empty value for. */
function pick(data, keys) {
  for (const key of keys) {
    if (typeof data[key] === 'string' && data[key].trim() !== '') return data[key];
  }
  return undefined;
}

/**
 * The database a binding Secret describes. Throws an error that names the Secret and the missing
 * key, never a value.
 * @returns {{ secretName: string, host: string, port: number, name: string, user: string, password: string, ca: string }}
 */
function readExternalDatabase(runKubectl, namespace, secretName) {
  const data = readResourceData(runKubectl, 'secret', secretName, namespace);
  if (!data) {
    throw new Error(`Secret ${secretName} was not found in namespace ${namespace}. Create the service binding there first; --external-database takes the name of its Secret.`);
  }
  const fields = {
    host: ['hostname', 'host'],
    port: ['port'],
    name: ['dbname', 'database'],
    user: ['username', 'user'],
    password: ['password'],
    ca: ['sslrootcert', 'server_ca'],
  };
  const db = { secretName };
  for (const [field, keys] of Object.entries(fields)) {
    const value = pick(data, keys);
    if (value === undefined) {
      throw new Error(`Secret ${secretName} in namespace ${namespace} has no ${keys[0]}; an external database needs hostname, port, dbname, username, password and sslrootcert.`);
    }
    db[field] = field === 'ca' || field === 'password' ? value : value.trim();
  }
  if (!/^\d{1,5}$/.test(db.port) || Number(db.port) < 1 || Number(db.port) > 65535) {
    throw new Error(`Secret ${secretName} in namespace ${namespace} has a port that is no TCP port number.`);
  }
  db.port = Number(db.port);
  if (!/^[A-Za-z0-9.-]+$/.test(db.host)) {
    throw new Error(`Secret ${secretName} in namespace ${namespace} has a hostname that is no host name or IP address.`);
  }
  return db;
}

/** `host:port/database`, the part of a connection string after the credentials. */
function databaseAddress(db) {
  return db ? `${db.host}:${db.port}/${encodeURIComponent(db.name)}` : 'postgres:5432/sap_llm_gateway';
}

/**
 * What a node-postgres connection string needs to encrypt the connection. With the CA set, which
 * the setup always writes beside the connection string, the gateway drops this parameter and
 * verifies the certificate instead (dbTls.ts). Without the CA, for example after someone removed
 * it from the Secret by hand, the connection is still encrypted but the certificate is not checked.
 */
function connectionStringOptions(db) {
  return db ? '?sslmode=no-verify' : '';
}

/**
 * The Secret name given with `--external-database <name>` or `--external-database=<name>`, or
 * null without the flag. Throws when the flag has no value or the value is no Secret name.
 */
function parseExternalDatabaseArg(args) {
  const FLAG = '--external-database';
  let value = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === FLAG) {
      value = args[i + 1] === undefined || args[i + 1].startsWith('-') ? '' : args[i + 1];
    } else if (args[i].startsWith(`${FLAG}=`)) {
      value = args[i].slice(FLAG.length + 1);
    }
  }
  if (value === null) return null;
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(value)) {
    throw new Error(`${FLAG} needs the name of the service binding Secret in the namespace, for example ${FLAG} postgres-binding`);
  }
  return value;
}

/**
 * The call that enables an extension on an SAP BTP "PostgreSQL, hyperscaler option" instance. The
 * service user is no superuser and cannot run CREATE EXTENSION itself; SAP's service API does it,
 * authenticated with the client certificate the binding carries (observed 2026-11-10: PUT ->
 * 201 {"status":"succeeded"}). Returns null for a Secret that is no such binding.
 */
function extensionRequest(binding, extension = 'vector') {
  const { instance_guid: instance, dbname, clientcert, clientkey, urls } = binding || {};
  if (!instance || !dbname || !clientcert || !clientkey || !urls) return null;
  let api;
  try {
    api = JSON.parse(urls).api_server;
  } catch {
    return null;
  }
  if (typeof api !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(api)) return null;
  if (!/^[A-Za-z0-9-]+$/.test(instance)) return null;
  return {
    url: `${api.replace(/\/$/, '')}/v1/postgresql-db/instances/${instance}/extensions/${extension}`,
    body: JSON.stringify({ database: dbname }),
    cert: clientcert,
    key: clientkey
  };
}

/** PUT with a client certificate; resolves { status, body }. */
function httpsPut({ url, body, cert, key }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'PUT', cert, key, timeout: 120000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer within 120 seconds')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Enable the vector extension (file search needs it) for the database of an SAP binding.
 * { status: 'skipped' } for any other Secret; throws an error that carries the HTTP status or
 * the network error, never the certificate, the key or the answer's text.
 */
async function enableVectorExtension(binding, { request = httpsPut } = {}) {
  const call = extensionRequest(binding);
  if (!call) return { status: 'skipped' };
  let answer;
  try {
    answer = await request(call);
  } catch (error) {
    throw new Error(`the service API could not be reached (${error && error.code ? error.code : 'network error'})`);
  }
  if (answer.status < 200 || answer.status >= 300) throw new Error(`the service API answered HTTP ${answer.status}`);
  return { status: 'enabled' };
}

module.exports = {
  readExternalDatabase, databaseAddress, connectionStringOptions, parseExternalDatabaseArg,
  extensionRequest, enableVectorExtension
};
