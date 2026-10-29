/** The AWS middleware copies an explicit field list three times; a team field left out of one copy is silently dropped. */
import fs from 'fs';
import path from 'path';
it('tokenBasedAwsAuth copies team and teamToolPolicy in all three places', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/middlewares/tokenBasedAwsAuth.ts'), 'utf8');
  expect(src.match(/\bteam: (unifiedResult\.data\.team|validationResult\.credentialMetadata\?\.team)\b/g)?.length).toBe(3);
  expect(src.match(/\bteamToolPolicy: (unifiedResult\.data\.teamToolPolicy|validationResult\.credentialMetadata\?\.teamToolPolicy)\b/g)?.length).toBe(3);
});
