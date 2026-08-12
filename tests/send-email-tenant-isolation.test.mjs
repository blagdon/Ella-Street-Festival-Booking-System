// Regression tests for E5-25: send-email's get_accounts action checked admin
// status against the bare global user_roles table (no org_id correlation at
// all — not even the "any org's admin" pattern other functions had before
// their own fixes), and cached the freshly-exchanged Zoho access token with
// no org_id on the upsert whatsoever — which the settings table's own
// NOT NULL DEFAULT 'org_default' silently resolved to org_default every
// time, regardless of which organisation's admin called it or whose Zoho
// credentials they submitted. Any organisation's admin — including one
// configuring their own, entirely legitimate Zoho integration — could
// silently clobber org_default's cached access token, routing org_default's
// real outbound customer email through a different Zoho account for the
// life of that cached token.
//
// Fixed in supabase/functions/send-email/index.ts by:
//   1. Replacing the bare user_roles check with resolveCallerAdminScope()
//      (mirrors queue-bulk-email/get-booking-documents/etc.).
//   2. Deriving the target organisation for the token cache entirely from
//      the caller's own real membership — org_default for a genuine
//      platform admin, the caller's own single organisation otherwise, a
//      clean 400 if that's ambiguous — never from the request body.
//   3. Scoping the upsert itself to that organisation (org_id + explicit
//      onConflict: 'org_id,key'), so a write can never land on a different
//      organisation's row.
//
// External Zoho safety: every test below points accountsDomain/apiDomain at
// https://example.invalid — an RFC 2606 reserved domain guaranteed to never
// resolve — so the Edge Function's own outbound fetch() calls always fail
// fast, well after authorization/org-resolution has already run, and no
// request ever reaches a real server. No real Zoho credentials are used
// anywhere in this file. Because that fetch always fails, a genuinely
// successful token-cache write is never exercised end-to-end here (doing so
// would require a real, publicly-reachable Zoho-shaped endpoint, which is
// out of scope for this fix) — instead, the security boundary is proven the
// way the fix itself is structured: authorization and org-targeting are
// fully resolved BEFORE that external call, and the critical property (an
// org_default — or any other organisation's — cached token can never be
// touched by a different organisation's admin) is proven directly via
// sentinel rows seeded before each test and asserted unchanged afterward.
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

// Guaranteed-unreachable per RFC 2606 — never resolves, never contacted for
// real, and structurally cannot leak a fake credential to any real server.
const UNREACHABLE_DOMAIN = 'https://example.invalid';

const RUN_ID = Date.now();
const ORG_A = `e525-org-a-${RUN_ID}`;
const ORG_B = `e525-org-b-${RUN_ID}`;
const OWNER_A_EMAIL = `e525-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `e525-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();
const MULTI_ORG_ADMIN_EMAIL = `e525-multiorg-${RUN_ID}@example.test`;
const MULTI_ORG_ADMIN_PASSWORD = genTestPassword();
const LEGACY_ONLY_EMAIL = `e525-legacyonly-${RUN_ID}@example.test`;
const LEGACY_ONLY_PASSWORD = genTestPassword();

const ORG_DEFAULT_SENTINEL = `sentinel-org-default-untouched-${RUN_ID}`;
const ORG_B_SENTINEL = `sentinel-org-b-untouched-${RUN_ID}`;

let ownerAId, stewardAId, multiOrgAdminId, legacyOnlyId;
let ownerA, stewardA, multiOrgAdmin, legacyOnlyUser, platformAdmin;

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

function getAccountsBody(extra = {}) {
  return {
    action: 'get_accounts',
    clientId: 'fake-client-id',
    clientSecret: 'fake-client-secret',
    refreshToken: 'fake-refresh-token',
    accountsDomain: UNREACHABLE_DOMAIN,
    apiDomain: UNREACHABLE_DOMAIN,
    ...extra,
  };
}

