// Regression tests for E5-04 Option B: stripe-webhook used to load only
// org_default's webhook secrets before signature verification, so a second
// organisation's own Stripe account could never have its payment
// confirmations verified - documented in-repo as a known, deliberate
// limitation, not a tenant-isolation leak (everything downstream already
// correctly resolved off the booking's own org_id once a signature verified).
//
// Fixed by treating every organisation's registered webhook secret as a
// CANDIDATE: the incoming signature is tried against every one, and
// whichever candidate verifies identifies both the organisation and the
// Stripe mode (test/live) for this event - the unverified payload itself is
// never consulted to select an organisation, only a successful HMAC match
// does that. Ambiguity (more than one candidate verifying the same
// signature) is tracked by full (org_id, mode) identity, not collapsed to
// org_id - the same organisation's own test and live secrets colliding is
// exactly as ambiguous as two different organisations colliding, and both
// are rejected rather than arbitrarily resolved. A verified event whose
// referenced booking belongs to a DIFFERENT organisation than the one that
// verified it is acknowledged without processing (not retried forever by
// Stripe for something retrying can't fix) but alerted via Sentry.
//
// Signature construction: Stripe's webhook signature scheme
// (t=<unix-seconds>,v1=<hex HMAC-SHA256 of "timestamp.payload">) is publicly
// documented specifically so it can be implemented without the Stripe SDK -
// reimplemented here with Node's built-in crypto module rather than adding
// a new npm dependency for tests only. No real Stripe account or network
// call is involved in generating or verifying these signatures; nothing
// here sends a real Stripe event.
//
// Deliberately scoped to proving MULTI-TENANT RESOLUTION specifically -
// booking/payment state (bookings.status, payments.org_id/paid) is
// asserted directly; the pre-existing confirmation email/SMS machinery
// (already covered by tests/stripe-payment.test.mjs and unrelated to E5-04)
// is not re-verified here, since it would require seeding full email/sms
// template rows for every fixture org with no bearing on tenant resolution.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { service, fetchEdgeFunction, anonKey } from './helpers.mjs';

function signStripePayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signedPayload = `${timestamp}.${payload}`;
  const v1 = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

async function postWebhook(payload, signature) {
  const res = await fetchEdgeFunction('stripe-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, 'stripe-signature': signature },
    body: payload,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function checkoutCompletedPayload(bookingId, eventIdSuffix) {
  return JSON.stringify({
    id: `evt_${RUN_ID}_${eventIdSuffix}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_test_${RUN_ID}_${eventIdSuffix}`,
        payment_status: 'paid',
        payment_intent: `pi_test_${RUN_ID}_${eventIdSuffix}`,
        metadata: { booking_id: bookingId },
        client_reference_id: bookingId,
      },
    },
  });
}

const RUN_ID = Date.now();
const ORG_A = `e504-org-a-${RUN_ID}`;
const ORG_B = `e504-org-b-${RUN_ID}`;
const ORG_DUP1 = `e504-dup1-${RUN_ID}`;
const ORG_DUP2 = `e504-dup2-${RUN_ID}`;
const ORG_SAMEMODE = `e504-samemode-${RUN_ID}`;
const EVENT_A = `${ORG_A}-evt`;
const EVENT_B = `${ORG_B}-evt`;
const BOOKING_A = `E504A${RUN_ID}`.slice(0, 20);
const BOOKING_B = `E504B${RUN_ID}`.slice(0, 20);
// A SEPARATE Payment-Requested booking for Org B, dedicated to the
// cross-tenant test below - BOOKING_B itself is legitimately confirmed by
// an earlier test in this same file (Test C), so reusing it here would
// prove nothing: it would already be 'Confirmed' regardless of whether the
// cross-tenant check works, confounding the assertion.
const BOOKING_B2 = `E504B2${RUN_ID}`.slice(0, 20);
const BOOKING_DEFAULT = `E504DEF${RUN_ID}`.slice(0, 20);
const SECRET_A = `whsec_test_org_a_${RUN_ID}`;
const SECRET_B = `whsec_test_org_b_${RUN_ID}`;
const SECRET_WRONG = `whsec_test_wrong_${RUN_ID}`;
const SECRET_CROSS_DUP = `whsec_test_cross_dup_${RUN_ID}`;
const SECRET_SAMEMODE_DUP = `whsec_test_samemode_dup_${RUN_ID}`;

let orgDefaultSecret;

async function seedOrgWithBooking(orgId, eventId, bookingId, secrets) {
  await service.from('organisations').insert({ id: orgId, name: `E5-04 ${orgId}`, slug: orgId, contact_email: 'owner@example.test' });
  await service.from('events').insert({
    id: eventId, org_id: orgId, name: `${orgId} Event`, slug: `${orgId}-evt`,
    booking_prefix: orgId.slice(-8).toUpperCase(), is_active: true, status: 'open',
  });
  await service.from('bookings').insert({
    id: bookingId, org_id: orgId, event_id: eventId, status: 'Payment Requested',
    business_name: 'E5-04 Test Co', owner_name: 'Test Owner', email: 'trader@example.test',
    instance_prefix: `${orgId}-`, booking_type: 'general', payment_link_code: `${bookingId}-code`, stall_cost: 50,
  });
  for (const [key, value] of Object.entries(secrets)) {
    await service.from('settings').upsert({ org_id: orgId, key, value }, { onConflict: 'org_id,key' });
  }
}

