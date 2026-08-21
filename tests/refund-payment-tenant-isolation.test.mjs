// Regression tests for E5-21: refund-payment did not verify that the
// caller's own organisation matched the booking's organisation before
// issuing a real Stripe refund. Its admin check queried the legacy global
// user_roles table (any org's admin, not org-scoped), its booking lookup had
// no org filter at all, and it invoked rpc_record_refund with the bare
// service-role client - so even that RPC's own auth.uid()-based org check
// never ran (auth.uid() is NULL for a service-role call, which takes the
// RPC's unauthenticated/system branch and performs zero authorization).
// Net effect: an admin of Organisation A could refund Organisation B's
// Stripe payment by supplying Organisation B's booking_id.
//
// Fixed in supabase/functions/refund-payment/index.ts by:
//   1. Replacing the user_roles check with resolveCallerAdminScope()
//      (mirrors retry-queued-sms/queue-bulk-email/queue-bulk-sms).
//   2. Selecting org_id on the booking and scoping the lookup query itself
//      to the caller's org set (mirrors retry-queued-sms) - a cross-tenant
//      booking id now reads as a plain 404, never confirming the booking
//      exists in another org.
//   3. Deriving booking.org_id from that row (never from client input) for
//      the Stripe credential lookup.
//   4. Invoking rpc_record_refund via a caller-JWT-forwarding client (anon
//      key + `Authorization: <caller's own token>`), mirroring
//      invite-organisation-member's callerClient, so the RPC's own
//      is_authorised_for_org check actually executes as a second,
//      independent layer instead of silently no-op'ing.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, service, callEdgeFunction } from './helpers.mjs';

// See tenant-isolation.test.mjs's identical helper/comment: avoids a
// fixed-looking password literal that would trip secret-scanner pattern
// matching, while staying under GoTrue's 72-character limit.
function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG_A = `e521-org-a-${RUN_ID}`;
const ORG_B = `e521-org-b-${RUN_ID}`;
const OWNER_A_EMAIL = `e521-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `e521-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();

const BOOKING_A = `E521-A-${RUN_ID}`;
const BOOKING_B = `E521-B-${RUN_ID}`;

let ownerAId, stewardAId;
let ownerA, stewardA;

async function seedOrgWithPaidBooking(orgId, bookingId, paymentIntentId) {
  const { error: orgErr } = await service.from('organisations')
    .insert({ id: orgId, name: `E5-21 Test ${orgId}`, slug: orgId, contact_email: 'owner@example.test' });
  assert.equal(orgErr, null, orgErr?.message);

  // -DEV- forces Stripe Test mode (see _shared/stripe.ts's resolveStripeMode)
  // regardless of this brand-new org's settings, and the stripe_secret_key_test
  // row below (same test key every other Stripe test in this suite uses) lets
  // Test 1 reach a REAL Stripe Test-mode API call — which then genuinely
  // rejects the synthetic payment_intent id below with Stripe's own "No such
  // PaymentIntent" error. No real Stripe object is ever created; only rejected.
  const { error: bErr } = await service.from('bookings').insert({
    // event_id: this file never creates a dedicated event for orgId, so it
    // stays 'event_default' explicitly, matching current default behaviour.
    id: bookingId, org_id: orgId, event_id: 'event_default', status: 'Confirmed',
    business_name: 'E5-21 Test Co', owner_name: 'Test Owner',
    email: 'trader@example.test', instance_prefix: `${orgId}-DEV-`,
    stall_type: 'Food', stall_cost: 100,
    stripe_payment_intent_id: paymentIntentId,
  });
  assert.equal(bErr, null, bErr?.message);

  const { error: pErr } = await service.from('payments').insert({
    booking_id: bookingId, org_id: orgId, paid: true, date_paid: new Date().toISOString().split('T')[0],
    payment_method: 'stripe', editor: 'test',
  });
  assert.equal(pErr, null, pErr?.message);

  if (process.env.TEST_STRIPE_SECRET_KEY) {
    const { error: settingsErr } = await service.from('settings')
      .insert({ org_id: orgId, key: 'stripe_secret_key_test', value: process.env.TEST_STRIPE_SECRET_KEY });
    assert.equal(settingsErr, null, settingsErr?.message);
  }
}

