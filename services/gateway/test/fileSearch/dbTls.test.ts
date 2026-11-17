/**
 * TLS for the file-search database (an external PostgreSQL, setup-kyma.js external database mode).
 * With FILE_SEARCH_DATABASE_CA unset - every Docker, in-cluster Kyma and local installation, whose
 * PostgreSQL speaks no TLS - the pool options must be exactly what they were before.
 */
import { describe, it, expect } from '@jest/globals';
import { connectionOptions } from '../../src/fileSearch/dbTls';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBexampleCA\n-----END CERTIFICATE-----\n';
const DSN = 'postgresql://file_search_app:pw-0001@postgres:5432/sap_llm_gateway';

describe('connectionOptions', () => {
  it.each([
    ['unset', {}],
    ['empty', { FILE_SEARCH_DATABASE_CA: '' }],
    ['blank', { FILE_SEARCH_DATABASE_CA: '  \n' }],
  ])('CA %s: only the connection string, unchanged (no TLS setting is added)', (_n, env) => {
    expect(connectionOptions(DSN, env)).toEqual({ connectionString: DSN });
    const external = 'postgresql://u:p@203.0.113.7:5432/Db?sslmode=no-verify';
    expect(connectionOptions(external, env)).toEqual({ connectionString: external });
  });

  it('with a CA: the server certificate is checked against it, the host name is not, and the DSN\'s own TLS settings are dropped', () => {
    const options = connectionOptions('postgresql://u:p%40x@203.0.113.7:5432/Db?sslmode=no-verify&application_name=gw&sslrootcert=/x&uselibpqcompat=true', { FILE_SEARCH_DATABASE_CA: CA });
    // A connection string's TLS settings would override the ssl option in node-postgres.
    expect(options.connectionString).toBe('postgresql://u:p%40x@203.0.113.7:5432/Db?application_name=gw');
    expect(options.ssl).toMatchObject({ ca: CA, rejectUnauthorized: true });
    // The binding gives an IP address; the certificate names a host. Trust is the CA.
    expect(options.ssl!.checkServerIdentity('203.0.113.7', {} as any)).toBeUndefined();
  });

  it('with a CA and no query string: the DSN stays as it is', () => {
    const options = connectionOptions('postgresql://u:p@203.0.113.7:5432/Db', { FILE_SEARCH_DATABASE_CA: CA });
    expect(options.connectionString).toBe('postgresql://u:p@203.0.113.7:5432/Db');
    expect(options.ssl).toBeDefined();
  });

  it('with a CA and only TLS settings in the query: no dangling question mark', () => {
    expect(connectionOptions('postgresql://u:p@h:5432/Db?sslmode=no-verify', { FILE_SEARCH_DATABASE_CA: CA }).connectionString).toBe('postgresql://u:p@h:5432/Db');
  });
});
