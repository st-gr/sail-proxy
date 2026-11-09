'use strict';

// The Plugins journey's fixtures, through the admin's /api/plugins. Only the plugins-app run seeds them,
// and the purge only touches plugins whose id starts with PREFIX.

const { strToU8, zipSync } = require('fflate');

const PREFIX = 'uiFixture-';
const ID = `${PREFIX}masker`;
const UPLOAD_ID = `${PREFIX}uploaded`;
// A "{" would be a binding and "<b>" markup if the screen treated package text as anything but text.
const SUMMARY = 'Invented fixture {not a binding} <b>not bold</b>';

function zipOf(id, version, gateway = '*') {
  const manifest = { id, version, runtime: 'node', gateway, help: { en: { summary: SUMMARY } } };
  return Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'index.js': strToU8('module.exports = [];') }));
}

function pluginsClient(adminUrl, credentials) {
  const authorization = 'Basic ' + Buffer.from(credentials).toString('base64');
  const send = async (method, path, contentType, body) => fetch(`${adminUrl}/api/plugins${path}`, {
    method,
    headers: { Authorization: authorization, Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}) },
    body
  });
  const call = async (method, path, contentType, body) => {
    const response = await send(method, path, contentType, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} /api/plugins${path} -> ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  return { send, call };
}

async function purgePlugins(adminUrl, credentials) {
  const { call } = pluginsClient(adminUrl, credentials);
  const list = await call('GET', '');
  for (const plugin of list.plugins.filter((p) => p.id.startsWith(PREFIX))) {
    if (plugin.enabledVersion) await call('POST', `/${plugin.id}/disable`, 'application/json', '{}');
    for (const { version } of plugin.versions) await call('DELETE', `/${plugin.id}/versions/${encodeURIComponent(version)}`);
  }
}

async function seedPlugins(adminUrl, credentials) {
  const { send, call } = pluginsClient(adminUrl, credentials);
  await call('POST', '', 'application/zip', zipOf(ID, '1.0.0'));
  await call('POST', '', 'application/zip', zipOf(ID, '1.1.0'));
  await call('POST', '', 'application/zip', zipOf(ID, '9.0.0', '>=999.0.0'));
  // The journey checks the screen shows the server's own words, so it asks the server for them.
  const refused = await send('POST', '', 'application/zip', Buffer.from('this is not a zip file'));
  const { message } = await refused.json();
  return { id: ID, uploadId: UPLOAD_ID, summary: SUMMARY, refusedMessage: message, uploadBase64: zipOf(UPLOAD_ID, '2.0.0').toString('base64') };
}

module.exports = { purgePlugins, seedPlugins };