async function cleanupOrg(orgId, bookingId) {
  await service.from('payments').delete().eq('booking_id', bookingId);
  await service.from('bookings').delete().eq('id', bookingId);
  await service.from('settings').delete().eq('org_id', orgId);
  await service.from('organisation_members').delete().eq('org_id', orgId);
  await service.from('organisations').delete().eq('id', orgId);
}

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

before(async () => {
  await seedOrgWithPaidBooking(ORG_A, BOOKING_A, `pi_test_e521_a_${RUN_ID}`);
  await seedOrgWithPaidBooking(ORG_B, BOOKING_B, `pi_test_e521_b_${RUN_ID}`);

  const { data: ownerCreated, error: ownerErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerErr, null, ownerErr?.message);
  ownerAId = ownerCreated.user.id;
  // A real admin of ORG_A only - never org_default, never ORG_B. The exact
  // shape every genuine customer org owner has (see tenant-isolation.test.mjs).
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
});

after(async () => {
  await cleanupOrg(ORG_A, BOOKING_A);
  await cleanupOrg(ORG_B, BOOKING_B);
  if (ownerAId) await service.auth.admin.deleteUser(ownerAId);
  if (stewardAId) await service.auth.admin.deleteUser(stewardAId);
});

describe('E5-21: refund-payment cross-tenant authorization', () => {
  test('Test 1 - Org A\'s own admin refunding Org A\'s own booking passes every authorization gate (reaches Stripe)', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('refund-payment', { booking_id: BOOKING_A }, token);

    // The seeded payment_intent id is synthetic (never a real Stripe
    // object), so Stripe itself rejects it once the call reaches
    // stripe.refunds.create() — proving the request passed the admin check,
    // the org-scoped booking lookup, and every guard-rail check first. A
    // 403/404 here would mean the fix wrongly blocks the booking's own org
    // admin, which is the "don't break legitimate behaviour" half of E5-21.
    assert.notEqual(status, 403, `own-org admin must not be rejected as unauthorized: ${JSON.stringify(json)}`);
    assert.notEqual(status, 404, `own-org admin must find their own booking: ${JSON.stringify(json)}`);
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error, /No such PaymentIntent|payment_intent/i,
      `expected a Stripe-shaped rejection of the synthetic payment_intent (proof the call reached Stripe), got: ${json.error}`);

    const { data: payment } = await service.from('payments').select('refund_amount').eq('booking_id', BOOKING_A).single();
    assert.equal(payment.refund_amount, null, 'no refund was actually issued, since Stripe rejected the synthetic payment_intent');
  });

  test('Test 2 (critical regression test) - an Org A admin CANNOT refund Org B\'s payment', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('refund-payment', { booking_id: BOOKING_B }, token);

    // Rejected before Stripe is ever reached: a plain 404 (not visible in
    // the caller's own org scope), not a 403 that would confirm the booking
    // exists in another organisation.
    assert.equal(status, 404, `cross-tenant refund must be rejected as not-found, got ${status}: ${JSON.stringify(json)}`);

    // Org B's payment and booking must be completely untouched — no Stripe
    // refund was created, no refund record was written, no state changed.
    const { data: payment } = await service.from('payments')
      .select('refund_amount, refunded_at, refunded_by, refund_reference')
      .eq('booking_id', BOOKING_B).single();
    assert.equal(payment.refund_amount, null, 'Org B must not show a refund amount');
    assert.equal(payment.refunded_at, null, 'Org B must not show a refund timestamp');
    assert.equal(payment.refunded_by, null, 'Org B must not show a refund actor');
    assert.equal(payment.refund_reference, null, 'Org B must not show a refund reference (no Stripe refund id was ever generated)');

    const { data: booking } = await service.from('bookings').select('status').eq('id', BOOKING_B).single();
    assert.equal(booking.status, 'Confirmed', 'Org B\'s booking status must be unaffected');
  });

  test('Test 3 - a non-admin (steward) of Org A is rejected outright, even for their own org\'s booking', async () => {
    const token = await tokenFor(stewardA);
    const { status, json } = await callEdgeFunction('refund-payment', { booking_id: BOOKING_A }, token);
    assert.equal(status, 403, JSON.stringify(json));
    assert.match(json.error, /Admin role required/i);

    const { data: payment } = await service.from('payments').select('refund_amount').eq('booking_id', BOOKING_A).single();
    assert.equal(payment.refund_amount, null, 'a rejected steward attempt must not have written anything');
  });

  test('Test 4 - a booking id that does not exist at all is rejected as not-found, not silently treated as any org\'s', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('refund-payment', { booking_id: `${BOOKING_A}-DOES-NOT-EXIST` }, token);
    assert.equal(status, 404, JSON.stringify(json));
  });

  test('Test 5 - the refund path\'s RPC call forwards the caller\'s own JWT, so rpc_record_refund\'s own org check is a real second authorization layer (not a service-role no-op)', async () => {
    // refund-payment now builds `createClient(supabaseUrl, supabaseAnonKey,
    // { global: { headers: { Authorization: authHeader } } })` and calls
    // rpc_record_refund on THAT client (confirmed by reading
    // supabase/functions/refund-payment/index.ts directly) — exactly
    // mirroring invite-organisation-member's callerClient pattern. This
    // matters as defense-in-depth independent of Test 2's booking-lookup
    // scoping: rpc_record_refund's own SQL branches on auth.uid() — when
    // NULL (a bare service-role call), it takes the unauthenticated/system
    // branch and performs NO org check at all (see the ELSE branch in
    // 20260807060000_consolidate_rpc_org_role_check.sql). If refund-payment
    // ever silently fell back to the bare service-role client for this
    // call — e.g. a future refactor that reverts the fix, even while
    // leaving Test 2's booking-lookup scoping intact — this second layer
    // would go silent and a regression elsewhere in the booking lookup
    // would no longer be caught by anything.
    //
    // Exercised here by calling rpc_record_refund through the exact same
    // client construction refund-payment's source now uses, for a booking
    // outside the caller's own org: this only rejects the call if the
    // caller's real identity (not "no identity") reaches the RPC.
    const callerClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${await tokenFor(ownerA)}` } }
    });
    const { error } = await callerClient.rpc('rpc_record_refund', {
      p_booking_id: BOOKING_B,
      p_refund_amount: 10,
      p_refund_reference: 're_e521_jwt_forward_check',
      p_notes: null,
      p_refunded_by: 'Stripe (automatic)',
    });
    assert.ok(error, 'rpc_record_refund must reject a caller-JWT call for a booking outside the caller\'s own org');
    assert.match(error.message, /not authorized/i);

    // Contrast case, proving the rejection above is genuinely identity-based
    // and not just "this RPC always rejects a p_refunded_by-only style call":
    // a TRUE unauthenticated/service-role invocation with the identical
    // args is accepted (this is the legitimate Stripe-webhook reconciliation
    // path — see refunds.test.mjs's "webhook reconciliation path" describe
    // block) — the two must behave differently for the same booking/args.
    const { error: serviceErr } = await service.rpc('rpc_record_refund', {
      p_booking_id: BOOKING_B,
      p_refund_amount: 10,
      p_refund_reference: 're_e521_service_role_contrast',
      p_notes: null,
      p_refunded_by: 'Stripe (automatic)',
    });
    assert.equal(serviceErr, null, `expected the true service-role path to succeed (contrast case): ${serviceErr?.message}`);

    const { data: payment } = await service.from('payments')
      .select('refund_amount, refund_reference, refunded_by')
      .eq('booking_id', BOOKING_B).single();
    assert.equal(Number(payment.refund_amount), 10);
    assert.equal(payment.refund_reference, 're_e521_service_role_contrast', 'only the service-role contrast call should have recorded anything');
    assert.equal(payment.refunded_by, 'Stripe (automatic)');
  });
});
