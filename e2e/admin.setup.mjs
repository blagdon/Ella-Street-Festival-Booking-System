// Playwright "project dependency" setup: signs in once as the disposable
// test-project admin (same account/project tests/*.test.mjs uses) and saves
// the resulting storage state (both the test-project override in
// localStorage and the real Supabase session it produces) for
// admin-accessibility.spec.mjs to reuse across all 17 pages, instead of
// logging in per test - matching the manual browser-testing pattern used
// throughout this project's accessibility audits.
//
// Hard-fails on missing/misconfigured env, same convention as
// tests/*.test.mjs, rather than silently skipping - a green run that never
// actually checked anything is worse than a loud failure.
import { test as setup } from '@playwright/test';
import fs from 'node:fs';

const authFile = 'e2e/.auth/admin.json';

const url = process.env.TEST_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
const adminEmail = process.env.TEST_ADMIN_EMAIL;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

setup('authenticate as test admin', async ({ page }) => {
  if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
    throw new Error(`Refusing to run admin accessibility tests against a non-test project: ${url}. Populate .env.test (see scripts/seed-test-project.mjs).`);
  }
  if (!anonKey || !adminEmail || !adminPassword) {
    throw new Error('Missing TEST_SUPABASE_ANON_KEY / TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD - populate .env.test (see scripts/seed-test-project.mjs).');
  }

  await page.goto('/login.html');
  // eslint-disable-next-line no-undef -- runs in the browser via page.evaluate, not Node
  await page.evaluate((key) => window.esfUseTestProject(key, 'e2e'), anonKey);
  await page.reload();

  await page.fill('#loginEmail', adminEmail);
  await page.fill('#loginPassword', adminPassword);
  await page.click('#loginBtn');
  await page.waitForURL('**/index.html');

  fs.mkdirSync('e2e/.auth', { recursive: true });
  await page.context().storageState({ path: authFile });
});
