// Regression tests for the Decision 4 Completion Review's RPC-authorisation
// fixes (migration 20260806030000): six SECURITY DEFINER RPCs previously
// gated themselves on check_user_role('admin')'s global-fallback pattern
// instead of has_org_role(), the exact defect class Decision 4 (DECISIONS.md)
// was meant to eliminate everywhere. Every cross-tenant test here was proven
// to succeed (i.e. the vulnerability was real) against the pre-fix RPCs
// before this file was written — see the Architecture Compliance Audit and
// the Decision 4 Completion Review for that evidence trail. These tests
// exist so that class of regression can never silently return.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service } from './helpers.mjs';

function genTestPassword() {
  // No password-shaped string literal in source — see tenant-isolation.test.mjs's
  // identical reasoning (GitGuardian pattern-matches raw source text, not the
  // runtime value).
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG_A = `rpc-auth-a-${RUN_ID}`;
const ORG_B = `rpc-auth-b-${RUN_ID}`;
const EVENT_A = `${ORG_A}-evt`;
const EVENT_B = `${ORG_B}-evt`;
const BOOKING_A = `RPCAUTH-A-${RUN_ID}`;
const BOOKING_B = `RPCAUTH-B-${RUN_ID}`;
const OWNER_A_EMAIL = `rpc-auth-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `rpc-auth-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();

const platformAdmin = createClient(url, anonKey);
let ownerA, ownerAId;
let stewardA, stewardAId;

// orgId.slice(-8) alone can collide: ORG_A/ORG_B differ only before the
// shared RUN_ID timestamp suffix, which a trailing slice cuts off entirely.
// Hash the full id so the distinguishing text actually participates.
function shortHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().padStart(8, '0').slice(-8);
}

async function seedOrg(orgId, eventId, bookingId, bookingStatus) {
  await service.from('organisations').insert({ id: orgId, name: `Tenant ${orgId}`, slug: orgId, contact_email: 'owner@example.test' });
  await service.from('events').insert({
    id: eventId, org_id: orgId, name: `${orgId} Event`, slug: `${orgId}-evt`,
    booking_prefix: shortHash(orgId), is_active: true, status: 'open',
  });
  await service.from('bookings').insert({
    id: bookingId, org_id: orgId, event_id: eventId, status: bookingStatus,
    business_name: 'RPC Auth Test Co', owner_name: 'Test Owner',
    email: 'trader@example.test', instance_prefix: `${orgId}-`, booking_type: 'general',
    payment_link_code: `${bookingId}-code`, stall_cost: 50,
  });
}

async function cleanupOrg(orgId, eventId, bookingId) {
  await service.from('booking_locations').delete().eq('booking_id', bookingId);
  await service.from('payments').delete().eq('booking_id', bookingId);
  await service.from('bookings').delete().eq('id', bookingId);
  await service.from('events').delete().eq('id', eventId);
  await service.from('settings').delete().eq('org_id', orgId);
  await service.from('email_templates').delete().eq('org_id', orgId);
  await service.from('sms_templates').delete().eq('org_id', orgId);
  await service.from('organisation_members').delete().eq('org_id', orgId);
  await service.from('organisations').delete().eq('id', orgId);
}

before(async () => {
  await seedOrg(ORG_A, EVENT_A, BOOKING_A, 'Payment Requested');
  await seedOrg(ORG_B, EVENT_B, BOOKING_B, 'Payment Requested');
  // ORG_B already has a real, configured display name — simulating an
  // established customer, not a brand-new org mid-provisioning.
  await service.from('settings').insert({ org_id: ORG_B, key: 'festival_display_name', value: 'Org B\'s Real Festival Name' });
  // ORG_A needs a base_url row (E5-23, 20260813140000): rpc_add_organisation_member
  // now requires one for a genuinely new invitee, and the regression guard
  // below adds a brand-new email to ORG_A - unrelated to what that test
  // actually verifies (authorisation, not invite-URL configuration), so
  // seeding this here rather than weakening that check.
  await service.from('settings').insert({ org_id: ORG_A, key: 'base_url', value: 'https://rpc-auth-test.example.test' });

  const { data: ownerCreated, error: ownerErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerErr, null, ownerErr?.message);
  ownerAId = ownerCreated.user.id;
  await service.from('organisation_members').insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  ownerA = createClient(url, anonKey);
  const { error: ownerSignInErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(ownerSignInErr, null, ownerSignInErr?.message);

  const { data: stewardCreated, error: stewardErr } = await service.auth.admin.createUser({
    email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD, email_confirm: true,
  });
  assert.equal(stewardErr, null, stewardErr?.message);
  stewardAId = stewardCreated.user.id;
  await service.from('organisation_members').insert({ org_id: ORG_A, user_id: stewardAId, role: 'steward' });
  stewardA = createClient(url, anonKey);
  const { error: stewardSignInErr } = await stewardA.auth.signInWithPassword({ email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD });
  assert.equal(stewardSignInErr, null, stewardSignInErr?.message);

  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, `Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${platformSignInErr?.message}`);
});

