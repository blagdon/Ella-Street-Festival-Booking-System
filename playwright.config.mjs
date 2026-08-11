// Playwright config for the accessibility regression suite (e2e/).
//
// Deliberately separate from tests/ (node:test's integration suite): those
// files are picked up by node's *.test.mjs auto-discovery, and mixing runners
// in one directory invites node --test trying (and failing) to load a
// Playwright spec. e2e/ is never scanned by `npm run test:integration`.
//
// Two phases, run separately (see each spec file's own header):
//   - "public" (npm run test:a11y): pages needing no auth/backend at all.
//     Safe for any contributor to run with zero secrets configured.
//   - "setup" + "admin" (npm run test:a11y:admin): the 17 auth-gated admin
//     pages. Needs .env.test (the same disposable test Supabase project
//     tests/*.test.mjs uses) - admin.setup.mjs hard-fails if it's missing.
import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

// Harmless no-op if .env.test doesn't exist - only the "admin"/"setup"
// projects actually need these vars, and they hard-fail with a clear error
// if they're missing rather than this file crashing for every contributor
// who just wants to run the no-auth "public" suite.
if (fs.existsSync('.env.test')) {
  process.loadEnvFile('.env.test');
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // CI keeps the 'line' reporter for a readable live log and adds 'html' so
  // a failure leaves a browsable report behind - previously CI generated no
  // report at all, only the raw log. Local runs are unaffected (still just
  // 'list') - this is diagnostics for CI failures specifically, not a
  // change to the everyday local dev workflow.
  reporter: process.env.CI ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
    // Screenshot/video were never configured before (Playwright defaults
    // both to 'off'), so a CI failure had nothing but the trace - and the
    // trace itself was never uploaded anywhere either (see ci.yml). Both
    // are failure-only, matching trace's own policy, so a normal green run
    // costs nothing extra.
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // Reuses `npm run dev` (scripts/dev-server.mjs) - the same static server
  // used for manual local testing throughout this project. Locally, reuses
  // an already-running instance rather than fighting it for the port; in CI
  // there's never one already running, so it always starts fresh.
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    // Unanchored substring matches are a trap here: "admin-accessibility.spec.mjs"
    // contains "accessibility.spec.mjs", so a loose /accessibility\.spec\.mjs/
    // pattern silently pulls the auth-gated suite into this unauthenticated
    // project too - every page then just redirects to login.html and "passes"
    // against that instead of the real page, with no error to say so. Anchored
    // to a path separator immediately before the filename to rule that out.
    { name: 'public', testMatch: /\/accessibility\.spec\.mjs$/ },
    { name: 'setup', testMatch: /\/admin\.setup\.mjs$/ },
    {
      name: 'admin',
      testMatch: /\/(admin-accessibility|focus-trap|provisioning|event-configuration|public-booking-routing|event-page-cta|settings-secrets|tenant-identity|steward-tenant-isolation|steward-login-race|settings-system-constants|stats-dev-exclusion)\.spec\.mjs$/,
      dependencies: ['setup'],
      use: { storageState: 'e2e/.auth/admin.json' },
    },
  ],
});
