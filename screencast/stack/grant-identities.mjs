// Grants the demo identities their roles in the rendered docker/.env.auth: the admin's local identity
// provider maps an e-mail to a role through LOCAL_USER_MAPPING (and ROLE_MAPPING for group lookups).
// Usage: node screencast/stack/grant-identities.mjs   (then recreate the admin container)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS = ['LOCAL_USER_MAPPING', 'ROLE_MAPPING'];

export function mergeMappings(envText, identities) {
  const grants = { [identities.admin.email]: 'admin' };
  for (const u of identities.users) grants[u.email] = 'user';
  let text = envText;
  for (const key of KEYS) {
    const re = new RegExp(`^${key}=(.*)$`, 'm');
    const m = re.exec(text);
    const merged = JSON.stringify({ ...grants, ...(m ? JSON.parse(m[1]) : {}) });
    const line = `${key}=${merged}`;
    if (m) text = text.replace(re, () => line);
    else text += `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
  }
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const identities = JSON.parse(readFileSync(join(here, '..', 'identities.json'), 'utf8'));
  const file = join(here, '..', '..', 'docker', '.env.auth');
  writeFileSync(file, mergeMappings(readFileSync(file, 'utf8'), identities));
  console.log(`granted ${identities.users.length + 1} identities in docker/.env.auth`);
}
