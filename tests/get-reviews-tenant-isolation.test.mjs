// Regression tests for E5-26 and E5-20.
//
// E5-26: get-reviews checked admin status against the legacy global
// user_roles table alone — not even organisation_members-aware — so any
// identity holding a stale legacy user_roles admin row, with no real
// organisation membership at all, could invoke this metered, paid
// SerpApi-backed endpoint. Fixed by replacing the bare user_roles check
// with resolveCallerAdminScope() (mirrors every other closed Epic 5
// finding). The first describe() block below proves only that
// authorization boundary — WHO may call the function.
//
// E5-20 (settings-key portion only — google_reviews_cache's own tenancy
// architecture is a separate, deliberate design decision, not touched
// here): the settings query for serpapi_api_key/map_center_lat/
// map_center_lng/reviews_cache_ttl_hours had no org_id filter at all, so
// whichever organisation's row Postgres happened to return last silently
// won — an admin of Organisation A could have Organisation B's SerpApi key
// used for their own search (or vice versa). Fixed by scoping that query to
// the caller's own resolved organisation (their single organisation, or
// org_default for a platform admin — mirrors send-sms's identical E5-26
// fallback; see the code comment at the fix site for why billing the
// acting admin's own organisation, not a resource-derived one, is correct
// here). The second describe() block below proves this.
//
// Never makes a real SerpApi call, in either block: every "authorized"
// case in the first block is proven via a warm google_reviews_cache hit
// (same technique as google-reviews-cache.test.mjs), which get-reviews
// serves before it ever reaches the SerpApi key check or a live fetch. The
// E5-20 tests instead prove the settings-query scoping either by observing
// the clean "SerpApi API Key not configured" 400 response — which the
// fixed code reaches without ever calling fetch() when the CALLER's own
// organisation genuinely has no key configured, even though a *different*
// organisation does — or by replicating the exact production query shape
// directly against the settings table (the same technique already used to
// first prove this bug empirically, and to regression-test E5-19's
// identical shape of fix).
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service, callEdgeFunction } from './helpers.mjs';

function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG_A = `e526-gr-org-a-${RUN_ID}`;
const OWNER_A_EMAIL = `e526-gr-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `e526-gr-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();
const LEGACY_ONLY_EMAIL = `e526-gr-legacy-${RUN_ID}@example.test`;
const LEGACY_ONLY_PASSWORD = genTestPassword();

// E5-20 fixtures: a second organisation, distinct from ORG_A above, used to
// prove the settings query can no longer cross the tenant boundary.
const ORG_B = `e520-gr-org-b-${RUN_ID}`;
const OWNER_B_EMAIL = `e520-gr-owner-b-${RUN_ID}@example.test`;
const OWNER_B_PASSWORD = genTestPassword();
const SENTINEL_ORG_B_KEY = `sentinel-org-b-key-${RUN_ID}`;
const SENTINEL_ORG_A_LAT = '51.5074';
const SENTINEL_ORG_A_LNG = '-0.1278';
const SENTINEL_ORG_B_LAT = '55.9533';
const SENTINEL_ORG_B_LNG = '-3.1883';
const SENTINEL_ORG_A_TTL = '1';
const SENTINEL_ORG_B_TTL = '999';
const BUSINESS_KEY_UNCACHED = `e520 uncached stall ${RUN_ID}`;

const BUSINESS_KEY_OWNER = `e526 cache hit stall ${RUN_ID}`;
const BUSINESS_KEY_PLATFORM = `e526 cache hit stall platform ${RUN_ID}`;

const CACHED_PAYLOAD = {
  found: true,
  title: 'E5-26 Cache Hit Stall',
  place_id: 'e526-test-place-id',
  rating: 4.2,
  reviewsCount: 3,
  thumbnail: null,
  location: 'Hull, UK',
  reviews: [],
};

let ownerAId, stewardAId, legacyOnlyId, ownerBId;
let ownerA, stewardA, platformAdmin, legacyOnly, ownerB;

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

async function seedCache(businessKey) {
  const { error } = await service.from('google_reviews_cache').upsert({
    business_key: businessKey,
    payload: CACHED_PAYLOAD,
    fetched_at: new Date().toISOString(),
  });
  assert.equal(error, null, error?.message);
}

// Exact query shape from the fixed get-reviews/index.ts (line ~102-106) -
// proving the query behaves correctly is proving the settings-scoping half
// of the fix, the same technique used to regression-test E5-19's identical
// shape of bug.
async function getScopedSettings(orgId) {
  const { data } = await service.from('settings')
    .select('key, value')
    .eq('org_id', orgId)
    .in('key', ['serpapi_api_key', 'map_center_lat', 'map_center_lng', 'reviews_cache_ttl_hours']);
  return new Map((data ?? []).map((r) => [r.key, r.value]));
}

