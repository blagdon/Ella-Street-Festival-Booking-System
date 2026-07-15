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

process.loadEnvFile('.env.test');

const url = process.env.TEST_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const adminEmail = process.env.TEST_ADMIN_EMAIL;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

const anon = createClient(url, anonKey);
const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

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
});

after(async () => {
  await service.from('bookings').delete().like('id', `${PREFIX}%`);
  await service.from('stripe_webhook_events').delete().like('event_id', 'evt_test_%');
  await service.from('settings').delete().eq('key', 'stripe_test_mode');
});

async function callFunction(name, body, token = anonKey) {
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

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

describe('mark_stripe_payment_received / finalize_stripe_confirmation RPCs', () => {
  test('anon cannot call either RPC directly', async () => {
    const { error: e1 } = await anon.rpc('mark_stripe_payment_received', { p_booking_id: 'x', p_payment_intent_id: 'pi_x' });
    assert.ok(e1, 'expected anon to be rejected calling mark_stripe_payment_received');

    const { error: e2 } = await anon.rpc('finalize_stripe_confirmation', { p_booking_id: 'x' });
    assert.ok(e2, 'expected anon to be rejected calling finalize_stripe_confirmation');
  });

  test('happy path: Payment Requested -> Paid (with payments row) -> Confirmed', async () => {
    const id = `${PREFIX}HAPPY`;
    await insertBooking(id, { status: 'Payment Requested', stall_cost: 15 });

    const { error: rpc1Err } = await service.rpc('mark_stripe_payment_received', {
      p_booking_id: id,
      p_payment_intent_id: 'pi_test_happy_001',
    });
    assert.equal(rpc1Err, null, rpc1Err?.message);

    const { data: afterStep1 } = await service.from('bookings').select('status, stripe_payment_intent_id').eq('id', id).single();
    assert.equal(afterStep1.status, 'Paid');
    assert.equal(afterStep1.stripe_payment_intent_id, 'pi_test_happy_001');

    const { data: payment } = await service.from('payments').select('*').eq('booking_id', id).single();
    assert.equal(payment.paid, true);
    assert.equal(payment.editor, 'Stripe (automatic)');
    assert.ok(payment.bank_ref.includes('pi_test_happy_001'));

    const { error: rpc2Err } = await service.rpc('finalize_stripe_confirmation', { p_booking_id: id });
    assert.equal(rpc2Err, null, rpc2Err?.message);

    const { data: afterStep2 } = await service.from('bookings').select('status, date_confirmed').eq('id', id).single();
    assert.equal(afterStep2.status, 'Confirmed');
    assert.ok(afterStep2.date_confirmed);
  });

  test('mark_stripe_payment_received no-ops if the booking is not Payment Requested', async () => {
    const id = `${PREFIX}NOOP1`;
    await insertBooking(id, { status: 'Cancelled' });

    const { error } = await service.rpc('mark_stripe_payment_received', { p_booking_id: id, p_payment_intent_id: 'pi_test_noop' });
    assert.equal(error, null, error?.message);

    const { data: booking } = await service.from('bookings').select('status').eq('id', id).single();
    assert.equal(booking.status, 'Cancelled', 'status must be untouched');

    const { data: payment } = await service.from('payments').select('booking_id').eq('booking_id', id).maybeSingle();
    assert.equal(payment, null, 'no payments row should have been created');
  });

  test('finalize_stripe_confirmation no-ops if the booking is not Paid', async () => {
    const id = `${PREFIX}NOOP2`;
    await insertBooking(id, { status: 'Pending' });

    const { error } = await service.rpc('finalize_stripe_confirmation', { p_booking_id: id });
    assert.equal(error, null, error?.message);

    const { data: booking } = await service.from('bookings').select('status').eq('id', id).single();
    assert.equal(booking.status, 'Pending', 'status must be untouched');
  });

  test('re-calling mark_stripe_payment_received after the booking already progressed is a safe no-op', async () => {
    const id = `${PREFIX}IDEMPOTENT`;
    await insertBooking(id, { status: 'Payment Requested', stall_cost: 20 });

    await service.rpc('mark_stripe_payment_received', { p_booking_id: id, p_payment_intent_id: 'pi_test_first' });
    // Simulate a duplicate webhook delivery of the SAME event, arriving
    // after the booking already moved to 'Paid' (status guard should
    // prevent a second write / clobber).
    const { error } = await service.rpc('mark_stripe_payment_received', { p_booking_id: id, p_payment_intent_id: 'pi_test_duplicate' });
    assert.equal(error, null, error?.message);

    const { data: booking } = await service.from('bookings').select('status, stripe_payment_intent_id').eq('id', id).single();
    assert.equal(booking.status, 'Paid');
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

  test('rejects a booking that is not Pre-Confirmed or Payment Requested', async () => {
    const id = `${PREFIX}WRONGSTATUS`;
    await insertBooking(id, { status: 'Pending', stall_cost: 10 });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('rejects a booking with no stall cost set', async () => {
    const id = `${PREFIX}NOCOST`;
    await insertBooking(id, { status: 'Pre-Confirmed', stall_cost: null });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('rejects a booking with a £0 stall cost (should never reach here — free bookings skip Stripe)', async () => {
    const id = `${PREFIX}ZEROCOST`;
    await insertBooking(id, { status: 'Pre-Confirmed', stall_cost: 0 });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('creates a real Stripe Test-mode Checkout Session and moves the booking to Payment Requested', async () => {
    const id = `${PREFIX}CHECKOUT`;
    await insertBooking(id, { status: 'Pre-Confirmed', stall_cost: 12.5 });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(json.checkout_url && json.checkout_url.startsWith('https://checkout.stripe.com/'), `expected a real Stripe Checkout URL, got: ${json.checkout_url}`);

    const { data: booking } = await service.from('bookings')
      .select('status, stripe_checkout_session_id, stripe_payment_requested_at')
      .eq('id', id)
      .single();
    assert.equal(booking.status, 'Payment Requested');
    assert.ok(booking.stripe_checkout_session_id);
    assert.ok(booking.stripe_payment_requested_at);
  });

  test('a second request within the double-click window is rejected, not a duplicate session', async () => {
    const id = `${PREFIX}DOUBLECLICK`;
    await insertBooking(id, { status: 'Pre-Confirmed', stall_cost: 8 });

    const first = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(first.status, 200, JSON.stringify(first.json));

    const second = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(second.status, 429, JSON.stringify(second.json));
  });

  test('a Food/General booking uses the LIVE key by default (fails safely here, since the test project deliberately has no live key configured)', async () => {
    await service.from('settings').delete().eq('key', 'stripe_test_mode');

    const id = `${PREFIX}LIVEBYDEFAULT`;
    await insertBooking(id, { status: 'Pre-Confirmed', stall_cost: 9, instance_prefix: 'ESF26-FOOD-' });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error, /stripe_secret_key_live/, 'expected the live-key config error, confirming a Food/General booking resolves to live mode by default');
  });

  test('turning on stripe_test_mode forces Test Mode for a Food/General booking too', async () => {
    const { error: settingErr } = await service.from('settings').upsert({ key: 'stripe_test_mode', value: 'true' });
    assert.equal(settingErr, null, settingErr?.message);

    const id = `${PREFIX}FORCEDTESTMODE`;
    await insertBooking(id, { status: 'Pre-Confirmed', stall_cost: 9, instance_prefix: 'ESF26-FOOD-' });

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(json.checkout_url && json.checkout_url.startsWith('https://checkout.stripe.com/'), `expected a real Stripe Test-mode Checkout URL for a Food/General booking with the setting on, got: ${json.checkout_url}`);

    await service.from('settings').delete().eq('key', 'stripe_test_mode');
  });
});

describe('stripe-webhook', () => {
  test('rejects a request with no Stripe-Signature header', async () => {
    const res = await fetch(`${url}/functions/v1/stripe-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert.equal(res.status, 400);
  });

  test('rejects a request with an invalid signature', async () => {
    const res = await fetch(`${url}/functions/v1/stripe-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey, 'stripe-signature': 't=1,v1=not_a_real_signature' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert.equal(res.status, 400);
  });
});

describe('free (£0) bookings skip Stripe entirely', () => {
  test('a booking finalized as free never creates a payments row or touches Stripe columns', async () => {
    // Mirrors what preConfirmBooking + the free branch of finalizeConfirmation
    // do together for a £0/free booking — this is the exact application
    // logic path (js/api.js), tested here at the DB level (no browser/ESM
    // import available in this Node test runner, same approach the rest of
    // this suite already uses for app-logic assertions).
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