after(async () => {
  await cleanupOrg(ORG_A, EVENT_A, BOOKING_A);
  await cleanupOrg(ORG_B, EVENT_B, BOOKING_B);
  if (ownerAId) { await service.from('user_roles').delete().eq('id', ownerAId); await service.auth.admin.deleteUser(ownerAId); }
  if (stewardAId) { await service.from('user_roles').delete().eq('id', stewardAId); await service.auth.admin.deleteUser(stewardAId); }
});

describe('rpc_record_bank_transfer_payment is authorised against the booking\'s own org, not the caller\'s (20260806030000)', () => {
  test('an admin of a DIFFERENT org cannot confirm this booking by knowing its id', async () => {
    const { error } = await ownerA.rpc('rpc_record_bank_transfer_payment', {
      p_booking_id: BOOKING_B, p_payment_reference: 'cross-org-attempt',
    });
    assert.ok(error, 'admin of ORG_A must not be able to confirm ORG_B\'s booking');
    const { data } = await service.from('bookings').select('status').eq('id', BOOKING_B).single();
    assert.equal(data.status, 'Payment Requested', 'ORG_B\'s booking must be unaffected');
  });

  test('an admin of the booking\'s OWN org can still confirm it (regression guard)', async () => {
    const { error } = await ownerA.rpc('rpc_record_bank_transfer_payment', {
      p_booking_id: BOOKING_A, p_payment_reference: 'same-org-legitimate',
    });
    assert.equal(error, null, error?.message);
    const { data } = await service.from('bookings').select('status').eq('id', BOOKING_A).single();
    assert.equal(data.status, 'Confirmed');
    const { data: payment } = await service.from('payments').select('org_id').eq('booking_id', BOOKING_A).single();
    assert.equal(payment.org_id, ORG_A, 'the payment row must be tagged with the booking\'s real org, not the caller\'s session org');
  });

  test('a genuine platform admin CAN confirm a booking in an org they have no direct membership in (regression guard)', async () => {
    await service.from('bookings').update({ status: 'Payment Requested' }).eq('id', BOOKING_B);
    const { error } = await platformAdmin.rpc('rpc_record_bank_transfer_payment', {
      p_booking_id: BOOKING_B, p_payment_reference: 'platform-admin-view-as',
    });
    assert.equal(error, null, error?.message);
    const { data } = await service.from('bookings').select('status').eq('id', BOOKING_B).single();
    assert.equal(data.status, 'Confirmed', 'a genuine platform admin must still be able to act on any organisation\'s booking (View As)');
  });
});

describe('rpc_record_refund is authorised against the booking\'s own org on its authenticated branch (20260806030000)', () => {
  test('an admin of a DIFFERENT org cannot refund this booking\'s payment', async () => {
    await service.from('payments').upsert({ booking_id: BOOKING_B, org_id: ORG_B, paid: true, bank_ref: 'seed' }, { onConflict: 'booking_id' });
    const { error } = await ownerA.rpc('rpc_record_refund', {
      p_booking_id: BOOKING_B, p_refund_amount: 10, p_refund_reference: 'cross-org-refund-attempt',
    });
    assert.ok(error, 'admin of ORG_A must not be able to refund ORG_B\'s payment');
    const { data } = await service.from('payments').select('refund_amount').eq('booking_id', BOOKING_B).single();
    assert.equal(data.refund_amount, null, 'ORG_B\'s payment must be unaffected');
  });

  test('an admin of the booking\'s OWN org can still refund it (regression guard)', async () => {
    await service.from('payments').upsert({ booking_id: BOOKING_A, org_id: ORG_A, paid: true, bank_ref: 'seed' }, { onConflict: 'booking_id' });
    const { error } = await ownerA.rpc('rpc_record_refund', {
      p_booking_id: BOOKING_A, p_refund_amount: 10, p_refund_reference: 'same-org-legitimate-refund',
    });
    assert.equal(error, null, error?.message);
    const { data } = await service.from('payments').select('refund_amount').eq('booking_id', BOOKING_A).single();
    assert.equal(Number(data.refund_amount), 10);
  });
});

