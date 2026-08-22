// Regression tests for E5-22 (Epic 5 closing architecture review): audit_logs
// INSERT was WITH CHECK (true) since the baseline schema — the read side was
// scoped in 20260806000000, but any authenticated user, any role, any
// organisation (a steward included) could still insert an audit_logs row
// with an arbitrary org_id, action, target_id, and details directly via
// PostgREST, bypassing the trusted js/audit.js helper entirely. Only
// user_email was already safe (stamp_audit_log_user_email overwrites it
// from the JWT claim, 20260720100100 — re-confirmed here, not just assumed
// still true).
//
// Fixed in 20260813120000_scope_audit_logs_insert_to_caller_org.sql by
// replacing the open policy with:
//   WITH CHECK (is_authorised_for_org(audit_logs.org_id, ARRAY['admin','steward']))
// — reusing the same shared helper the RPC layer already consolidated onto,
// not a new authorization mechanism.
//
// The critical test in this file is Test 2 and Test 4: a direct PostgREST
// INSERT with a forged org_id, bypassing js/audit.js completely. That is the
// actual vulnerability — testing only the JS helper would prove nothing
// about the real boundary, which is the database.
//
// Stewards are deliberately included in the authorized set (not admin-only,
// unlike bookings/payments): js/page-steward.js's own
// auditLog('steward_location_change', ...) calls are a real, legitimate
// production write path, confirmed by reading that file before choosing the
// policy shape. See Test 3/3b.
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
const ORG_A = `audit22-a-${RUN_ID}`;
const ORG_B = `audit22-b-${RUN_ID}`;
const OWNER_A_EMAIL = `audit22-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `audit22-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();
const NO_MEMBERSHIP_EMAIL = `audit22-nomember-${RUN_ID}@example.test`;
const NO_MEMBERSHIP_PASSWORD = genTestPassword();

const TARGET = `audit22-target-${RUN_ID}`;

let ownerAId, stewardAId, noMembershipId;
let ownerA, stewardA, noMembership, platformAdmin;

async function rowsFor(orgId, action) {
  const { data } = await service.from('audit_logs').select('id, org_id, action, target_id, user_email').eq('org_id', orgId).eq('action', action);
  return data || [];
}

