// test/setupTests.ts keeps the product S3 keys out of every test, even after an import's
// dotenv.config() has put them back (as modelService.ts / sapAIService.ts do from the gateway .env).
// Simulated here with a real dotenv.config() at module load, from a throwaway file of fake values.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-s3-keys-'));
const envFile = path.join(dir, '.env');
fs.writeFileSync(envFile, 'FILE_SEARCH_S3_ACCESS_KEY_ID=AKIDLOADTIME\nFILE_SEARCH_S3_SECRET_ACCESS_KEY=load-time-secret\n');
dotenv.config({ path: envFile });
const reAddedAtLoad = process.env.FILE_SEARCH_S3_ACCESS_KEY_ID;
fs.rmSync(dir, { recursive: true, force: true });

describe('the product S3 keys inside tests', () => {
  it('are undefined although a module-load dotenv.config() re-added them', () => {
    expect(reAddedAtLoad).toBe('AKIDLOADTIME');
    expect(process.env.FILE_SEARCH_S3_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.FILE_SEARCH_S3_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('are undefined again in the next test after one set them', () => {
    process.env.FILE_SEARCH_S3_ACCESS_KEY_ID = 'AKIDINTEST';
    expect(process.env.FILE_SEARCH_S3_ACCESS_KEY_ID).toBe('AKIDINTEST');
  });

  it('(the next test)', () => {
    expect(process.env.FILE_SEARCH_S3_ACCESS_KEY_ID).toBeUndefined();
  });
});
