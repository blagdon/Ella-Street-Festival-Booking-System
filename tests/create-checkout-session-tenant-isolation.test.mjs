// Regression tests for E5-24: create-checkout-session checked admin status
// against ANY organisation's organisation_members row (falling back to the
// legacy global user_roles table), and looked up the target booking with no
// org filter at all — so an admin of Organisation A, given Organisation B's
// booking id, could move Organisation B's booking to "Payment Requested",
// overwrite its price, and trigger a real payment-request email/SMS to
// Organisation B's own trader, entirely without Organisation B's knowledge
// or consent.
//
// Fixed in supabase/functions/create-checkout-session/index.ts by:
//   1. Replacing the unscoped admin check with resolveCallerAdminScope()
//      (mirrors get-booking-documents/refund-payment).
//   2. Scoping the booking lookup query itself to the caller's authorised
//      org set — a cross-tenant booking id now reads as a plain 404, never
//      confirming the booking exists in another org.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service, callEdgeFunction } from './helpers.mjs';

// See tenant-isolation.test.mjs's identical helper/comment: avoids a
// fixed-looking password literal that would trip secret-scanner pattern
// matching, while staying under GoTrue's 72-character limit.
function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG_A = `e524-org-a-${RUN_ID}`;
const ORG_B = `e524-org-b-${RUN_ID}`;
const OWNER_A_EMAIL = `e524-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `e524-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();

const BOOKING_A = `E524-A-${RUN_ID}`;
const BOOKING_B = `E524-B-${RUN_ID}`;
const TRADER_A_EMAIL = `e524-trader-a-${RUN_ID}@example.test`;
const TRADER_B_EMAIL = `e524-trader-b-${RUN_ID}@example.test`;

let ownerAId, stewardAId;
let ownerA, stewardA, platformAdmin;

async function seedOrgWithBooking(orgId, bookingId, traderEmail) {
  const { error: orgErr } = await service.from('organisations')
    .insert({ id: orgId, name: `E5-24 Test ${orgId}`, slug: orgId, contact_email: 'owner@example.test' });
  assert.equal(orgErr, null, orgErr?.message);

  const { error: bErr } = await service.from('bookings').insert({
    id: bookingId, org_id: orgId, status: 'Pending',
    business_name: 'E5-24 Test Co', owner_name: 'Test Owner',
    email: traderEmail, instance_prefix: `${orgId}-DEV-`,
    stall_type: 'Food', stall_cost: 42,
  });
  assert.equal(bErr, null, bErr?.message);

  // A real payment_requested template for this org — without it the email
  // step's own try/catch would swallow "template not found" and the request
  // would still succeed, which would make Test 1's positive email-queued
  // assertion untestable and Test 2's negative one trivially true for the
  // wrong reason.
  const { error: emailTplErr } = await service.from('email_templates').insert({
    org_id: orgId, id: 'payment_requested',
    subject: `${orgId} payment due`, body_html: `Pay {{cost}} via {{payment_link}}`,
  });
  assert.equal(emailTplErr, null, emailTplErr?.message);
}

async function cleanupOrg(orgId, bookingId, traderEmail) {
  await service.from('email_queue').delete().eq('recipient', traderEmail);
  await service.from('sms_queue').delete().eq('org_id', orgId);
  await service.from('audit_logs').delete().eq('org_id', orgId);
  await service.from('bookings').delete().eq('id', bookingId);
  await service.from('email_templates').delete().eq('org_id', orgId);
  await service.from('organisation_members').delete().eq('org_id', orgId);
  await service.from('organisations').delete().eq('id', orgId);
}

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

before(async () => {
  await seedOrgWithBooking(ORG_A, BOOKING_A, TRADER_A_EMAIL);
  await seedOrgWithBooking(ORG_B, BOOKING_B, TRADER_B_EMAIL);

  const { data: ownerCreated, error: ownerErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerErr, null, ownerErr?.message);
  ownerAId = ownerCreated.user.id;
  // A real admin of ORG_A only - never org_default, never ORG_B. Also given
  // a user_roles row, matching exactly what rpc_add_organisation_member()
  // writes for every real admin invited through the normal flow - the OLD
  // (pre-fix) code's own organisation_members check (unscoped by org_id)
  // already accepts this fixture on its own, but the extra row keeps this
  // fixture consistent with the shape every other real admin actually has.
  const { error: memberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  assert.equal(memberErr, null, memberErr?.message);
  const { error: legacyRoleErr } = await service.from('user_roles')
    .insert({ id: ownerAId, email: OWNER_A_EMAIL, role: 'admin' });
  assert.equal(legacyRoleErr, null, legacyRoleErr?.message);

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

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, platformSignInErr?.message);
});

