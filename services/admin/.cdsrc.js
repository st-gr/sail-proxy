/**
 * Certificate verification for an external PostgreSQL (setup-kyma.js external database mode).
 *
 * CAP reads this file in every process that loads the project's configuration: the admin
 * service and the schema deployment (cds-deploy) alike. It contributes nothing unless the
 * environment carries the database's CA certificate, which only that setup mode writes
 * (cds.requires.db.credentials.sslrootcert). SQLite, Docker and the in-cluster PostgreSQL on
 * Kyma - which speaks no TLS - never set it.
 *
 * With the CA, the PostgreSQL driver gets a TLS setting that requires the server certificate to
 * chain to that CA. The host name is not compared: a service binding gives the database's IP
 * address while its certificate names a host. Given the CA alone, the driver would encrypt
 * without verifying anything (rejectUnauthorized: false); credentials.ssl takes precedence.
 */
const ca = process.env['cds.requires.db.credentials.sslrootcert'];

module.exports = !ca || ca.trim() === '' ? {} : {
  requires: {
    db: {
      credentials: {
        ssl: { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined }
      }
    }
  }
};