describe('rpc_set_booking_locations is authorised against the booking\'s own org (20260806030000)', () => {
  test('an admin of a DIFFERENT org cannot reassign this booking\'s locations', async () => {
    const { error } = await ownerA.rpc('rpc_set_booking_locations', {
      p_booking_id: BOOKING_B, p_location_ids: ['SOME-LOC'],
    });
    assert.ok(error, 'admin of ORG_A must not be able to reassign ORG_B\'s booking\'s locations');
    const { data } = await service.from('booking_locations').select('location_id').eq('booking_id', BOOKING_B);
    assert.equal((data || []).length, 0, 'ORG_B\'s booking must have no location assigned by the rejected attempt');
  });

  test('a steward of the booking\'s OWN org can still reassign it (regression guard — preserves admin-OR-steward)', async () => {
    // event_id must be set explicitly (Phase 3 WP1, 20260815100000): the
    // column's own default is event_default, which is NOT EVENT_A - this
    // location would previously have "worked" only because the pre-WP1 RPC
    // never checked event_id at all.
    await service.from('locations').insert({ id: `${ORG_A}-LOC`, dataset: 'LIVE', org_id: ORG_A, event_id: EVENT_A, lat: 51.0, lng: -0.1 });
    const { error } = await stewardA.rpc('rpc_set_booking_locations', {
      p_booking_id: BOOKING_A, p_location_ids: [`${ORG_A}-LOC`],
    });
    assert.equal(error, null, error?.message);
    const { data } = await service.from('booking_locations').select('location_id').eq('booking_id', BOOKING_A);
    assert.equal(data.length, 1);
    await service.from('booking_locations').delete().eq('booking_id', BOOKING_A);
    await service.from('locations').delete().eq('id', `${ORG_A}-LOC`).eq('dataset', 'LIVE');
  });
});

