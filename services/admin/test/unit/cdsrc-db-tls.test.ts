/**
 * services/admin/.cdsrc.js: certificate verification for an external PostgreSQL (setup-kyma.js
 * external database mode). CAP reads the file in every process, the schema deployment included.
 * Without the CA in the environment - every SQLite, Docker and in-cluster Kyma installation - it
 * must contribute nothing at all.
 */

const KEY = 'cds.requires.db.credentials.sslrootcert';
const CA = '-----BEGIN CERTIFICATE-----\nMIIBexampleCA\n-----END CERTIFICATE-----\n';
const saved = process.env[KEY];

function load(value: string | undefined): any {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  let conf: any;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  jest.isolateModules(() => { conf = require('../../.cdsrc.js'); });
  return conf;
}

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe('.cdsrc.js', () => {
  it.each([['unset', undefined], ['empty', ''], ['blank', ' \n']])('CA %s: an empty configuration', (_n, value) => {
    expect(load(value as string | undefined)).toEqual({});
  });

  it('with the CA: the driver gets a TLS setting that checks the certificate against it and does not compare the host name', () => {
    const conf = load(CA);
    expect(Object.keys(conf)).toEqual(['requires']);
    const ssl = conf.requires.db.credentials.ssl;
    expect(ssl).toMatchObject({ ca: CA, rejectUnauthorized: true });
    expect(ssl.checkServerIdentity('203.0.113.7', {})).toBeUndefined();
    // Nothing else of the database configuration is touched.
    expect(Object.keys(conf.requires)).toEqual(['db']);
    expect(Object.keys(conf.requires.db)).toEqual(['credentials']);
    expect(Object.keys(conf.requires.db.credentials)).toEqual(['ssl']);
  });
});
