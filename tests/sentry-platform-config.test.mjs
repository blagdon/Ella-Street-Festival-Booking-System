// Regression tests for E5-19: Sentry is now explicitly PLATFORM-level
// infrastructure, not a per-tenant integration. Both
// supabase/functions/_shared/sentry.ts's getDsn() and supabase-public.js's
// fetchSentryBrowserLoaderUrl() used to read `settings` filtered only by
// `key` - so a second organisation's sentry_dsn/sentry_browser_loader_url
// row could make the platform lookup itself fail (PGRST116, "multiple rows"),
// silently disabling error monitoring platform-wide, or - depending on
// Postgres's row order - resolve a tenant's value instead of the platform's.
//
// Fixed by scoping both reads to `org_id = 'org_default'` explicitly, and by
// hiding both settings-UI write paths (js/settings/system.js's
// initSentrySettings(), js/page-admin.js's "Advanced" tab) from anyone who
// isn't a genuine platform admin, using the same rpc_list_switchable_
// organisations() scope check js/nav.js's org switcher already relies on.
//
// There is no dedicated Edge Function endpoint for Sentry capture itself -
// it's a side effect of every other function's own error path - so Tests
// 1-4 exercise the exact settings-query shape the fixed production code
// uses directly (the same technique that first empirically proved this bug
// during the E5-19 investigation), rather than invoking an Edge Function.
// Test 5 exercises the exact permission mechanism the settings UI itself
// now depends on to hide the Sentry controls from a tenant admin.
//
// org_default's real sentry_dsn/sentry_browser_loader_url values are live
// platform configuration in this test project (not RUN_ID-scoped, since
// org_default is the one singleton platform organisation) - captured before
// every test and restored exactly afterward, regardless of outcome. The
// "second organisation" used to prove non-interference is a genuine
// RUN_ID-scoped throwaway fixture, cleaned up normally. Every value used
// here is an inert sentinel string - never a real DSN/loader URL, and never
// sent to Sentry (these tests exercise the settings query shape directly,
// never Sentry.init()/captureException()/the browser loader script).
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service } from './helpers.mjs';

function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG_B = `e519-verify-b-${RUN_ID}`;
const TENANT_ADMIN_EMAIL = `e519-tenant-admin-${RUN_ID}@example.test`;
const TENANT_ADMIN_PASSWORD = genTestPassword();

const SENTINEL_PLATFORM_DSN = `sentinel-platform-dsn-${RUN_ID}`;
const SENTINEL_TENANT_DSN = `sentinel-tenant-dsn-${RUN_ID}`;
const SENTINEL_PLATFORM_LOADER = `sentinel-platform-loader-${RUN_ID}`;
const SENTINEL_TENANT_LOADER = `sentinel-tenant-loader-${RUN_ID}`;

let originalDsn, originalLoaderUrl;
let tenantAdminId;
let tenantAdmin, platformAdmin;

// Exact query shapes from the fixed production code.
async function getPlatformDsn() {
  return service.from('settings').select('value').eq('org_id', 'org_default').eq('key', 'sentry_dsn').single();
}
async function getPlatformLoaderUrl() {
  return service.from('settings').select('value').eq('org_id', 'org_default').eq('key', 'sentry_browser_loader_url').single();
}

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

before(async () => {
  const { error: orgErr } = await service.from('organisations')
    .insert({ id: ORG_B, name: `E5-19 Test ${ORG_B}`, slug: ORG_B, contact_email: 'owner@example.test' });
  assert.equal(orgErr, null, orgErr?.message);

  // Snapshot org_default's real values so they can be restored exactly,
  // regardless of what the tests below temporarily overwrite them with.
  const { data: dsnRow } = await service.from('settings').select('value').eq('org_id', 'org_default').eq('key', 'sentry_dsn').maybeSingle();
  originalDsn = dsnRow?.value ?? null;
  const { data: loaderRow } = await service.from('settings').select('value').eq('org_id', 'org_default').eq('key', 'sentry_browser_loader_url').maybeSingle();
  originalLoaderUrl = loaderRow?.value ?? null;

  const { data: tenantCreated, error: tenantErr } = await service.auth.admin.createUser({
    email: TENANT_ADMIN_EMAIL, password: TENANT_ADMIN_PASSWORD, email_confirm: true,
  });
  assert.equal(tenantErr, null, tenantErr?.message);
  tenantAdminId = tenantCreated.user.id;
  const { error: memberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_B, user_id: tenantAdminId, role: 'admin' });
  assert.equal(memberErr, null, memberErr?.message);

  tenantAdmin = createClient(url, anonKey);
  const { error: signInErr } = await tenantAdmin.auth.signInWithPassword({ email: TENANT_ADMIN_EMAIL, password: TENANT_ADMIN_PASSWORD });
  assert.equal(signInErr, null, signInErr?.message);

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, platformSignInErr?.message);
});

