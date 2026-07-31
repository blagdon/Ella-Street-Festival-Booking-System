// Playwright config for the accessibility regression suite (e2e/).
//
// Deliberately separate from tests/ (node:test's integration suite): those
// files are picked up by node's *.test.mjs auto-discovery, and mixing runners
// in one directory invites node --test trying (and failing) to load a
// Playwright spec. e2e/ is never scanned by `npm run test:integration`.
//
// Scope, for now: only pages that render fully with no authentication and no
// live Supabase connection - see e2e/accessibility.spec.mjs's own header for
// the page list and why. Testing the 17 auth-gated admin pages needs a real
// signed-in session (same test-project + test-admin pattern tests/ already
// uses) and is a deliberate follow-up, not done here.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
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
});
