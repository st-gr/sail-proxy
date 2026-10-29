#!/usr/bin/env node
/**
 * The volumes the CI removes before its run (backed-up-volumes.js) are exactly the ones its backup saved and its
 * restore puts back: another Compose project's <project>_postgres_data / <project>_valkey_data is never touched.
 */
const assert = require('assert');
const { volumesToRemoveBeforeCI } = require('./backed-up-volumes');

assert.deepStrictEqual(volumesToRemoveBeforeCI({ postgresVolume: 'docker_postgres_data', valkeyVolume: 'docker_valkey_data' }), ['docker_postgres_data', 'docker_valkey_data']);
assert.deepStrictEqual(volumesToRemoveBeforeCI({ postgresVolume: 'docker_postgres_data', valkeyVolume: null }), ['docker_postgres_data'], 'only what was backed up');
assert.deepStrictEqual(volumesToRemoveBeforeCI({ postgresVolume: null, valkeyVolume: null }), [], 'first-time setup: nothing to remove');
assert.deepStrictEqual(volumesToRemoveBeforeCI(null), [], 'no backup ran: nothing to remove');
console.log('backed-up volumes: OK');

// The backup picks the CI's own volume first, whatever order `docker volume ls` lists them in.
const { pickVolumeToBackUp } = require('./backed-up-volumes');
const listed = ['abc_postgres_data', 'docker_postgres_data', 'sail-docs_postgres_data'];
assert.strictEqual(pickVolumeToBackUp(listed, 'postgres_data'), 'docker_postgres_data');
assert.strictEqual(pickVolumeToBackUp(['postgres_data', ...listed], 'postgres_data'), 'postgres_data');
assert.strictEqual(pickVolumeToBackUp(['sail-docs_postgres_data'], 'postgres_data'), 'sail-docs_postgres_data', 'another project only as the last resort');
assert.strictEqual(pickVolumeToBackUp(['other'], 'postgres_data'), undefined);
console.log('volume to back up: OK');
