// Stripe Checkout payment collection tests, against the disposable "test
// backup" Supabase project only - see integration.test.mjs for the same
// guard. The create-checkout-session success-path tests additionally
// require create-checkout-session/stripe-webhook to be deployed to the test
// project, and a Stripe Test-mode key/webhook secret seeded into that
// project's OWN settings table (not this file's .env.test, which only
// configures the local Node test process) - `npm run test:setup` does this
// automatically from TEST_STRIPE_SECRET_KEY/TEST_STRIPE_WEBHOOK_SECRET, same
// as every other settings-table row this suite depends on.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service, callEdgeFunction, fetchEdgeFunction } from './helpers.mjs';

const anon = createClient(url, anonKey);

// Cloudflare's documented always-passes dummy token, same constant used in
// integration.test.mjs/public-error-sanitisation.test.mjs - get-payment-link
// now verifies Turnstile too, since it can create real Stripe sessions.
const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

async function fetchStripeSession(sessionId) {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${process.env.TEST_STRIPE_SECRET_KEY}` },
  });
  return res.json();
}

let adminToken;
// Own prefix (ESF26-TESTSTRIPE-) so this file's cleanup wildcard can never
// collide with integration.test.mjs/workflow.test.mjs/security.test.mjs
// fixtures sharing the one remote database (--test-concurrency=1 keeps
// files from running at the same time, but each still needs a distinct
// prefix for its own before/after wildcard deletes to be safe).
const PREFIX = 'ESF26-TESTSTRIPE-';

before(async () => {
  const { data, error } = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminToken = data.session.access_token;

  await service.from('bookings').delete().like('id', `${PREFIX}%`);
  await service.from('stripe_webhook_events').delete().like('event_id', 'evt_test_%');
  await service.from('settings').delete().eq('key', 'stripe_test_mode');
  // The payment_requested SMS tests below embed the booking id (which
  // carries this file's own PREFIX) in the message body — clean those up
  // too, or a leftover row from a prior run collides with the next run's
  // exact-count assertion (ilike '%id%' then matches 2 rows, not 1).
  await service.from('sms_queue').delete().ilike('body', `%${PREFIX}%`);
  // Same reasoning for the sms_sent audit_logs row create-checkout-session
  // now writes on a successful send.
  await service.from('audit_logs').delete().like('target_id', `${PREFIX}%`);
});

after(async () => {
  await service.from('bookings').delete().like('id', `${PREFIX}%`);
  await service.from('stripe_webhook_events').delete().like('event_id', 'evt_test_%');
  await service.from('settings').delete().eq('key', 'stripe_test_mode');
  // The payment_requested SMS tests below embed the booking id (which
  // carries this file's own PREFIX) in the message body — clean those up
  // too, or a leftover row from a prior run collides with the next run's
  // exact-count assertion (ilike '%id%' then matches 2 rows, not 1).
  await service.from('sms_queue').delete().ilike('body', `%${PREFIX}%`);
  // Same reasoning for the sms_sent audit_logs row create-checkout-session
  // now writes on a successful send.
  await service.from('audit_logs').delete().like('target_id', `${PREFIX}%`);
});

const callFunction = callEdgeFunction;

async function insertBooking(id, overrides = {}) {
  const { error } = await service.from('bookings').insert({
    id,
    status: 'Pending',
    business_name: `Stripe Test ${id}`,
    owner_name: 'Test Owner',
    email: 'stripe-test@example.test',
    instance_prefix: 'ESF26-DEV-',
    stall_type: 'Food',
    ...overrides,
  });
  if (error) throw new Error(`Fixture setup failed for ${id}: ${error.message}`);
}

describe('finalize_stripe_payment RPC', () => {
  test('anon cannot call it directly', async () => {
    const { error } = await anon.rpc('finalize_stripe_payment', { p_booking_id: 'x', p_payment_intent_id: 'pi_x' });
    assert.ok(error, 'expected anon to be rejected calling finalize_stripe_payment');
  });

  test('happy path: Payment Requested -> Confirmed (with payments row), atomically, in one call', async () => {
    const id = `${PREFIX}HAPPY`;
    await insertBooking(id, { status: 'Payment Requested', stall_cost: 15 });

    const { error: rpcErr } = await service.rpc('finalize_stripe_payment', {
      p_booking_id: id,
      p_payment_intent_id: 'pi_test_happy_001',
    });
    assert.equal(rpcErr, null, rpcErr?.message);

    const { data: booking } = await service.from('bookings').select('status, stripe_payment_intent_id, date_confirmed').eq('id', id).single();
    assert.equal(booking.status, 'Confirmed');
    assert.equal(booking.stripe_payment_intent_id, 'pi_test_happy_001');
    assert.ok(booking.date_confirmed);

    const { data: payment } = await service.from('payments').select('*').eq('booking_id', id).single();
    assert.equal(payment.paid, true);
    assert.equal(payment.editor, 'Stripe (automatic)');
    assert.ok(payment.bank_ref.includes('pi_test_happy_001'));
    // Added alongside the bank-transfer payments feature (see
    // tests/bank-transfer-payment.test.mjs) — proves the additive
    // finalize_stripe_payment change didn't break this existing flow and
    // that the new classification column is populated going forward.
    assert.equal(payment.payment_method, 'stripe');
  });

  test('no-ops if the booking is not Payment Requested', async () => {
    const id = `${PREFIX}NOOP1`;
    await insertBooking(id, { status: 'Cancelled' });

    const { error } = await service.rpc('finalize_stripe_payment', { p_booking_id: id, p_payment_intent_id: 'pi_test_noop' });
    assert.equal(error, null, error?.message);

    const { data: booking } = await service.from('bookings').select('status').eq('id', id).single();
    assert.equal(booking.status, 'Cancelled', 'status must be untouched');

    const { data: payment } = await service.from('payments').select('booking_id').eq('booking_id', id).maybeSingle();
    assert.equal(payment, null, 'no payments row should have been created');
  });

  test('re-calling after the booking already progressed is a safe no-op (duplicate webhook delivery)', async () => {
    const id = `${PREFIX}IDEMPOTENT`;
    await insertBooking(id, { status: 'Payment Requested', stall_cost: 20 });

    await service.rpc('finalize_stripe_payment', { p_booking_id: id, p_payment_intent_id: 'pi_test_first' });
    // Simulate a duplicate webhook delivery of the SAME event, arriving
    // after the booking already moved to 'Confirmed' (status guard should
    // prevent a second write / clobber).
    const { error } = await service.rpc('finalize_stripe_payment', { p_booking_id: id, p_payment_intent_id: 'pi_test_duplicate' });
    assert.equal(error, null, error?.message);

    const { data: booking } = await service.from('bookings').select('status, stripe_payment_intent_id').eq('id', id).single();
    assert.equal(booking.status, 'Confirmed');
    assert.equal(booking.stripe_payment_intent_id, 'pi_test_first', 'the duplicate call must not overwrite the original payment intent id');
  });
});

describe('stripe_webhook_events ledger', () => {
  test('anon cannot read or write it', async () => {
    const { error: selErr } = await anon.from('stripe_webhook_events').select('*').limit(1);
    assert.ok(selErr, 'expected anon SELECT to be rejected (no table grant)');

    const { error: insErr } = await anon.from('stripe_webhook_events').insert({ event_id: 'evt_test_anon', event_type: 'test' });
    assert.ok(insErr, 'expected anon INSERT to be rejected (no table grant)');
  });

  test('duplicate event_id insert conflicts (this is the email-send dedup mechanism)', async () => {
    const eventId = 'evt_test_dedupe_001';
    const { error: firstErr } = await service.from('stripe_webhook_events').insert({ event_id: eventId, event_type: 'checkout.session.completed' });
    assert.equal(firstErr, null, firstErr?.message);

    const { error: secondErr } = await service.from('stripe_webhook_events').insert({ event_id: eventId, event_type: 'checkout.session.completed' });
    assert.ok(secondErr, 'expected a unique-violation on the second insert of the same event_id');
    assert.equal(secondErr.code, '23505');
  });
});

describe('create-checkout-session', () => {
  test('rejects an unauthenticated request', async () => {
    const { status } = await callFunction('create-checkout-session', { booking_id: 'x' }, anonKey);
    assert.equal(status, 401);
  });

  test('rejects a booking that is already resolved (Confirmed/Paid/Rejected/Cancelled)', async () => {
    const id = `${PREFIX}WRONGSTATUS`;
    await insertBooking(id, { status: 'Confirmed', stall_cost: 10 });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('rejects a booking with no stall cost set and no cost override', async () => {
    const id = `${PREFIX}NOCOST`;
    await insertBooking(id, { status: 'Pending', stall_cost: null });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('rejects a booking with a £0 stall cost (should never reach here — free bookings skip Stripe)', async () => {
    const id = `${PREFIX}ZEROCOST`;
    await insertBooking(id, { status: 'Pending', stall_cost: 0 });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('rejects an explicit £0 cost override too', async () => {
    const id = `${PREFIX}ZEROOVERRIDE`;
    await insertBooking(id, { status: 'Pending', stall_cost: null });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id, cost: 0 }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('moves the booking to Payment Requested and freezes stripe_requested_cost, without creating a Stripe session yet', async () => {
    // No Stripe API call happens here anymore - get-payment-link creates
    // the real Checkout Session lazily, the first time the stallholder
    // actually clicks the link, so it's never more than moments old
    // regardless of how long they wait to click.
    const id = `${PREFIX}CHECKOUT`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5 });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(json.payment_link && json.payment_link.includes('/pay.html?token='), `expected the short pay.html redirect, got: ${json.payment_link}`);

    const { data: booking } = await service.from('bookings')
      .select('status, stall_cost, stripe_requested_cost, stripe_checkout_session_id, stripe_checkout_url, stripe_payment_requested_at')
      .eq('id', id)
      .single();
    assert.equal(booking.status, 'Payment Requested');
    assert.equal(Number(booking.stall_cost), 12.5);
    assert.equal(Number(booking.stripe_requested_cost), 12.5, 'the cost must be frozen at request time');
    assert.equal(booking.stripe_checkout_session_id, null, 'no Stripe session should exist until the stallholder actually clicks the link');
    assert.equal(booking.stripe_checkout_url, null);
    assert.ok(booking.stripe_payment_requested_at);
  });

  // Reported live as a gap: the Confirm modal's "also send a text" tickbox
  // used to be silently dropped once the admin picked "Chargeable" — no
  // send_sms param existed at all on this endpoint, so ticking it never sent
  // anything. sms_provider is 'mock' in the test project, so this asserts a
  // real Sent row, not just "no error".
  test('send_sms: true also sends a payment_requested SMS when the booking has a phone number', async () => {
    const id = `${PREFIX}CHECKOUTSMS`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5, phone: '07000000000' });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id, send_sms: true }, adminToken);
    assert.equal(status, 200, JSON.stringify(json));

    const { data: booking } = await service.from('bookings')
      .select('stripe_checkout_url, payment_link_code')
      .eq('id', id)
      .single();
    assert.equal(booking.stripe_checkout_url, null, 'no Stripe session is created until get-payment-link is actually clicked');
    assert.match(booking.payment_link_code || '', /^[A-Za-z0-9_-]{8}$/, 'expected the DEFAULT-generated 8-char url-safe payment_link_code');

    const { data: rows } = await service
      .from('sms_queue')
      .select('*')
      .ilike('body', `%${id}%`);
    assert.equal(rows.length, 1, 'expected exactly one sms_queue row logged for this payment request');
    assert.equal(rows[0].recipient, '+447000000000');
    assert.equal(rows[0].status, 'Sent');
    assert.match(rows[0].provider_message_id || '', /^mock-/);
    assert.ok(!rows[0].body.includes('checkout.stripe.com'), 'the SMS must not carry the raw Stripe checkout link');
    assert.ok(
      rows[0].body.includes(`/pay.html?token=${encodeURIComponent(booking.payment_link_code)}`),
      'the SMS must carry the short pay.html redirect link, keyed on the short payment_link_code'
    );

    // Every other SMS send path audits via sendBookingSms (js/api.js); this
    // one didn't, so a booking's audit trail couldn't tell whether a
    // payment request came with a text - fixed alongside the NOT NULL
    // migration above.
    const { data: auditRows } = await service
      .from('audit_logs')
      .select('*')
      .eq('action', 'sms_sent')
      .eq('target_id', id);
    assert.equal(auditRows.length, 1, 'expected exactly one sms_sent audit_logs row for this payment request');
    // details is a text column (see page-audit-log.js's renderDetailsCell,
    // which JSON.parses it for display) - stored as a JSON string, not jsonb.
    const auditDetails = JSON.parse(auditRows[0].details);
    assert.equal(auditDetails.recipient, '+447000000000');
    assert.equal(auditDetails.segments, rows[0].segments);
    assert.equal(auditDetails.provider_message_id, rows[0].provider_message_id);
  });

  test('omitting send_sms sends no SMS at all, even with a phone number on file', async () => {
    const id = `${PREFIX}CHECKOUTNOSMS`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5, phone: '07000000000' });

    const { status } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 200);

    const { data: rows } = await service.from('sms_queue').select('*').ilike('body', `%${id}%`);
    assert.equal(rows.length, 0, 'expected no sms_queue row when send_sms was not set');
  });

  test('the database rejects a null payment_link_code outright', async () => {
    const id = `${PREFIX}NULLLINKCODE`;
    // Migration 20260731160000 added a NOT NULL constraint on top of the
    // DEFAULT + backfill from 20260731110000. Before that migration, a
    // booking inserted outside the normal flow (bulk import, manual fix)
    // could still end up with a null payment_link_code, and only
    // create-checkout-session's app-level guard (see the comment above its
    // `if (!booking.payment_link_code)` check) would catch it. Now the
    // insert itself is rejected, so the scenario the guard defends against
    // can no longer be constructed at all - this asserts the DB enforces it
    // directly rather than routing through the function.
    const { error } = await service.from('bookings').insert({
      id,
      status: 'Pending',
      business_name: `Stripe Test ${id}`,
      owner_name: 'Test Owner',
      email: 'stripe-test@example.test',
      instance_prefix: 'ESF26-DEV-',
      stall_type: 'Food',
      phone: '07000000000',
      payment_link_code: null,
    });
    assert.ok(error, 'expected the NOT NULL constraint to reject this insert');
    assert.match(error.message, /payment_link_code/);
  });

  test('accepts a cost override in the request body (chargeable-confirm now fires with no prior persisted stall_cost) and saves it', async () => {
    const id = `${PREFIX}COSTOVERRIDE`;
    await insertBooking(id, { status: 'Pending', stall_cost: null });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id, cost: 22.5 }, adminToken);
    assert.equal(status, 200, JSON.stringify(json));

    const { data: booking } = await service.from('bookings').select('status, stall_cost').eq('id', id).single();
    assert.equal(booking.status, 'Payment Requested');
    assert.equal(Number(booking.stall_cost), 22.5);
  });

  test('a second request within the double-click window is rejected, not a duplicate session', async () => {
    const id = `${PREFIX}DOUBLECLICK`;
    await insertBooking(id, { status: 'Pending', stall_cost: 8 });

    const first = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(first.status, 200, JSON.stringify(first.json));

    const second = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(second.status, 429, JSON.stringify(second.json));
  });

  // Stripe mode resolution (live-by-default for Food/General, forced test
  // mode via the setting) moved to get-payment-link's own tests below —
  // that's where the actual Stripe API call now happens.
});

describe('get-payment-link', () => {
  // Public/unauthenticated — this is what pay.html calls, and it now creates
  // real Stripe Checkout Sessions lazily (the first time a stallholder
  // actually clicks), rather than just looking up one create-checkout-session
  // already made. That's why it needs the same Turnstile gate submit-booking/
  // cancel-booking already have — a public endpoint that can spend money must
  // not be a bare, ungated lookup — but still no admin-JWT requirement
  // (mirrors cancel-booking, not create-checkout-session).
  test('rejects a missing paymentToken', async () => {
    const { status } = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN }, anonKey);
    assert.equal(status, 400);
  });

  test('rejects a missing Turnstile token', async () => {
    const { status, json } = await callFunction('get-payment-link', { paymentToken: 'AAAAAAAA' }, anonKey);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, /CAPTCHA/i);
  });

  test('rejects a paymentToken that matches no booking', async () => {
    const { status, json } = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: 'AAAAAAAA' }, anonKey);
    assert.equal(status, 404, JSON.stringify(json));
  });

  test('lazily creates a real Stripe Test-mode Checkout Session on first click, using the frozen cost', async () => {
    const id = `${PREFIX}PAYLINK`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5 });
    const created = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(created.status, 200, JSON.stringify(created.json));

    const { data: before } = await service.from('bookings').select('payment_link_code, stripe_checkout_session_id').eq('id', id).single();
    assert.equal(before.stripe_checkout_session_id, null, 'sanity check: no session yet before the click');

    const { status, json } = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: before.payment_link_code }, anonKey);
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(json.checkout_url && json.checkout_url.startsWith('https://checkout.stripe.com/'), `expected a real Stripe Checkout URL, got: ${json.checkout_url}`);

    const { data: after } = await service.from('bookings').select('stripe_checkout_url, stripe_checkout_session_id').eq('id', id).single();
    assert.equal(after.stripe_checkout_url, json.checkout_url, 'the created session must be persisted for reuse on a repeat click');
    assert.ok(after.stripe_checkout_session_id);

    const stripeSession = await fetchStripeSession(after.stripe_checkout_session_id);
    assert.equal(stripeSession.amount_total, 1250, 'expected the session to charge the frozen 12.50, in pence');
  });

  test('a repeat click within the freshness window reuses the same session rather than creating a second one', async () => {
    const id = `${PREFIX}PAYLINKREUSE`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5 });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();

    const first = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: booking.payment_link_code }, anonKey);
    assert.equal(first.status, 200, JSON.stringify(first.json));

    const second = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: booking.payment_link_code }, anonKey);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.checkout_url, first.json.checkout_url, 'a fresh session must not be created for a repeat click');
  });

  test('refuses a paymentToken whose booking has moved on (no longer Payment Requested)', async () => {
    const id = `${PREFIX}PAYLINKSTALE`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5 });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);

    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();
    await service.from('bookings').update({ status: 'Cancelled' }).eq('id', id);

    const { status, json } = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: booking.payment_link_code }, anonKey);
    // 409, not a generic 400 - a terminal state the frontend uses to hide
    // the Continue button (reported live: it stayed visible next to this
    // exact message after paying via one channel and clicking the link
    // from the other).
    assert.equal(status, 409, JSON.stringify(json));
  });

  test('regenerates a fresh session after 24h instead of reusing (or rejecting) the stale one', async () => {
    const id = `${PREFIX}PAYLINKEXPIRED`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5 });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();

    const first = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: booking.payment_link_code }, anonKey);
    assert.equal(first.status, 200, JSON.stringify(first.json));

    // Backdate as if that first session was created 25 hours ago - past
    // Stripe's default 24h Checkout Session expiry - so this doesn't depend
    // on a real Stripe session actually expiring. stripe_session_claimed_at
    // is the claim RPC's own freshness column - NOT stripe_payment_requested_at,
    // which create-checkout-session owns for its unrelated double-click guard.
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await service.from('bookings').update({ stripe_session_claimed_at: twentyFiveHoursAgo }).eq('id', id);

    const second = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: booking.payment_link_code }, anonKey);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.notEqual(second.json.checkout_url, first.json.checkout_url, 'expected a genuinely new session, not the 25h-old one');
  });

  test('an unfulfilled claim (no checkout_url stored) is re-claimable after the short lease, without waiting out the 24h freshness window', async () => {
    const id = `${PREFIX}PAYLINKUNFULFILLED`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5 });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();

    // Simulates the crash this migration (20260731180000) exists for: a
    // claim was taken (stripe_session_claimed_at set) but the Stripe API
    // call failed and its revert never ran, so stripe_checkout_url is still
    // null. Backdated 3 minutes - past the default 2-minute unfulfilled-claim
    // lease, but nowhere near the 24h freshness window a fulfilled session
    // would still get.
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await service.from('bookings').update({ stripe_session_claimed_at: threeMinutesAgo }).eq('id', id);

    const { data: claimed, error: claimErr } = await service.rpc('rpc_claim_stripe_session_slot', {
      p_payment_link_code: booking.payment_link_code,
      p_freshness_seconds: 86400,
      p_unfulfilled_claim_seconds: 120,
    });
    assert.equal(claimErr, null, claimErr?.message);
    assert.equal(claimed.length, 1, 'an unfulfilled claim older than the short lease must be re-claimable, not stuck for the full 24h freshness window');
  });

  test('an unfulfilled claim within the short lease is NOT yet re-claimable', async () => {
    const id = `${PREFIX}PAYLINKUNFULFILLEDFRESH`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5 });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();

    // Claimed moments ago, no checkout_url yet - indistinguishable (from
    // this RPC's point of view) from a request that's still genuinely
    // waiting on Stripe's response.
    const { data: firstClaim } = await service.rpc('rpc_claim_stripe_session_slot', {
      p_payment_link_code: booking.payment_link_code, p_freshness_seconds: 86400, p_unfulfilled_claim_seconds: 120,
    });
    assert.equal(firstClaim.length, 1);

    const { data: secondClaim, error: claimErr } = await service.rpc('rpc_claim_stripe_session_slot', {
      p_payment_link_code: booking.payment_link_code, p_freshness_seconds: 86400, p_unfulfilled_claim_seconds: 120,
    });
    assert.equal(claimErr, null, claimErr?.message);
    assert.equal(secondClaim.length, 0, 'a claim only seconds old must not be re-claimable — it may still be genuinely in flight');
  });

  // Same technique as email-retry.test.mjs/sms-send.test.mjs's own
  // "the row claim is atomic" tests: two genuinely concurrent DB calls via
  // Promise.all, not two HTTP requests (whose network timing can't
  // guarantee real overlap and would make this test unreliably flaky).
  test('rpc_claim_stripe_session_slot is atomic: only one of two concurrent claims wins', async () => {
    const id = `${PREFIX}PAYLINKCLAIMRACE`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12.5 });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();

    const [c1, c2] = await Promise.all([
      service.rpc('rpc_claim_stripe_session_slot', { p_payment_link_code: booking.payment_link_code, p_freshness_seconds: 86400 }),
      service.rpc('rpc_claim_stripe_session_slot', { p_payment_link_code: booking.payment_link_code, p_freshness_seconds: 86400 }),
    ]);

    const winners = [c1, c2].filter((r) => (r.data || []).length > 0);
    assert.equal(winners.length, 1,
      `exactly one concurrent claim should match, got ${winners.length} - ` +
      `two winners would mean two callers could both create a real Stripe session for the same booking`);
  });

  // Stripe mode resolution now happens here, at click-time, rather than in
  // create-checkout-session - these two moved from that describe block.
  test('a Food/General booking uses the LIVE key by default (fails safely here, since the test project deliberately has no live key configured)', async () => {
    await service.from('settings').delete().eq('key', 'stripe_test_mode');

    const id = `${PREFIX}LIVEBYDEFAULT`;
    await insertBooking(id, { status: 'Pending', stall_cost: 9, instance_prefix: 'ESF26-FOOD-' });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();

    // get-payment-link is public, so unlike create-checkout-session's own
    // (admin-only) detailed errors, this goes through the same sanitised
    // path submit-booking/cancel-booking use — the caller sees a generic
    // reference-coded message, never the raw config error.
    const { status, json } = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: booking.payment_link_code }, anonKey);
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error, /reference [A-Z0-9]{6}/i);
    assert.doesNotMatch(json.error, /stripe_secret_key_live/, 'the internal config error must never reach a public caller');
  });

  test('turning on stripe_test_mode forces Test Mode for a Food/General booking too', async () => {
    const { error: settingErr } = await service.from('settings').upsert({ key: 'stripe_test_mode', value: 'true' });
    assert.equal(settingErr, null, settingErr?.message);

    const id = `${PREFIX}FORCEDTESTMODE`;
    await insertBooking(id, { status: 'Pending', stall_cost: 9, instance_prefix: 'ESF26-FOOD-' });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();

    const { status, json } = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: booking.payment_link_code }, anonKey);
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(json.checkout_url && json.checkout_url.startsWith('https://checkout.stripe.com/'), `expected a real Stripe Test-mode Checkout URL for a Food/General booking with the setting on, got: ${json.checkout_url}`);

    await service.from('settings').delete().eq('key', 'stripe_test_mode');
  });

  test('the frozen stripe_requested_cost survives an unrelated stall_cost edit made while payment is outstanding', async () => {
    const id = `${PREFIX}FROZENCOST`;
    await insertBooking(id, { status: 'Pending', stall_cost: 20 });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();

    // Simulate an admin editing the booking's cost via Update Details for
    // record-keeping, after payment was already requested at the old price.
    await service.from('bookings').update({ stall_cost: 999 }).eq('id', id);

    const { status, json } = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: booking.payment_link_code }, anonKey);
    assert.equal(status, 200, JSON.stringify(json));

    const { data: after } = await service.from('bookings').select('stripe_checkout_session_id, stripe_requested_cost').eq('id', id).single();
    assert.equal(Number(after.stripe_requested_cost), 20, 'stripe_requested_cost must not have moved');

    const stripeSession = await fetchStripeSession(after.stripe_checkout_session_id);
    assert.equal(stripeSession.amount_total, 2000, 'the stallholder must be charged the originally-quoted £20, not the £999 later edit');
  });

  test('resending a payment request expires the OLD Stripe session, not just clearing it locally', async () => {
    const id = `${PREFIX}RESENDEXPIRES`;
    await insertBooking(id, { status: 'Pending', stall_cost: 20 });
    await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    const { data: booking } = await service.from('bookings').select('payment_link_code').eq('id', id).single();

    // Stallholder clicks once at the original £20 quote - a real Stripe
    // session now exists.
    const first = await callFunction('get-payment-link', { token: TURNSTILE_TEST_TOKEN, paymentToken: booking.payment_link_code }, anonKey);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const { data: beforeResend } = await service.from('bookings').select('stripe_checkout_session_id').eq('id', id).single();
    const oldSessionId = beforeResend.stripe_checkout_session_id;
    assert.ok(oldSessionId);

    // Clear DUPLICATE_REQUEST_WINDOW_MS's double-click guard (10s), which
    // this test would otherwise hit immediately - it's testing the resend
    // itself, not that guard.
    const twentySecondsAgo = new Date(Date.now() - 20_000).toISOString();
    await service.from('bookings').update({ stripe_payment_requested_at: twentySecondsAgo }).eq('id', id);

    // Admin corrects the price and resends, before the stallholder pays.
    const resend = await callFunction('create-checkout-session', { booking_id: id, cost: 30 }, adminToken);
    assert.equal(resend.status, 200, JSON.stringify(resend.json));

    // Without this fix, a stallholder who'd bookmarked the raw
    // checkout.stripe.com URL from the first click could still complete
    // payment on it at the old £20, even after this resend intentionally
    // changed the price to £30.
    const oldSession = await fetchStripeSession(oldSessionId);
    assert.equal(oldSession.status, 'expired', 'the previous session must be expired at Stripe, not just unlinked locally');
  });
});

describe('stripe-webhook', () => {
  test('rejects a request with no Stripe-Signature header', async () => {
    const res = await fetchEdgeFunction('stripe-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert.equal(res.status, 400);
  });

  test('rejects a request with an invalid signature', async () => {
    const res = await fetchEdgeFunction('stripe-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey, 'stripe-signature': 't=1,v1=not_a_real_signature' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert.equal(res.status, 400);
  });
});

describe('free (£0) bookings skip Stripe entirely', () => {
  test('a booking finalized as free never creates a payments row or touches Stripe columns', async () => {
    // Mirrors the free branch of finalizeConfirmation for a £0/free booking
    // — this is the exact application logic path (js/api.js), tested here
    // at the DB level (no browser/ESM import available in this Node test
    // runner, same approach the rest of this suite already uses for
    // app-logic assertions).
    const id = `${PREFIX}FREE`;
    await insertBooking(id, { status: 'Pending' });

    await service.from('bookings').update({ status: 'Confirmed', stall_cost: 0, date_confirmed: new Date().toISOString() }).eq('id', id);
    await service.from('payments').delete().eq('booking_id', id);

    const { data: booking } = await service.from('bookings').select('status, stall_cost').eq('id', id).single();
    assert.equal(booking.status, 'Confirmed');
    assert.equal(Number(booking.stall_cost), 0);

    const { data: payment } = await service.from('payments').select('booking_id').eq('booking_id', id).maybeSingle();
    assert.equal(payment, null, 'a free booking must never have a payments row');
  });
});
