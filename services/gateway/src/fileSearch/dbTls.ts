/**
 * Connection options for the file-search PostgreSQL.
 *
 * FILE_SEARCH_DATABASE_CA (a PEM certificate) is set only for an external database, by
 * setup-kyma.js in its external database mode. Unset - the PostgreSQL that Docker and Kyma deploy
 * themselves, which speaks no TLS - the options are the connection string alone, as before.
 *
 * With a CA the connection is encrypted and the server certificate must chain to that CA. The
 * host name is not compared: a service binding gives the database's IP address, while its
 * certificate names a host (verify-ca in libpq terms). The trust anchor is the CA of that one
 * instance, which the binding delivers.
 */
export interface FileSearchConnectionOptions {
  connectionString: string;
  ssl?: { ca: string; rejectUnauthorized: true; checkServerIdentity: (host: string, cert: unknown) => undefined };
}

/** Query parameters of a DSN that set TLS; they would override the `ssl` option in node-postgres. */
const DSN_TLS_PARAMETERS = new Set(['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl', 'uselibpqcompat']);

function withoutTlsParameters(connectionString: string): string {
  const at = connectionString.indexOf('?');
  if (at === -1) return connectionString;
  const kept = connectionString.slice(at + 1).split('&')
    .filter((pair) => pair !== '' && !DSN_TLS_PARAMETERS.has(pair.split('=')[0].toLowerCase()));
  return kept.length > 0 ? `${connectionString.slice(0, at)}?${kept.join('&')}` : connectionString.slice(0, at);
}

export function connectionOptions(
  connectionString: string, env: Record<string, string | undefined> = process.env,
): FileSearchConnectionOptions {
  const ca = env.FILE_SEARCH_DATABASE_CA;
  if (!ca || ca.trim() === '') return { connectionString };
  return {
    connectionString: withoutTlsParameters(connectionString),
    ssl: { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined },
  };
}
