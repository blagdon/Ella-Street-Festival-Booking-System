// Regression tests for E5-26: send-sms checked admin status against ANY
// organisation's organisation_members row (falling back to the legacy
// global user_roles table), and trusted a caller-supplied orgId for both
// SMS-provider selection and sms_queue log attribution with no validation
// against the caller's real organisation membership at all — so an admin
// of Organisation A could send SMS on org_default's provider budget
// regardless of caller, and freely forge which organisation's sms_queue
// log an SMS was attributed to.
//
// Fixed in supabase/functions/send-sms/index.ts by:
//   1. Replacing the unscoped admin check with resolveCallerAdminScope()
//      (mirrors queue-bulk-sms/retry-queued-sms).
//   2. Validating any caller-supplied orgId against the caller's own
//      authorised scope via isAuthorizedForOrg() before using it for
//      anything — a mismatched orgId is now rejected outright rather than
//      silently trusted or silently substituted. When no orgId is supplied
//      at all, the caller's own single organisation (or org_default for a
//      platform admin) is resolved server-side instead.
//   3. Passing that resolved organisation into sendViaSms() itself, so the
//      correct organisation's own SMS provider settings are used, not
//      always org_default's.
//
// Every send in this suite resolves to the mock adapter (sms_test_mode
// defaults to true, sms_provider defaults to 'mock' - see _shared/sms.ts)
// since no org here configures a real provider - no real SMS is ever sent.
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
const ORG_A = `e526-sms-org-a-${RUN_ID}`;
const ORG_B = `e526-sms-org-b-${RUN_ID}`;
const OWNER_A_EMAIL = `e526-sms-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `e526-sms-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();
const LEGACY_ONLY_EMAIL = `e526-sms-legacy-${RUN_ID}@example.test`;
const LEGACY_ONLY_PASSWORD = genTestPassword();

const RECIPIENT = '+447700900301';

let ownerAId, stewardAId, legacyOnlyId;
let ownerA, stewardA, platformAdmin, legacyOnly;

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

async function smsRowsFor(orgId) {
  const { data } = await service.from('sms_queue').select('id, org_id, recipient').eq('org_id', orgId).eq('recipient', RECIPIENT);
  return data || [];
}

before(async () => {
  const { error: orgAErr } = await service.from('organisations')
    .insert({ id: ORG_A, name: `E5-26 send-sms Test ${ORG_A}`, slug: ORG_A, contact_email: 'owner@example.test' });
  assert.equal(orgAErr, null, orgAErr?.message);
  const { error: orgBErr } = await service.from('organisations')
    .insert({ id: ORG_B, name: `E5-26 send-sms Test ${ORG_B}`, slug: ORG_B, contact_email: 'owner@example.test' });
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
  // organisation_members row at all.
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
});

after(async () => {
  await service.from('sms_queue').delete().eq('recipient', RECIPIENT);
  await service.from('organisation_members').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('organisations').delete().in('id', [ORG_A, ORG_B]);
  if (ownerAId) await service.auth.admin.deleteUser(ownerAId);
  if (stewardAId) await service.auth.admin.deleteUser(stewardAId);
  if (legacyOnlyId) {
    await service.from('user_roles').delete().eq('id', legacyOnlyId);
    await service.auth.admin.deleteUser(legacyOnlyId);
  }
});

describe('E5-26: send-sms platform/tenant authorization and org attribution', () => {
  test('Test 1 - Org A\'s own admin can send SMS attributed to Org A\'s own organisation', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('send-sms', { recipient: RECIPIENT, body: 'E5-26 own-org test', orgId: ORG_A }, token);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, true);

    const rows = await smsRowsFor(ORG_A);
    assert.equal(rows.length, 1, 'expected exactly one sms_queue row attributed to Org A');
  });

  test('Test 2 (critical regression test) - Org A\'s admin CANNOT send or attribute an SMS to Org B', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('send-sms', { recipient: RECIPIENT, body: 'E5-26 cross-tenant attempt', orgId: ORG_B }, token);

    // Rejected before any send or log write: the OLD code accepted this
    // exact fixture (a real organisation_members admin of ANY org, with an
    // unchecked orgId) and would have written a Org-B-attributed sms_queue
    // row and actually attempted the send.
    assert.equal(status, 403, `cross-tenant SMS attribution must be rejected, got ${status}: ${JSON.stringify(json)}`);

    const rows = await smsRowsFor(ORG_B);
    assert.equal(rows.length, 0, 'no sms_queue row should exist for Org B as a result of Org A\'s admin');
  });

  test('Test 3 - a non-admin (steward) is rejected outright, even for their own org', async () => {
    const token = await tokenFor(stewardA);
    const { status, json } = await callEdgeFunction('send-sms', { recipient: RECIPIENT, body: 'E5-26 steward attempt', orgId: ORG_A }, token);
    assert.equal(status, 403, JSON.stringify(json));
    assert.match(json.error, /Admin role required/i);
  });

  test('Test 4 - an unauthenticated caller is rejected', async () => {
    const { status, json } = await callEdgeFunction('send-sms', { recipient: RECIPIENT, body: 'E5-26 unauthenticated attempt', orgId: ORG_A }, anonKey);
    assert.equal(status, 401, JSON.stringify(json));
  });

  test('Test 5 - a genuine platform admin (org_default) can still send and attribute SMS to another organisation (regression guard)', async () => {
    const token = await tokenFor(platformAdmin);
    const { status, json } = await callEdgeFunction('send-sms', { recipient: RECIPIENT, body: 'E5-26 platform admin test', orgId: ORG_B }, token);
    assert.equal(status, 200, `platform admin must still be able to act on another organisation, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.success, true);

    const rows = await smsRowsFor(ORG_B);
    assert.equal(rows.length, 1, 'platform admin\'s legitimate cross-org send must still be attributed to the requested organisation');
  });

  test('Test 6 - omitting orgId falls back to the caller\'s own single organisation, never a client-influenced value', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('send-sms', { recipient: RECIPIENT, body: 'E5-26 no-orgId fallback test' }, token);
    assert.equal(status, 200, JSON.stringify(json));

    const rowsA = await smsRowsFor(ORG_A);
    assert.ok(rowsA.length >= 1, 'expected the send with no orgId to resolve to Org A, the caller\'s own organisation');
  });

  test('Test 7 - a user with ONLY the legacy global user_roles admin row is rejected (no fallback to it)', async () => {
    const token = await tokenFor(legacyOnly);
    const { status, json } = await callEdgeFunction('send-sms', { recipient: RECIPIENT, body: 'E5-26 legacy-only attempt', orgId: ORG_A }, token);
    assert.equal(status, 403, `a legacy-only identity with no real organisation membership must be rejected, got ${status}: ${JSON.stringify(json)}`);
    assert.match(json.error, /Admin role required/i);
  });
});