describe('rpc_set_booking_locations location ownership hardening (Phase 3 WP1, 20260815100000)', () => {
  const EVENT_A2 = `${ORG_A}-evt2`;
  const LOC_A_LIVE = `${ORG_A}-LOC-LIVE`;
  const LOC_A_LIVE_2 = `${ORG_A}-LOC-LIVE-2`;
  const LOC_B_LIVE = `${ORG_B}-LOC-LIVE`;
  const LOC_A2_LIVE = `${ORG_A}-LOC-EVT2-LIVE`;
  const LOC_A_NON_LIVE = `${ORG_A}-LOC-NON-LIVE`;

  before(async () => {
    await service.from('events').insert({
      id: EVENT_A2, org_id: ORG_A, name: `${ORG_A} Second Event`, slug: `${ORG_A}-evt2`,
      booking_prefix: shortHash(EVENT_A2), status: 'open',
    });
    await service.from('locations').insert([
      { id: LOC_A_LIVE, dataset: 'LIVE', org_id: ORG_A, event_id: EVENT_A, lat: 51.0, lng: -0.1 },
      { id: LOC_A_LIVE_2, dataset: 'LIVE', org_id: ORG_A, event_id: EVENT_A, lat: 51.0, lng: -0.1 },
      { id: LOC_B_LIVE, dataset: 'LIVE', org_id: ORG_B, event_id: EVENT_B, lat: 51.0, lng: -0.1 },
      { id: LOC_A2_LIVE, dataset: 'LIVE', org_id: ORG_A, event_id: EVENT_A2, lat: 51.0, lng: -0.1 },
      // Not 'LIVE' — the DEV location dataset itself has been retired as a
      // product concept (Phase 3, 20260815210000), but the `dataset` column
      // still exists (kept for schedules_location_fkey's sake) and nothing
      // stops a row existing with a non-LIVE value. This proves the
      // invariant holds unconditionally with NO exception for any dataset
      // other than LIVE, not just that the old DEV-specific relaxation was
      // removed.
      { id: LOC_A_NON_LIVE, dataset: 'DEV', org_id: ORG_A, event_id: EVENT_A, lat: 51.0, lng: -0.1 },
    ]);
  });

  after(async () => {
    await service.from('booking_locations').delete().eq('booking_id', BOOKING_A);
    await service.from('locations').delete().in('id', [LOC_A_LIVE, LOC_A_LIVE_2, LOC_B_LIVE, LOC_A2_LIVE, LOC_A_NON_LIVE]);
    await service.from('events').delete().eq('id', EVENT_A2);
  });

  test('rejects a location belonging to a DIFFERENT organisation', async () => {
    const { error } = await ownerA.rpc('rpc_set_booking_locations', {
      p_booking_id: BOOKING_A, p_location_ids: [LOC_B_LIVE],
    });
    assert.ok(error, 'admin of ORG_A must not be able to attach ORG_B\'s real location to their own booking');
    const { data } = await service.from('booking_locations').select('location_id').eq('booking_id', BOOKING_A);
    assert.equal((data || []).length, 0, 'no location should have been attached by the rejected attempt');
  });

  test('rejects a location belonging to the SAME organisation but a DIFFERENT event', async () => {
    const { error } = await ownerA.rpc('rpc_set_booking_locations', {
      p_booking_id: BOOKING_A, p_location_ids: [LOC_A2_LIVE],
    });
    assert.ok(error, 'a location belonging to a different event of the same org must still be rejected');
    const { data } = await service.from('booking_locations').select('location_id').eq('booking_id', BOOKING_A);
    assert.equal((data || []).length, 0);
  });

  test('rejects a location whose own org/event match but is not in the LIVE dataset (DEV retirement — no exception)', async () => {
    const { error } = await ownerA.rpc('rpc_set_booking_locations', {
      p_booking_id: BOOKING_A, p_location_ids: [LOC_A_NON_LIVE],
    });
    assert.ok(error, 'a non-LIVE-dataset location must be rejected unconditionally, even with matching org_id/event_id and even for a booking whose own instance_prefix is DEV-shaped');
    const { data } = await service.from('booking_locations').select('location_id').eq('booking_id', BOOKING_A);
    assert.equal((data || []).length, 0);
  });

  test('rejects a nonexistent location id', async () => {
    const { error } = await ownerA.rpc('rpc_set_booking_locations', {
      p_booking_id: BOOKING_A, p_location_ids: ['THIS-LOCATION-DOES-NOT-EXIST'],
    });
    assert.ok(error, 'a location id with no matching row at all must be rejected');
    const { data } = await service.from('booking_locations').select('location_id').eq('booking_id', BOOKING_A);
    assert.equal((data || []).length, 0);
  });

  test('accepts locations genuinely belonging to the booking\'s own org/event/dataset (regression guard)', async () => {
    const { error } = await ownerA.rpc('rpc_set_booking_locations', {
      p_booking_id: BOOKING_A, p_location_ids: [LOC_A_LIVE, LOC_A_LIVE_2],
    });
    assert.equal(error, null, error?.message);
    const { data } = await service.from('booking_locations').select('location_id').eq('booking_id', BOOKING_A);
    assert.equal((data || []).length, 2);
    assert.deepEqual(new Set((data || []).map((r) => r.location_id)), new Set([LOC_A_LIVE, LOC_A_LIVE_2]));
  });

  test('an empty array still clears existing locations (regression guard)', async () => {
    const { error } = await ownerA.rpc('rpc_set_booking_locations', {
      p_booking_id: BOOKING_A, p_location_ids: [],
    });
    assert.equal(error, null, error?.message);
    const { data } = await service.from('booking_locations').select('location_id').eq('booking_id', BOOKING_A);
    assert.equal((data || []).length, 0);
  });
});