after(async () => {
  await cleanupOrg(ORG_A, BOOKING_A, TRADER_A_EMAIL);
  await cleanupOrg(ORG_B, BOOKING_B, TRADER_B_EMAIL);
  if (ownerAId) { await service.from('user_roles').delete().eq('id', ownerAId); await service.auth.admin.deleteUser(ownerAId); }
  if (stewardAId) await service.auth.admin.deleteUser(stewardAId);
});

describe('E5-24: create-checkout-session cross-tenant authorization', () => {
  test('Test 1 - Org A\'s own admin can request payment on Org A\'s own booking', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('create-checkout-session', { booking_id: BOOKING_A }, token);

    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(json.payment_link && json.payment_link.includes('/pay.html?token='));

    const { data: booking } = await service.from('bookings')
      .select('status, stall_cost, stripe_requested_cost, stripe_payment_requested_at')
      .eq('id', BOOKING_A).single();
    assert.equal(booking.status, 'Payment Requested');
    assert.equal(Number(booking.stripe_requested_cost), 42);
    assert.ok(booking.stripe_payment_requested_at);

    const { data: emailRows } = await service.from('email_queue').select('id').eq('recipient', TRADER_A_EMAIL);
    assert.equal(emailRows.length, 1, 'expected a payment-request email to be queued for Org A\'s own trader');
  });

  test('Test 2 (critical regression test) - an Org A admin CANNOT request payment on Org B\'s booking', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('create-checkout-session', { booking_id: BOOKING_B, send_sms: true }, token);

    // Rejected before any booking mutation or Stripe/email/SMS activity: a
    // plain 404 (not visible in the caller's own org scope), not a 400/429
    // that would confirm the booking exists in another organisation. A
    // 400/429/200 here would mean the OLD unscoped lookup found Org B's
    // booking and the request proceeded - structurally impossible against
    // the fixed org-scoped query for an existing cross-tenant id.
    assert.equal(status, 404, `cross-tenant payment request must be rejected as not-found, got ${status}: ${JSON.stringify(json)}`);

    const { data: booking } = await service.from('bookings')
      .select('status, stall_cost, stripe_requested_cost, stripe_payment_requested_at')
      .eq('id', BOOKING_B).single();
    assert.equal(booking.status, 'Pending', 'Org B\'s booking status must be unaffected');
    assert.equal(Number(booking.stall_cost), 42, 'Org B\'s price must be unaffected');
    assert.equal(booking.stripe_requested_cost, null, 'no payment request must have been created for Org B');
    assert.equal(booking.stripe_payment_requested_at, null);

    const { data: emailRows } = await service.from('email_queue').select('id').eq('recipient', TRADER_B_EMAIL);
    assert.equal(emailRows.length, 0, 'no payment-request email may be queued for Org B\'s trader as a result of Org A\'s admin');

    const { data: smsRows } = await service.from('sms_queue').select('id').eq('org_id', ORG_B);
    assert.equal(smsRows.length, 0, 'no SMS may be queued for Org B as a result of Org A\'s admin, even with send_sms requested');
  });

  test('Test 3 - a non-admin (steward) of Org A is rejected outright, even for their own org\'s booking', async () => {
    const token = await tokenFor(stewardA);
    const { status, json } = await callEdgeFunction('create-checkout-session', { booking_id: BOOKING_A }, token);
    assert.equal(status, 403, JSON.stringify(json));
    assert.match(json.error, /Admin role required/i);
  });

  test('Test 4 - a booking id that does not exist at all is rejected as not-found, not silently treated as any org\'s', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('create-checkout-session', { booking_id: `${BOOKING_A}-DOES-NOT-EXIST` }, token);
    assert.equal(status, 404, JSON.stringify(json));
  });

  test('Test 5 - a genuine platform admin (org_default) can still request payment on another organisation\'s booking (regression guard)', async () => {
    const token = await tokenFor(platformAdmin);
    const { status, json } = await callEdgeFunction('create-checkout-session', { booking_id: BOOKING_B }, token);

    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(json.payment_link && json.payment_link.includes('/pay.html?token='));

    const { data: booking } = await service.from('bookings')
      .select('status, stripe_requested_cost')
      .eq('id', BOOKING_B).single();
    assert.equal(booking.status, 'Payment Requested', 'platform admin must still be able to act on another organisation\'s booking (View As)');
    assert.equal(Number(booking.stripe_requested_cost), 42);

    const { data: emailRows } = await service.from('email_queue').select('id').eq('recipient', TRADER_B_EMAIL);
    assert.equal(emailRows.length, 1, 'platform admin\'s legitimate request must still queue a real payment-request email for Org B\'s own trader');
  });
});