before(async () => {
  const { error: orgErr } = await service.from('organisations')
    .insert({ id: ORG_A, name: `E5-26 get-reviews Test ${ORG_A}`, slug: ORG_A, contact_email: 'owner@example.test' });
  assert.equal(orgErr, null, orgErr?.message);
  const { error: orgBErr } = await service.from('organisations')
    .insert({ id: ORG_B, name: `E5-20 get-reviews Test ${ORG_B}`, slug: ORG_B, contact_email: 'owner@example.test' });
  assert.equal(orgBErr, null, orgBErr?.message);

  const { data: ownerCreated, error: ownerErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerErr, null, ownerErr?.message);
  ownerAId = ownerCreated.user.id;
  const { error: memberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  assert.equal(memberErr, null, memberErr?.message);

  ownerA = createClient(url, anonKey);
  const { error: signInErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(signInErr, null, signInErr?.message);

  const { data: ownerBCreated, error: ownerBErr } = await service.auth.admin.createUser({
    email: OWNER_B_EMAIL, password: OWNER_B_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerBErr, null, ownerBErr?.message);
  ownerBId = ownerBCreated.user.id;
  const { error: memberBErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_B, user_id: ownerBId, role: 'admin' });
  assert.equal(memberBErr, null, memberBErr?.message);

  ownerB = createClient(url, anonKey);
  const { error: signInBErr } = await ownerB.auth.signInWithPassword({ email: OWNER_B_EMAIL, password: OWNER_B_PASSWORD });
  assert.equal(signInBErr, null, signInBErr?.message);

  // Org A deliberately has NO serpapi_api_key - only Org B does. The map
  // centre/TTL keys are seeded for both, with distinct sentinel values, so
  // the query-shape test can prove the fixed code never mixes them.
  const { error: settingsSeedErr } = await service.from('settings').upsert([
    { org_id: ORG_B, key: 'serpapi_api_key', value: SENTINEL_ORG_B_KEY },
    { org_id: ORG_A, key: 'map_center_lat', value: SENTINEL_ORG_A_LAT },
    { org_id: ORG_A, key: 'map_center_lng', value: SENTINEL_ORG_A_LNG },
    { org_id: ORG_A, key: 'reviews_cache_ttl_hours', value: SENTINEL_ORG_A_TTL },
    { org_id: ORG_B, key: 'map_center_lat', value: SENTINEL_ORG_B_LAT },
    { org_id: ORG_B, key: 'map_center_lng', value: SENTINEL_ORG_B_LNG },
    { org_id: ORG_B, key: 'reviews_cache_ttl_hours', value: SENTINEL_ORG_B_TTL },
  ], { onConflict: 'org_id,key' });
  assert.equal(settingsSeedErr, null, settingsSeedErr?.message);

  const { data: stewardCreated, error: stewardErr } = await service.auth.admin.createUser({
    email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD, email_confirm: true,
  });
  assert.equal(stewardErr, null, stewardErr?.message);
  stewardAId = stewardCreated.user.id;
  const { error: stewardMemberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: stewardAId, role: 'steward' });
  assert.equal(stewardMemberErr, null, stewardMemberErr?.message);

  stewardA = createClient(url, anonKey);
  const { error: stewardSignInErr } = await stewardA.auth.signInWithPassword({ email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD });
  assert.equal(stewardSignInErr, null, stewardSignInErr?.message);

  // A user with ONLY the legacy global user_roles admin row - no
  // organisation_members row at all - exactly the identity shape the OLD
  // code accepted (it never checked organisation_members) and the fixed
  // code must now reject.
  const { data: legacyCreated, error: legacyErr } = await service.auth.admin.createUser({
    email: LEGACY_ONLY_EMAIL, password: LEGACY_ONLY_PASSWORD, email_confirm: true,
  });
  assert.equal(legacyErr, null, legacyErr?.message);
  legacyOnlyId = legacyCreated.user.id;
  const { error: legacyRoleErr } = await service.from('user_roles')
    .insert({ id: legacyOnlyId, email: LEGACY_ONLY_EMAIL, role: 'admin' });
  assert.equal(legacyRoleErr, null, legacyRoleErr?.message);

  legacyOnly = createClient(url, anonKey);
  const { error: legacySignInErr } = await legacyOnly.auth.signInWithPassword({ email: LEGACY_ONLY_EMAIL, password: LEGACY_ONLY_PASSWORD });
  assert.equal(legacySignInErr, null, legacySignInErr?.message);

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, platformSignInErr?.message);

  await seedCache(BUSINESS_KEY_OWNER);
  await seedCache(BUSINESS_KEY_PLATFORM);
});

after(async () => {
  await service.from('google_reviews_cache').delete().in('business_key', [BUSINESS_KEY_OWNER, BUSINESS_KEY_PLATFORM, BUSINESS_KEY_UNCACHED]);
  await service.from('settings').delete().in('org_id', [ORG_A, ORG_B]).in('key', ['serpapi_api_key', 'map_center_lat', 'map_center_lng', 'reviews_cache_ttl_hours']);
  await service.from('organisation_members').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('organisations').delete().in('id', [ORG_A, ORG_B]);
  if (ownerAId) await service.auth.admin.deleteUser(ownerAId);
  if (stewardAId) await service.auth.admin.deleteUser(stewardAId);
  if (legacyOnlyId) {
    await service.from('user_roles').delete().eq('id', legacyOnlyId);
    await service.auth.admin.deleteUser(legacyOnlyId);
  }
  if (ownerBId) await service.auth.admin.deleteUser(ownerBId);
});

