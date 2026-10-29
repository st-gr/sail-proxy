#!/usr/bin/env node
// node stack/browser-login.mjs [url]: opens the recorder's own browser profile (out/browser-profile) in a visible
// window at GitHub's sign-in, for the maintainer to sign in by hand once; closing the window keeps the session for
// the recordings (SAIL_DOCS_BROWSER_PROFILE=screencast/out/browser-profile). No password passes through here.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../lib/browser.mjs';

const profile = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'browser-profile');
const { browser, page } = await openBrowser({ width: 1280, height: 900, scale: 1, headless: false, userDataDir: profile });
await page.goto(process.argv[2] || 'https://github.com/login');
console.log(`profile ${profile}: sign in, then close the window`);
await new Promise((r) => browser.on('disconnected', r));