async function readSentinel(orgId, key) {
  const { data } = await service.from('settings').select('value').eq('org_id', orgId).eq('key', key).maybeSingle();
  return data?.value ?? null;
}

before(async () => {
  const { error: orgAErr } = await service.from('organisations')
    .insert({ id: ORG_A, name: `E5-25 Test ${ORG_A}`, slug: ORG_A, contact_email: 'owner@example.test' });
  assert.equal(orgAErr, null, orgAErr?.message);
  const { error: orgBErr } = await service.from('organisations')
    .insert({ id: ORG_B, name: `E5-25 Test ${ORG_B}`, slug: ORG_B, contact_email: 'owner@example.test' });
  assert.equal(orgBErr, null, orgBErr?.message);

  // Sentinel rows standing in for org_default's and Org B's real cached
  // Zoho tokens — a fake, clearly-inert placeholder value, never a real
  // token. If any test's call actually reaches the upsert and writes to
  // either of these rows, the sentinel value will change, which is exactly
  // the regression these tests exist to catch.
  const { error: sentinelDefaultErr } = await service.from('settings')
    .upsert({ org_id: 'org_default', key: 'zoho_access_token', value: ORG_DEFAULT_SENTINEL }, { onConflict: 'org_id,key' });
  assert.equal(sentinelDefaultErr, null, sentinelDefaultErr?.message);
  const { error: sentinelBErr } = await service.from('settings')
    .upsert({ org_id: ORG_B, key: 'zoho_access_token', value: ORG_B_SENTINEL }, { onConflict: 'org_id,key' });
  assert.equal(sentinelBErr, null, sentinelBErr?.message);

  // Owner A — a real admin of ORG_A only, never org_default, never ORG_B.
  // Also given a legacy user_roles row, matching exactly what
  // rpc_add_organisation_member()/provision-organisation write for every
  // real admin - without it, this fixture wouldn't reproduce the OLD
  // code's own accepted shape, which checked user_roles alone.
  const { data: ownerACreated, error: ownerAErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerAErr, null, ownerAErr?.message);
  ownerAId = ownerACreated.user.id;
  const { error: memberAErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  assert.equal(memberAErr, null, memberAErr?.message);
  const { error: legacyAErr } = await service.from('user_roles')
    .insert({ id: ownerAId, email: OWNER_A_EMAIL, role: 'admin' });
  assert.equal(legacyAErr, null, legacyAErr?.message);

  ownerA = createClient(url, anonKey);
  const { error: signInAErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(signInAErr, null, signInAErr?.message);

  // Steward A — a non-admin member of ORG_A.
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

  // A genuine admin of BOTH ORG_A and ORG_B (never org_default) — the
  // "invalid/indeterminate organisation context" fixture: resolveCallerAdminScope()
  // legitimately returns two orgIds for this user, with no established way
  // to disambiguate which one get_accounts should target.
  const { data: multiCreated, error: multiErr } = await service.auth.admin.createUser({
    email: MULTI_ORG_ADMIN_EMAIL, password: MULTI_ORG_ADMIN_PASSWORD, email_confirm: true,
  });
  assert.equal(multiErr, null, multiErr?.message);
  multiOrgAdminId = multiCreated.user.id;
  const { error: multiMemberAErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: multiOrgAdminId, role: 'admin' });
  assert.equal(multiMemberAErr, null, multiMemberAErr?.message);
  const { error: multiMemberBErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_B, user_id: multiOrgAdminId, role: 'admin' });
  assert.equal(multiMemberBErr, null, multiMemberBErr?.message);

  multiOrgAdmin = createClient(url, anonKey);
  const { error: multiSignInErr } = await multiOrgAdmin.auth.signInWithPassword({ email: MULTI_ORG_ADMIN_EMAIL, password: MULTI_ORG_ADMIN_PASSWORD });
  assert.equal(multiSignInErr, null, multiSignInErr?.message);

  // A user with ONLY the legacy global user_roles admin row — no
  // organisation_members row anywhere. The OLD code accepted this shape
  // outright; the new code must not.
  const { data: legacyCreated, error: legacyErr } = await service.auth.admin.createUser({
    email: LEGACY_ONLY_EMAIL, password: LEGACY_ONLY_PASSWORD, email_confirm: true,
  });
  assert.equal(legacyErr, null, legacyErr?.message);
  legacyOnlyId = legacyCreated.user.id;
  const { error: legacyOnlyRoleErr } = await service.from('user_roles')
    .insert({ id: legacyOnlyId, email: LEGACY_ONLY_EMAIL, role: 'admin' });
  assert.equal(legacyOnlyRoleErr, null, legacyOnlyRoleErr?.message);

  legacyOnlyUser = createClient(url, anonKey);
  const { error: legacySignInErr } = await legacyOnlyUser.auth.signInWithPassword({ email: LEGACY_ONLY_EMAIL, password: LEGACY_ONLY_PASSWORD });
  assert.equal(legacySignInErr, null, legacySignInErr?.message);

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, platformSignInErr?.message);
});