async function cleanupOrg(orgId, eventId, bookingId) {
  if (bookingId) await service.from('payments').delete().eq('booking_id', bookingId);
  if (bookingId) await service.from('bookings').delete().eq('id', bookingId);
  if (eventId) await service.from('events').delete().eq('id', eventId);
  await service.from('settings').delete().eq('org_id', orgId);
  await service.from('organisations').delete().eq('id', orgId);
}

before(async () => {
  await seedOrgWithBooking(ORG_A, EVENT_A, BOOKING_A, { stripe_webhook_secret_test: SECRET_A });
  await seedOrgWithBooking(ORG_B, EVENT_B, BOOKING_B, { stripe_webhook_secret_test: SECRET_B });
  await service.from('bookings').insert({
    id: BOOKING_B2, org_id: ORG_B, event_id: EVENT_B, status: 'Payment Requested',
    business_name: 'E5-04 Test Co (cross-tenant fixture)', owner_name: 'Test Owner', email: 'trader@example.test',
    instance_prefix: `${ORG_B}-`, booking_type: 'general', payment_link_code: `${BOOKING_B2}-code`, stall_cost: 50,
  });
  // Ambiguity fixtures - own orgs, deliberately never reused by the
  // resolution tests above, so no test's expected outcome depends on
  // another test's ordering.
  await service.from('organisations').insert({ id: ORG_DUP1, name: `E5-04 ${ORG_DUP1}`, slug: ORG_DUP1, contact_email: 'owner@example.test' });
  await service.from('organisations').insert({ id: ORG_DUP2, name: `E5-04 ${ORG_DUP2}`, slug: ORG_DUP2, contact_email: 'owner@example.test' });
  await service.from('settings').insert({ org_id: ORG_DUP1, key: 'stripe_webhook_secret_test', value: SECRET_CROSS_DUP });
  await service.from('settings').insert({ org_id: ORG_DUP2, key: 'stripe_webhook_secret_test', value: SECRET_CROSS_DUP });
  await service.from('organisations').insert({ id: ORG_SAMEMODE, name: `E5-04 ${ORG_SAMEMODE}`, slug: ORG_SAMEMODE, contact_email: 'owner@example.test' });
  await service.from('settings').insert({ org_id: ORG_SAMEMODE, key: 'stripe_webhook_secret_test', value: SECRET_SAMEMODE_DUP });
  await service.from('settings').insert({ org_id: ORG_SAMEMODE, key: 'stripe_webhook_secret_live', value: SECRET_SAMEMODE_DUP });

  // Read-only: org_default's own real, already-seeded webhook secret
  // (scripts/seed-test-project.mjs writes it from TEST_STRIPE_WEBHOOK_SECRET).
  // Used to prove the pre-existing single-tenant path still works, without
  // inventing or modifying org_default's own configuration.
  const { data: row } = await service.from('settings')
    .select('value').eq('org_id', 'org_default').eq('key', 'stripe_webhook_secret_test').maybeSingle();
  orgDefaultSecret = row?.value || null;

  await service.from('bookings').insert({
    id: BOOKING_DEFAULT, org_id: 'org_default', event_id: 'event_default', status: 'Payment Requested',
    business_name: 'E5-04 Default Test Co', owner_name: 'Test Owner', email: 'trader@example.test',
    instance_prefix: 'org_default-', booking_type: 'general', payment_link_code: `${BOOKING_DEFAULT}-code`, stall_cost: 50,
  });
});

after(async () => {
  await service.from('payments').delete().eq('booking_id', BOOKING_B2);
  await service.from('bookings').delete().eq('id', BOOKING_B2);
  await cleanupOrg(ORG_A, EVENT_A, BOOKING_A);
  await cleanupOrg(ORG_B, EVENT_B, BOOKING_B);
  await cleanupOrg(ORG_DUP1, null, null);
  await cleanupOrg(ORG_DUP2, null, null);
  await cleanupOrg(ORG_SAMEMODE, null, null);
  await service.from('payments').delete().eq('booking_id', BOOKING_DEFAULT);
  await service.from('bookings').delete().eq('id', BOOKING_DEFAULT);
});

