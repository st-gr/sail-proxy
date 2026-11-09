/**
 * The Docker volumes the CI may remove before its run: the ones backupCIState saved (volume-metadata.json) and
 * restoreCIState puts back. Matching by name suffix instead removed other Compose projects' <project>_postgres_data
 * and <project>_valkey_data, which no backup covers.
 */
function volumesToRemoveBeforeCI(metadata) {
  if (!metadata) return [];
  return [metadata.postgresVolume, metadata.valkeyVolume].filter(Boolean);
}

// The volume backupCIState saves for one service: the exact name, then the CI's own Compose project (docker_),
// and only then another project's <project>_<name>; `docker volume ls` lists them alphabetically.
function pickVolumeToBackUp(volumes, baseName) {
  return volumes.find(v => v === baseName) || volumes.find(v => v === `docker_${baseName}`) || volumes.find(v => v.endsWith(`_${baseName}`));
}

module.exports = { volumesToRemoveBeforeCI, pickVolumeToBackUp };
