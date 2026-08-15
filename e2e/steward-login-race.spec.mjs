// e2e/steward-login-race.spec.mjs
//
// Regression coverage for a defect found while diagnosing a CI-only failure
// in steward-tenant-isolation.spec.mjs (admin-accessibility-tests, run
// 31469497463): trace evidence showed handleLogin() was never invoked at
// all - the browser instead performed a native GET form submission to
// 'steward_login.html?' (steward_login.html's <form> has no method/action,
// and #email/#password have no name attributes), because
// js/page-steward-login.js only attached the submit listener at the end of
// an async init chain (Sentry loader fetch + CDN script load +
// getSession()), and a click could land on #loginBtn before that chain
// finished. Root cause: a listener-attachment race, not an auth defect.
//
// Fix: the submit listener is now attached synchronously (before any async
// work), so e.preventDefault() always wins the race regardless of timing,
// and #loginBtn stays disabled until init genuinely completes.
//
// This test reproduces the race deterministically - by holding up the
// request init depends on with page.route() until the test chooses to
// release it - rather than relying on reproducing real CI timing.
//
// Runs as part of the "admin" Playwright project purely for its
// .env.test/service-role access (auth.admin.createUser), same reasoning as
// steward-tenant-isolation.spec.mjs. Clears the inherited platform-admin
// storageState for the same reason that file does.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { service, anonKey } from '../tests/helpers.mjs';

test.use({ storageState: { cookies: [], origins: [] } });

function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const stamp = Date.now();
const steward = {
  email: `steward-login-race-${stamp}@example.test`,
  password: genTestPassword(),
  userId: null,
};

test.beforeAll(async () => {
  const { data, error } = await service.auth.admin.createUser({
    email: steward.email, password: steward.password, email_confirm: true,
  });
  if (error) throw error;
  steward.userId = data.user.id;
  await service.from('user_roles').upsert({ id: steward.userId, email: steward.email, role: 'steward' }, { onConflict: 'id' });
  await service.from('organisation_members').insert({ org_id: 'org_default', user_id: steward.userId, role: 'steward' });
});

test.afterAll(async () => {
  if (!steward.userId) return;
  await service.from('organisation_members').delete().eq('org_id', 'org_default').eq('user_id', steward.userId);
  await service.from('user_roles').delete().eq('id', steward.userId);
  await service.auth.admin.deleteUser(steward.userId);
});

test('steward login form does not fall through to native submission before async init completes', async ({ page }) => {
  // Deliberately holds up the settings fetch that gates initSentryBrowser()/
  // getSession() in page-steward-login.js's init callback, so the submit
  // listener attachment is provably still pending when the login is
  // attempted - this is the exact window the CI failure fell into.
  let releaseSettingsFetch;
  const settingsFetchGate = new Promise((resolve) => { releaseSettingsFetch = resolve; });

  // Phase 3 WP2 (20260815220000): fetchSentryBrowserLoaderUrl() now calls
  // rpc_get_public_settings(p_org_id) instead of a direct SELECT against
  // settings - anon lost direct table access entirely, replaced by this
  // parameterised RPC (see supabase-public.js). PostgREST routes RPC calls
  // through /rest/v1/rpc/<function_name>, a different path from the old
  // /rest/v1/settings table endpoint this interceptor used to match -
  // updated to the new path so the gate still actually holds up the
  // request the page's init genuinely waits on, rather than silently
  // matching nothing and letting the real request through unheld. This
  // page only ever calls this one RPC, so matching the whole path (rather
  // than the request body too) is simpler and equally scoped.
  await page.route('**/rest/v1/rpc/rpc_get_public_settings**', async (route) => {
    await settingsFetchGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/steward_login.html');
  await page.evaluate((key) => window.esfUseTestProject(key, 'steward-login-race'), anonKey);
  await page.reload();

  // A marker in page JS state: if the browser ever performs a real
  // navigation/reload, this is wiped - a more direct proof of "no
  // navigation occurred" than racing page.url() against a timeout.
  await page.evaluate(() => { window.__stewardLoginRaceMarker = true; });

  // Phase 1: init is still pending (the route above is holding the settings
  // fetch open) - the button must be disabled, and attempting to submit via
  // Enter (the standard implicit-submission path, not just a button click)
  // must not navigate anywhere.
  await expect(page.locator('#loginBtn')).toBeDisabled();

  await page.fill('#email', steward.email);
  await page.fill('#password', steward.password);

  // Bounded wait for the specific undesired event (a native navigation),
  // not an arbitrary settling sleep: this resolves the instant a navigation
  // starts, and only hits its timeout when - correctly - none occurs.
  const unwantedNavigation = page
    .waitForEvent('framenavigated', { timeout: 1000 })
    .then(() => true)
    .catch(() => false);
  await page.locator('#password').press('Enter');
  expect(await unwantedNavigation).toBe(false);

  expect(page.url()).toContain('/steward_login.html');
  expect(page.url()).not.toContain('?');
  await expect(page.locator('#loginBtn')).toBeDisabled();
  expect(await page.evaluate(() => window.__stewardLoginRaceMarker)).toBe(true);

  // Phase 2: release init. The button must become enabled once it
  // genuinely completes, with no page reload in between (marker survives).
  releaseSettingsFetch();
  await expect(page.locator('#loginBtn')).toBeEnabled();
  expect(await page.evaluate(() => window.__stewardLoginRaceMarker)).toBe(true);

  // Phase 3: now that init is ready, the normal login flow - handleLogin()
  // -> signInWithPassword() -> redirect - must still work exactly as before.
  await page.click('#loginBtn');
  await page.waitForURL('**/steward.html');
});