describe('E5-26: get-reviews platform/tenant authorization', () => {
  test('Test 1 - Org A\'s own admin is authorized and receives the cached result (no real SerpApi call)', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('get-reviews', { business_name: BUSINESS_KEY_OWNER }, token);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.cached, true, 'expected the warm cache entry to be served, proving no live SerpApi call happened');
    assert.equal(json.title, CACHED_PAYLOAD.title);
  });

  test('Test 2 - a non-admin (steward) is rejected outright', async () => {
    const token = await tokenFor(stewardA);
    const { status, json } = await callEdgeFunction('get-reviews', { business_name: BUSINESS_KEY_OWNER }, token);
    assert.equal(status, 403, JSON.stringify(json));
    assert.match(json.error, /Admin role required/i);
  });

  test('Test 3 - an unauthenticated caller is rejected', async () => {
    const { status, json } = await callEdgeFunction('get-reviews', { business_name: BUSINESS_KEY_OWNER }, anonKey);
    assert.equal(status, 401, JSON.stringify(json));
  });

  test('Test 4 - a genuine platform admin (org_default) is authorized and receives the cached result', async () => {
    const token = await tokenFor(platformAdmin);
    const { status, json } = await callEdgeFunction('get-reviews', { business_name: BUSINESS_KEY_PLATFORM }, token);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.cached, true);
  });

  test('Test 5 (critical regression test) - a user with ONLY the legacy global user_roles admin row is rejected (no fallback to it)', async () => {
    const token = await tokenFor(legacyOnly);
    const { status, json } = await callEdgeFunction('get-reviews', { business_name: BUSINESS_KEY_OWNER }, token);
    assert.equal(status, 403, `a legacy-only identity with no real organisation membership must be rejected, got ${status}: ${JSON.stringify(json)}`);
    assert.match(json.error, /Admin role required/i);
  });
});

describe('E5-20: get-reviews SerpApi settings tenant isolation', () => {
  test('Test 1 (critical regression test) - Org A\'s admin never picks up Org B\'s serpapi_api_key, even though Org B genuinely has one configured', async () => {
    const token = await tokenFor(ownerA);
    // BUSINESS_KEY_UNCACHED has no google_reviews_cache entry, so the fixed
    // code must reach the settings query and resolve Org A's own (empty)
    // configuration. The OLD unscoped query would have returned Org B's
    // row too, and - depending on Postgres's row order - could have picked
    // up SENTINEL_ORG_B_KEY and attempted a real (if ultimately rejected)
    // call to serpapi.com with another organisation's credential. The fixed
    // code must never reach fetch() at all here.
    const { status, json } = await callEdgeFunction('get-reviews', { business_name: BUSINESS_KEY_UNCACHED }, token);
    assert.equal(status, 400, `Org A has no key of its own and must see a clean "not configured" response, not Org B's key being used, got ${status}: ${JSON.stringify(json)}`);
    assert.match(json.error, /SerpApi API Key not configured/i);
  });

  test('Test 2 - the settings query resolves only Org A\'s own values, never Org B\'s', async () => {
    const resolved = await getScopedSettings(ORG_A);
    assert.equal(resolved.get('serpapi_api_key'), undefined, 'Org A has no key of its own and must not resolve Org B\'s');
    assert.equal(resolved.get('map_center_lat'), SENTINEL_ORG_A_LAT);
    assert.equal(resolved.get('map_center_lng'), SENTINEL_ORG_A_LNG);
    assert.equal(resolved.get('reviews_cache_ttl_hours'), SENTINEL_ORG_A_TTL);
  });

  test('Test 3 - the settings query resolves only Org B\'s own values, never Org A\'s', async () => {
    const resolved = await getScopedSettings(ORG_B);
    assert.equal(resolved.get('serpapi_api_key'), SENTINEL_ORG_B_KEY);
    assert.equal(resolved.get('map_center_lat'), SENTINEL_ORG_B_LAT);
    assert.equal(resolved.get('map_center_lng'), SENTINEL_ORG_B_LNG);
    assert.equal(resolved.get('reviews_cache_ttl_hours'), SENTINEL_ORG_B_TTL);
  });

  test('Test 4 - a genuine platform admin resolves org_default\'s own configuration, never Org A\'s or Org B\'s (regression guard)', async () => {
    const token = await tokenFor(platformAdmin);
    // org_default has no serpapi_api_key configured in this test project
    // (confirmed live before writing this test) - a platform admin's
    // uncached search must resolve org_default specifically, not silently
    // pick up Org A's or Org B's configuration instead.
    const { status, json } = await callEdgeFunction('get-reviews', { business_name: `${BUSINESS_KEY_UNCACHED}-platform` }, token);
    assert.equal(status, 400, `platform admin must resolve org_default's own (unconfigured) settings, got ${status}: ${JSON.stringify(json)}`);
    assert.match(json.error, /SerpApi API Key not configured/i);
  });
});