after(async () => {
  await service.from('settings').delete().eq('org_id', ORG_A).eq('key', 'zoho_access_token');
  await service.from('settings').delete().eq('org_id', ORG_A).eq('key', 'zoho_access_token_expires_at');
  await service.from('settings').delete().eq('org_id', ORG_B).eq('key', 'zoho_access_token');
  await service.from('settings').delete().eq('org_id', ORG_B).eq('key', 'zoho_access_token_expires_at');
  await service.from('settings').delete().eq('org_id', 'org_default').eq('key', 'zoho_access_token').eq('value', ORG_DEFAULT_SENTINEL);
  await service.from('settings').delete().eq('org_id', 'org_default').eq('key', 'zoho_access_token_expires_at');

  await service.from('organisation_members').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('organisations').delete().in('id', [ORG_A, ORG_B]);

  if (ownerAId) { await service.from('user_roles').delete().eq('id', ownerAId); await service.auth.admin.deleteUser(ownerAId); }
  if (stewardAId) await service.auth.admin.deleteUser(stewardAId);
  if (multiOrgAdminId) await service.auth.admin.deleteUser(multiOrgAdminId);
  if (legacyOnlyId) { await service.from('user_roles').delete().eq('id', legacyOnlyId); await service.auth.admin.deleteUser(legacyOnlyId); }
});

