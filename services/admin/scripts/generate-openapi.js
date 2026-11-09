/**
 * Generates ../../openapi/admin-odata.json, the OpenAPI description of AdminService, from the CDS model.
 *
 * Run with `pnpm --filter admin openapi`. A unit test compares the committed file with a fresh generation.
 * Only AdminService is compiled; ValidationService is the gateway's service-to-service interface and is not described.
 * The gateway calls only ValidationService (/odata/v4/validation/...), so no AdminService operation is marked internal.
 */
const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const { compile } = require('@cap-js/openapi');

const MODEL = path.join(__dirname, '../src/srv/admin-service.cds');
const OUTPUT = path.join(__dirname, '../../../openapi/admin-odata.json');
// info.version follows the release: the root package.json is the source (cli-tools/sync-version.js keeps the file in step).
const ROOT_VERSION = require('../../../package.json').version;
// The admin is reached through the nginx prefix /admin (location /admin/odata/), CAP serves AdminService at /odata/v4/admin.
const SERVER_URL = '/admin/odata/v4/admin';

const generateAdminOpenApi = async () => {
  const model = await cds.load(MODEL);
  const doc = compile(model, { service: 'AdminService', 'openapi:url': SERVER_URL });
  // The generator leaves placeholder text in info when the service has no @title / @Core.LongDescription.
  doc.info = {
    title: 'sail-proxy admin OData API',
    description: 'OData V4 service behind the admin cockpit (AdminService), generated from the CDS model.',
    version: ROOT_VERSION
  };
  doc['x-sap-shortText'] = 'AdminService, the OData V4 API of the admin cockpit';
  // The generator emits 3.0.x (2000+ `nullable: true`, a 3.0-only keyword), so the version is kept: 3.1.0 would validate
  // but silently drop the nullability.
  return doc;
};

if (require.main === module) {
  generateAdminOpenApi().then(doc => {
    fs.writeFileSync(OUTPUT, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), OUTPUT)}`);
  }).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { generateAdminOpenApi, OUTPUT };