before(async () => {
  const { error: orgAErr } = await service.from('organisations')
    .insert({ id: ORG_A, name: `E5-22 Test ${ORG_A}`, slug: ORG_A, contact_email: 'owner@example.test' });
  assert.equal(orgAErr, null, orgAErr?.message);
  const { error: orgBErr } = await service.from('organisations')
    .insert({ id: ORG_B, name: `E5-22 Test ${ORG_B}`, slug: ORG_B, contact_email: 'owner@example.test' });
  assert.equal(orgBErr, null, orgBErr?.message);

  const { data: ownerACreated, error: ownerAErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerAErr, null, ownerAErr?.message);
  ownerAId = ownerACreated.user.id;
  const { error: memberAErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  assert.equal(memberAErr, null, memberAErr?.message);

  ownerA = createClient(url, anonKey);
  const { error: signInAErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(signInAErr, null, signInAErr?.message);

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

  // A genuinely authenticated user with ZERO organisation_members rows
  // anywhere — the "logged in, but administers nothing" case.
  const { data: noMemberCreated, error: noMemberErr } = await service.auth.admin.createUser({
    email: NO_MEMBERSHIP_EMAIL, password: NO_MEMBERSHIP_PASSWORD, email_confirm: true,
  });
  assert.equal(noMemberErr, null, noMemberErr?.message);
  noMembershipId = noMemberCreated.user.id;

  noMembership = createClient(url, anonKey);
  const { error: noMemberSignInErr } = await noMembership.auth.signInWithPassword({ email: NO_MEMBERSHIP_EMAIL, password: NO_MEMBERSHIP_PASSWORD });
  assert.equal(noMemberSignInErr, null, noMemberSignInErr?.message);

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, platformSignInErr?.message);
});

after(async () => {
  // org_id, not target_id: the "an authenticated caller can freely choose
  // action/details/target_id" test below deliberately inserts a target_id
  // that doesn't match TARGET's own prefix (proving the shape is
  // unconstrained), which a target_id-LIKE cleanup would silently miss -
  // this is exactly the gap that leaked that row into a permanent orphan
  // (Phase 2D TEST audit_logs remediation) once ORG_A was deleted below.
  await service.from('audit_logs').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('organisation_members').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('organisations').delete().in('id', [ORG_A, ORG_B]);
  if (ownerAId) await service.auth.admin.deleteUser(ownerAId);
  if (stewardAId) await service.auth.admin.deleteUser(stewardAId);
  if (noMembershipId) await service.auth.admin.deleteUser(noMembershipId);
});

describe('E5-22: audit_logs INSERT is scoped to the caller\'s own organisation', () => {
  test('Test 1 - Org A\'s admin can write an audit record for Org A (own org)', async () => {
    const { error } = await ownerA.from('audit_logs').insert({
      action: 'e5_22_test_admin_own_org', target_id: `${TARGET}-1`, details: { probe: true }, org_id: ORG_A, event_id: 'event_default',
    });
    assert.equal(error, null, error?.message);

    const rows = await rowsFor(ORG_A, 'e5_22_test_admin_own_org');
    assert.equal(rows.length, 1, 'expected exactly one row written for Org A');
  });

  test('Test 2 (critical regression test) - Org A\'s admin CANNOT write an audit record forged to Org B, direct PostgREST bypassing js/audit.js entirely', async () => {
    const { error } = await ownerA.from('audit_logs').insert({
      action: 'e5_22_test_admin_cross_org', target_id: `${TARGET}-2`, details: { probe: true }, org_id: ORG_B, event_id: 'event_default',
    });
    assert.ok(error, 'expected the forged cross-tenant INSERT to be rejected by the database, not merely by js/audit.js');

    const rows = await rowsFor(ORG_B, 'e5_22_test_admin_cross_org');
    assert.equal(rows.length, 0, 'no row should exist for Org B as a result of Org A\'s admin');
  });

  test('Test 3 - Org A\'s steward CAN write an audit record for Org A (real, legitimate behaviour - js/page-steward.js does exactly this)', async () => {
    const { error } = await stewardA.from('audit_logs').insert({
      action: 'e5_22_test_steward_own_org', target_id: `${TARGET}-3`, details: { probe: true }, org_id: ORG_A, event_id: 'event_default',
    });
    assert.equal(error, null, `stewards must retain real audit-write authority for their own organisation: ${error?.message}`);

    const rows = await rowsFor(ORG_A, 'e5_22_test_steward_own_org');
    assert.equal(rows.length, 1);
  });

  test('Test 3b - Org A\'s steward CANNOT write an audit record forged to Org B', async () => {
    const { error } = await stewardA.from('audit_logs').insert({
      action: 'e5_22_test_steward_cross_org', target_id: `${TARGET}-3b`, details: { probe: true }, org_id: ORG_B, event_id: 'event_default',
    });
    assert.ok(error, 'expected the forged cross-tenant INSERT to be rejected');

    const rows = await rowsFor(ORG_B, 'e5_22_test_steward_cross_org');
    assert.equal(rows.length, 0);
  });

  test('Test 4 - a caller with NO organisation membership anywhere cannot write a tenant audit record, for any org_id', async () => {
    const { error: errA } = await noMembership.from('audit_logs').insert({
      action: 'e5_22_test_no_membership', target_id: `${TARGET}-4a`, details: { probe: true }, org_id: ORG_A, event_id: 'event_default',
    });
    assert.ok(errA, 'a caller with zero admin/steward membership anywhere must be rejected for Org A');

    const { error: errB } = await noMembership.from('audit_logs').insert({
      action: 'e5_22_test_no_membership', target_id: `${TARGET}-4b`, details: { probe: true }, org_id: ORG_B, event_id: 'event_default',
    });
    assert.ok(errB, 'a caller with zero admin/steward membership anywhere must be rejected for Org B too');

    assert.equal((await rowsFor(ORG_A, 'e5_22_test_no_membership')).length, 0);
    assert.equal((await rowsFor(ORG_B, 'e5_22_test_no_membership')).length, 0);
  });

  test('Test 5 (regression guard) - a genuine platform admin can still write an audit record for ANOTHER organisation, matching existing architecture', async () => {
    const { error } = await platformAdmin.from('audit_logs').insert({
      action: 'e5_22_test_platform_admin_cross_org', target_id: `${TARGET}-5`, details: { probe: true }, org_id: ORG_B, event_id: 'event_default',
    });
    assert.equal(error, null, `a genuine platform admin must still be able to write audit records for another organisation (same bypass every other tenant-scoped table already has): ${error?.message}`);

    const rows = await rowsFor(ORG_B, 'e5_22_test_platform_admin_cross_org');
    assert.equal(rows.length, 1);
  });

  test('Test 6 - user_email remains server-derived from the JWT, not client-controlled, even under the new policy', async () => {
    const { error } = await ownerA.from('audit_logs').insert({
      action: 'e5_22_test_user_email', target_id: `${TARGET}-6`, details: {}, org_id: ORG_A, event_id: 'event_default',
      user_email: 'someone-else@evil.test',
    });
    assert.equal(error, null, error?.message);

    const rows = await rowsFor(ORG_A, 'e5_22_test_user_email');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_email, OWNER_A_EMAIL, 'user_email must be stamped from the real JWT identity, never the client-supplied value');
  });

  test('Test 7 - legitimate existing application audit logging still works: js/audit.js\'s own insert shape, for the caller\'s own org, with no org_id specified (defaults via getCurrentOrgId() semantics)', async () => {
    // Mirrors js/audit.js's auditLog() exactly: action, target_id, user_email,
    // details, instance, org_id, event_id - proving the fix doesn't require
    // any change to the trusted helper's own insert shape.
    const { error } = await ownerA.from('audit_logs').insert({
      action: 'e5_22_test_legit_app_write',
      target_id: `${TARGET}-7`,
      user_email: OWNER_A_EMAIL,
      details: { subject: 'legit write' },
      instance: 'ESF26-DEV-',
      org_id: ORG_A,
      event_id: 'event_default',
    });
    assert.equal(error, null, `existing legitimate audit logging must be unaffected by this fix: ${error?.message}`);

    const rows = await rowsFor(ORG_A, 'e5_22_test_legit_app_write');
    assert.equal(rows.length, 1);
  });

  test('Test 8 - an authorized caller retains full control over action/target_id/details for their OWN org (the fix scopes org_id only, by design)', async () => {
    const { error } = await ownerA.from('audit_logs').insert({
      action: 'anything_the_caller_wants', target_id: 'arbitrary-target-string', details: { arbitrary: 'content', nested: { x: 1 } }, org_id: ORG_A, event_id: 'event_default',
    });
    assert.equal(error, null, 'action/target_id/details are self-reported by design elsewhere in the app (e.g. steward-triggered actions) - this fix intentionally validates only tenant identity (org_id), not content, per its own scope');

    const rows = await rowsFor(ORG_A, 'anything_the_caller_wants');
    assert.equal(rows.length, 1);
  });
});