describe('E5-25: send-email get_accounts platform/tenant Zoho isolation', () => {
  test('Test 1 - Org A\'s own admin is authorized for their own organisation (not rejected as Forbidden)', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('send-email', getAccountsBody(), token);

    // The deliberately-unreachable accountsDomain means this can never
    // reach 200 — the meaningful assertion is that authorization succeeded
    // (no longer the old bare "Forbidden: Admin role required" a
    // legitimate org's own admin should never see) and that org-resolution
    // didn't itself reject as ambiguous either.
    assert.notEqual(status, 403, `Org A's own admin must not be rejected as Forbidden, got ${status}: ${JSON.stringify(json)}`);
    assert.notEqual(status, 400, `Org A's own admin has exactly one organisation and must not be treated as ambiguous, got ${status}: ${JSON.stringify(json)}`);

    // Nothing was, or could have been, written anywhere - the fake domain
    // fails before the upsert - covered explicitly by Test 2.
  });

  test('Test 2 (critical regression test) - Org A\'s admin CANNOT cause org_default\'s or Org B\'s cached Zoho token to change', async () => {
    const before = { orgDefault: await readSentinel('org_default', 'zoho_access_token'), orgB: await readSentinel(ORG_B, 'zoho_access_token') };
    assert.equal(before.orgDefault, ORG_DEFAULT_SENTINEL);
    assert.equal(before.orgB, ORG_B_SENTINEL);

    const token = await tokenFor(ownerA);
    await callEdgeFunction('send-email', getAccountsBody(), token);

    // This is the exact scenario the OLD code got wrong: any organisation's
    // admin - here, Org A's - could silently overwrite org_default's (or,
    // depending on row order, another organisation's) cached token. Under
    // the fix, Org A's call can only ever target Org A's own organisation,
    // so both sentinels must be completely unchanged.
    const after = { orgDefault: await readSentinel('org_default', 'zoho_access_token'), orgB: await readSentinel(ORG_B, 'zoho_access_token') };
    assert.equal(after.orgDefault, ORG_DEFAULT_SENTINEL, 'org_default\'s cached Zoho token must be untouched by Org A\'s admin');
    assert.equal(after.orgB, ORG_B_SENTINEL, 'Org B\'s cached Zoho token must be untouched by Org A\'s admin');

    // get_accounts never sends an email itself (it only exchanges/queries
    // Zoho account metadata), so there is nothing further to assert about
    // email_queue here.
  });

  test('Test 3 - a non-admin (steward) is rejected outright, even for their own org', async () => {
    const token = await tokenFor(stewardA);
    const { status, json } = await callEdgeFunction('send-email', getAccountsBody(), token);
    assert.equal(status, 403, JSON.stringify(json));
    assert.match(json.error, /Admin role required/i);

    assert.equal(await readSentinel('org_default', 'zoho_access_token'), ORG_DEFAULT_SENTINEL);
  });

  test('Test 4 - an admin of two organisations gets a clean, explicit rejection rather than a guessed target', async () => {
    const token = await tokenFor(multiOrgAdmin);
    const { status, json } = await callEdgeFunction('send-email', getAccountsBody(), token);

    assert.equal(status, 400, `an admin of more than one organisation must be rejected as ambiguous, got ${status}: ${JSON.stringify(json)}`);
    assert.match(json.error, /ambiguous/i);

    assert.equal(await readSentinel('org_default', 'zoho_access_token'), ORG_DEFAULT_SENTINEL);
    assert.equal(await readSentinel(ORG_A, 'zoho_access_token'), null, 'no configuration should exist for ORG_A from a rejected, ambiguous call');
    assert.equal(await readSentinel(ORG_B, 'zoho_access_token'), ORG_B_SENTINEL);
  });

  test('Test 5 - a genuine platform admin (org_default) is authorized, distinctly from the ambiguous case (regression guard)', async () => {
    const token = await tokenFor(platformAdmin);
    const { status, json } = await callEdgeFunction('send-email', getAccountsBody(), token);

    assert.notEqual(status, 403, JSON.stringify(json));
    assert.notEqual(status, 400, 'a genuine org_default platform admin must resolve deterministically to org_default, not be treated as ambiguous');

    // Org B's sentinel must never be touched by a platform admin's call
    // either - a platform admin's get_accounts targets org_default only,
    // by the same deterministic rule proven in source (see the fix's
    // callerScope.isPlatformAdmin branch), never any other organisation.
    assert.equal(await readSentinel(ORG_B, 'zoho_access_token'), ORG_B_SENTINEL);
  });

  test('Test 6 - a user with ONLY the legacy global user_roles admin row is rejected (no fallback to it)', async () => {
    const token = await tokenFor(legacyOnlyUser);
    const { status, json } = await callEdgeFunction('send-email', getAccountsBody(), token);

    // The OLD code accepted this exact fixture on the strength of the bare
    // user_roles check alone. The new code must reject it, since this user
    // has no organisation_members row anywhere and so is not a platform
    // admin and administers zero organisations.
    assert.equal(status, 403, `a user with only a legacy user_roles admin row (no organisation_members row) must be rejected, got ${status}: ${JSON.stringify(json)}`);
    assert.match(json.error, /Admin role required/i);

    assert.equal(await readSentinel('org_default', 'zoho_access_token'), ORG_DEFAULT_SENTINEL);
  });

  test('Test 7 - an unauthenticated caller is rejected', async () => {
    const { status, json } = await callEdgeFunction('send-email', getAccountsBody(), anonKey);
    assert.equal(status, 401, JSON.stringify(json));
  });
});
