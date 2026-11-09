#!/usr/bin/env node
// node stack/n8n-sign-in.mjs: signs the recorder's browser profile (out/browser-profile) in to the local n8n
// (sail-n8n on 127.0.0.1:5678) with the owner in N8N_EMAIL / N8N_PASSWORD (out/n8n-owner.env, a generated test
// login), switches n8n to its light theme and closes the chat panel with a fresh chat session, so video 06 records
// n8n without a sign-in on camera and starts from "Open chat" (SAIL_DOCS_BROWSER_PROFILE=screencast/out/browser-profile).
// Run it before every take: n8n remembers an open panel in the profile. Prints nothing but the outcome.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../lib/browser.mjs';

const { N8N_EMAIL, N8N_PASSWORD, N8N_URL = 'http://127.0.0.1:5678' } = process.env;
if (!N8N_EMAIL || !N8N_PASSWORD) throw new Error('set N8N_EMAIL and N8N_PASSWORD (source screencast/out/n8n-owner.env)');
const profile = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'browser-profile');
const { browser, page } = await openBrowser({ width: 1280, height: 900, scale: 1, userDataDir: profile });
try {
  await page.goto(`${N8N_URL}/signin`, { waitUntil: 'networkidle2' });
  // A signed-in profile passes through /signin before n8n redirects it: type only once the form is really there.
  const form = page.url().includes('/signin') && await page.waitForSelector('input[type="email"]', { timeout: 15000 }).catch(() => null);
  if (form && page.url().includes('/signin')) {
    await page.type('input[type="email"]', N8N_EMAIL);
    await page.type('input[type="password"]', N8N_PASSWORD);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.keyboard.press('Enter')]);
  }
  await page.evaluate(() => { localStorage.setItem('N8N_THEME', 'light'); localStorage.removeItem('N8N_LOGS_PANEL_OPEN'); localStorage.removeItem('n8n-chat/sessionId'); });
  await page.goto(`${N8N_URL}/home/workflows`, { waitUntil: 'networkidle2' });
  if (page.url().includes('/signin')) throw new Error('n8n sign-in failed');
  console.log(`n8n signed in for profile ${profile}`);
} finally {
  await browser.close();
}
