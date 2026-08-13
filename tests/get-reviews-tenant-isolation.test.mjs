// Regression tests for E5-26: get-reviews checked admin status against the
// legacy global user_roles table alone — not even organisation_members-aware
// — so any identity holding a stale legacy user_roles admin row, with no
// real organisation membership at all, could invoke this metered, paid
// SerpApi-backed endpoint.
//
// Fixed in supabase/functions/get-reviews/index.ts by replacing the bare
// user_roles check with resolveCallerAdminScope() (mirrors every other
// closed Epic 5 finding). This suite proves only the authorization
// boundary — WHO may call the function — and deliberately does not touch
// the SerpApi settings/cache scoping issue tracked separately as E5-20.
//
// Never makes a real SerpApi call: every "authorized" case here is proven
// via a warm google_reviews_cache hit (same technique as
// google-reviews-cache.test.mjs), which get-reviews serves before it ever
// reaches the SerpApi key check or a live fetch.
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

let ownerAId, stewardAId, legacyOnlyId;
let ownerA, stewardA, platformAdmin, legacyOnly;

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

before(async () => {
  const { error: orgErr } = await service.from('organisations')
    .insert({ id: ORG_A, name: `E5-26 get-reviews Test ${ORG_A}`, slug: ORG_A, contact_email: 'owner@example.test' });
  assert.equal(orgErr, null, orgErr?.message);

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
  await service.from('google_reviews_cache').delete().in('business_key', [BUSINESS_KEY_OWNER, BUSINESS_KEY_PLATFORM]);
  await service.from('organisation_members').delete().eq('org_id', ORG_A);
  await service.from('organisations').delete().eq('id', ORG_A);
  if (ownerAId) await service.auth.admin.deleteUser(ownerAId);
  if (stewardAId) await service.auth.admin.deleteUser(stewardAId);
  if (legacyOnlyId) {
    await service.from('user_roles').delete().eq('id', legacyOnlyId);
    await service.auth.admin.deleteUser(legacyOnlyId);
  }
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