after(async () => {
  // Restore org_default's real values exactly, regardless of test outcome.
  if (originalDsn === null) {
    await service.from('settings').delete().eq('org_id', 'org_default').eq('key', 'sentry_dsn');
  } else {
    await service.from('settings').upsert({ org_id: 'org_default', key: 'sentry_dsn', value: originalDsn }, { onConflict: 'org_id,key' });
  }
  if (originalLoaderUrl === null) {
    await service.from('settings').delete().eq('org_id', 'org_default').eq('key', 'sentry_browser_loader_url');
  } else {
    await service.from('settings').upsert({ org_id: 'org_default', key: 'sentry_browser_loader_url', value: originalLoaderUrl }, { onConflict: 'org_id,key' });
  }

  await service.from('settings').delete().eq('org_id', ORG_B);
  await service.from('organisation_members').delete().eq('org_id', ORG_B);
  await service.from('organisations').delete().eq('id', ORG_B);
  if (tenantAdminId) await service.auth.admin.deleteUser(tenantAdminId);
});

describe('E5-19: Sentry is platform-level configuration (org_default only)', () => {
  test('Test 1 - the platform DSN resolves correctly when only org_default is configured', async () => {
    await service.from('settings').upsert({ org_id: 'org_default', key: 'sentry_dsn', value: SENTINEL_PLATFORM_DSN }, { onConflict: 'org_id,key' });

    const { data, error } = await getPlatformDsn();
    assert.equal(error, null, error?.message);
    assert.equal(data.value, SENTINEL_PLATFORM_DSN);
  });

  test('Test 2 (critical regression test) - a second organisation\'s sentry_dsn cannot interfere with the platform lookup', async () => {
    await service.from('settings').upsert({ org_id: 'org_default', key: 'sentry_dsn', value: SENTINEL_PLATFORM_DSN }, { onConflict: 'org_id,key' });
    await service.from('settings').upsert({ org_id: ORG_B, key: 'sentry_dsn', value: SENTINEL_TENANT_DSN }, { onConflict: 'org_id,key' });

    // The OLD unscoped query (`.eq('key','sentry_dsn').single()`) would
    // throw PGRST116 here, since two rows now exist for this key across all
    // organisations - exactly the failure this fix closes.
    const { data, error } = await getPlatformDsn();
    assert.equal(error, null, `platform lookup must not fail with a second organisation configured: ${JSON.stringify(error)}`);
    assert.equal(data.value, SENTINEL_PLATFORM_DSN, 'must resolve org_default\'s own value, never the second organisation\'s');
  });

  test('Test 3 - the anonymous browser loader lookup resolves the platform value, not a tenant\'s', async () => {
    await service.from('settings').upsert({ org_id: 'org_default', key: 'sentry_browser_loader_url', value: SENTINEL_PLATFORM_LOADER }, { onConflict: 'org_id,key' });
    await service.from('settings').upsert({ org_id: ORG_B, key: 'sentry_browser_loader_url', value: SENTINEL_TENANT_LOADER }, { onConflict: 'org_id,key' });

    const { data, error } = await getPlatformLoaderUrl();
    assert.equal(error, null, `anonymous loader lookup must not fail with a second organisation configured: ${JSON.stringify(error)}`);
    assert.equal(data.value, SENTINEL_PLATFORM_LOADER, 'must resolve org_default\'s own value, never the second organisation\'s');
  });

  test('Test 4 - missing platform configuration resolves safely (the existing "unconfigured" shape), with no crash and no tenant fallback', async () => {
    await service.from('settings').delete().eq('org_id', 'org_default').eq('key', 'sentry_dsn');
    // A second organisation's row alone must not be picked up as a fallback.
    await service.from('settings').upsert({ org_id: ORG_B, key: 'sentry_dsn', value: SENTINEL_TENANT_DSN }, { onConflict: 'org_id,key' });

    const { data, error } = await getPlatformDsn();
    // PGRST116 "no rows" is the exact, already-handled "unconfigured" shape
    // _shared/sentry.ts's own try/catch treats as cachedDsn = null - not a
    // crash, and not the second organisation's value either.
    assert.ok(error, 'expected a "no rows" result, not a resolved value from another organisation');
    assert.equal(data, null);
  });

  test('Test 5 - a tenant admin cannot be identified as a platform admin, the exact mechanism the settings UI now gates on', async () => {
    const tenantToken = await tokenFor(tenantAdmin);
    const tenantClient = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${tenantToken}` } } });
    const { data: tenantScope, error: tenantScopeErr } = await tenantClient.rpc('rpc_list_switchable_organisations');
    assert.equal(tenantScopeErr, null, tenantScopeErr?.message);
    assert.notEqual(tenantScope?.scope, 'platform_admin', 'a real tenant admin must never resolve as platform_admin - js/settings/system.js and js/page-admin.js both hide the Sentry controls based on exactly this check');

    // Regression guard: the same mechanism must still correctly recognise a
    // genuine platform admin, proving this isn't just failing closed for
    // everyone.
    const platformToken = await tokenFor(platformAdmin);
    const platformClient = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${platformToken}` } } });
    const { data: platformScope, error: platformScopeErr } = await platformClient.rpc('rpc_list_switchable_organisations');
    assert.equal(platformScopeErr, null, platformScopeErr?.message);
    assert.equal(platformScope?.scope, 'platform_admin', 'the real platform admin fixture must still resolve as platform_admin');
  });
});