describe('rpc_add_organisation_member and rpc_get_next_misc_id reject a caller whose global role was leaked by an unrelated org (20260806030000)', () => {
  // The real-world mechanism: rpc_add_organisation_member's OWN user_roles
  // upsert is global, not per-organisation — being made admin of ANY
  // organisation sets the caller's GLOBAL legacy role column to 'admin'.
  // Simulated directly here (rather than via a second real
  // organisation_members row) so get_current_org_id()'s own un-ordered
  // fallback query stays deterministic — stewardA's only real membership
  // stays ORG_A throughout.
  before(async () => {
    await service.from('user_roles').upsert({ id: stewardAId, email: STEWARD_A_EMAIL, role: 'admin' }, { onConflict: 'id' });
  });

  test('rpc_add_organisation_member rejects a steward with a leaked global admin role', async () => {
    // p_org_id added (E5-23, 20260813140000): rpc_add_organisation_member no
    // longer resolves its target ambiently via get_current_org_id(), so this
    // now also exercises is_authorised_for_org(ORG_A, ...) directly - still
    // correctly rejected, since is_platform_admin() reads org_default
    // membership, not this legacy user_roles column, and stewardA has
    // neither an org_default membership row nor an admin role in ORG_A.
    const { error } = await stewardA.rpc('rpc_add_organisation_member', {
      p_org_id: ORG_A, p_email: `rpc-auth-newmember-${RUN_ID}@example.test`, p_role: 'steward',
    });
    assert.ok(error, 'a steward of ORG_A must not be able to add members to ORG_A just because their GLOBAL role was set to admin elsewhere');
    assert.notEqual(error.code, 'PGRST202', 'must be an authorisation rejection, not a missing-function error');
  });

  test('rpc_get_next_misc_id rejects the same leaked-role steward', async () => {
    // p_event_id added (Multi-Event Phase 1, 20260814100000) - EVENT_A
    // genuinely belongs to ORG_A (seeded in before()), so this still
    // exercises the authorisation rejection specifically, not a separate
    // "event doesn't belong to this org" rejection.
    const { error } = await stewardA.rpc('rpc_get_next_misc_id', { p_event_id: EVENT_A });
    assert.ok(error, 'a steward must not be able to generate booking ids just because their GLOBAL role was set to admin elsewhere');
    assert.notEqual(error.code, 'PGRST202', 'must be an authorisation rejection, not a missing-function error');
  });

  test('a real admin of their own org can still add a member (regression guard)', async () => {
    // p_org_id added (E5-23, 20260813140000) - see comment above.
    const newEmail = `rpc-auth-real-add-${RUN_ID}@example.test`;
    const { error } = await ownerA.rpc('rpc_add_organisation_member', { p_org_id: ORG_A, p_email: newEmail, p_role: 'steward' });
    assert.equal(error, null, error?.message);
    const { data: newRow } = await service.from('user_roles').select('id').eq('email', newEmail).single();
    if (newRow) {
      await service.from('organisation_members').delete().eq('org_id', ORG_A).eq('user_id', newRow.id);
      await service.from('user_roles').delete().eq('id', newRow.id);
    }
  });
});

describe('rpc_initialise_tenant_defaults\'s admin branch is authorised against the target p_org_id, not the caller\'s session (20260806030000)', () => {
  test('an admin of a DIFFERENT org cannot overwrite this org\'s already-configured display name', async () => {
    const { error } = await ownerA.rpc('rpc_initialise_tenant_defaults', {
      p_org_id: ORG_B, p_display_name: 'DEFACED BY ORG A ADMIN',
    });
    assert.ok(error, 'admin of ORG_A must not be able to initialise/overwrite ORG_B\'s defaults');
    const { data } = await service.from('settings').select('value').eq('org_id', ORG_B).eq('key', 'festival_display_name').single();
    assert.equal(data.value, 'Org B\'s Real Festival Name', 'ORG_B\'s real display name must be unaffected');
  });

  test('an admin CAN still initialise/override their OWN org\'s defaults (regression guard)', async () => {
    const { error } = await ownerA.rpc('rpc_initialise_tenant_defaults', {
      p_org_id: ORG_A, p_display_name: 'Org A Legitimate Rename',
    });
    assert.equal(error, null, error?.message);
    const { data } = await service.from('settings').select('value').eq('org_id', ORG_A).eq('key', 'festival_display_name').single();
    assert.equal(data.value, 'Org A Legitimate Rename');
  });
});