describe('E5-04 Option B: multi-tenant Stripe webhook resolution', () => {
  test('A: org_default\'s existing real webhook secret still verifies successfully (regression guard)', async () => {
    if (!orgDefaultSecret) {
      // No TEST_STRIPE_WEBHOOK_SECRET configured in this environment -
      // nothing to regress-test against; skip rather than fail on
      // environment absence unrelated to this change.
      return;
    }
    const payload = checkoutCompletedPayload(BOOKING_DEFAULT, 'default');
    const signature = signStripePayload(payload, orgDefaultSecret);
    const { status, json } = await postWebhook(payload, signature);
    assert.equal(status, 200, JSON.stringify(json));

    const { data: booking } = await service.from('bookings').select('status').eq('id', BOOKING_DEFAULT).single();
    assert.equal(booking.status, 'Confirmed');
    const { data: payment } = await service.from('payments').select('org_id, paid').eq('booking_id', BOOKING_DEFAULT).single();
    assert.equal(payment.org_id, 'org_default');
    assert.equal(payment.paid, true);
  });

  test('B: Org A\'s webhook verifies successfully and resolves to Org A (full payment-state proof)', async () => {
    const payload = checkoutCompletedPayload(BOOKING_A, 'orga');
    const signature = signStripePayload(payload, SECRET_A);
    const { status, json } = await postWebhook(payload, signature);
    assert.equal(status, 200, JSON.stringify(json));

    const { data: booking } = await service.from('bookings').select('status, org_id').eq('id', BOOKING_A).single();
    assert.equal(booking.status, 'Confirmed');
    assert.equal(booking.org_id, ORG_A);
    const { data: payment } = await service.from('payments').select('org_id, paid').eq('booking_id', BOOKING_A).single();
    assert.equal(payment.org_id, ORG_A, 'the payment must be tagged with Org A, not org_default and not Org B');
    assert.equal(payment.paid, true);
  });

  test('C: Org B\'s webhook verifies successfully and resolves to Org B', async () => {
    const payload = checkoutCompletedPayload(BOOKING_B, 'orgb');
    const signature = signStripePayload(payload, SECRET_B);
    const { status, json } = await postWebhook(payload, signature);
    assert.equal(status, 200, JSON.stringify(json));

    const { data: payment } = await service.from('payments').select('org_id, paid').eq('booking_id', BOOKING_B).single();
    assert.equal(payment.org_id, ORG_B);
    assert.equal(payment.paid, true);
  });

  test('D: an invalid signature (wrong secret) is rejected', async () => {
    const payload = checkoutCompletedPayload(BOOKING_A, 'invalidsig');
    const signature = signStripePayload(payload, SECRET_WRONG);
    const { status } = await postWebhook(payload, signature);
    assert.equal(status, 400);
  });

  test('F: a signature matching no organisation\'s configured secret is safely rejected (same code path as D under this design - see file header)', async () => {
    const payload = checkoutCompletedPayload(BOOKING_A, 'nocandidate');
    const signature = signStripePayload(payload, `whsec_never_registered_${RUN_ID}`);
    const { status } = await postWebhook(payload, signature);
    assert.equal(status, 400);
  });
});

describe('E5-04 Option B: cross-organisation isolation', () => {
  test('E/H: Org A\'s secret cannot be used to process a booking that belongs to Org B', async () => {
    // Correctly signed with Org A's OWN secret, but the payload references
    // a Org B booking (BOOKING_B2, still Payment Requested - BOOKING_B
    // itself is legitimately confirmed by Test C above) - must be
    // acknowledged without processing, not silently confirmed under Org A's
    // identity.
    const payload = checkoutCompletedPayload(BOOKING_B2, 'crosstenant');
    const signature = signStripePayload(payload, SECRET_A);
    const { status } = await postWebhook(payload, signature);
    assert.equal(status, 200, 'acknowledged, not retried - see design report\'s consistency-check reasoning');

    const { data: booking } = await service.from('bookings').select('status').eq('id', BOOKING_B2).single();
    assert.equal(booking.status, 'Payment Requested', 'Org B\'s booking must be completely unaffected by an event verified under Org A\'s secret');
    const { data: payment } = await service.from('payments').select('id').eq('booking_id', BOOKING_B2);
    assert.equal((payment || []).length, 0, 'no payment must be recorded for Org B from an Org-A-verified event');
  });
});

describe('E5-04 Option B: ambiguous configuration is rejected, never arbitrarily resolved', () => {
  test('G: the same secret configured on two DIFFERENT organisations is rejected as ambiguous', async () => {
    const payload = checkoutCompletedPayload('irrelevant-booking-id', 'crossdup');
    const signature = signStripePayload(payload, SECRET_CROSS_DUP);
    const { status, json } = await postWebhook(payload, signature);
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error || '', /ambiguous/i);
  });

  test('same-organisation test/live mode ambiguity: identical secret on Org A\'s own test AND live settings is rejected', async () => {
    const payload = checkoutCompletedPayload('irrelevant-booking-id', 'samemodedup');
    const signature = signStripePayload(payload, SECRET_SAMEMODE_DUP);
    const { status, json } = await postWebhook(payload, signature);
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error || '', /ambiguous/i);
  });
});
